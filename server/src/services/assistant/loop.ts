/**
 * The assistant's tool-use loop (Anthropic Messages API, manual loop —
 * we need propose_plan to hard-end the turn and a transport we can fake
 * byte-for-byte in tests). The model plans and phrases; tools.ts
 * enforces policy; this file only moves messages.
 */

import type { AppDb } from "../../db.js";
import type { AssistantPlanBody } from "./plans.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import type { AssistantTools, ToolContext } from "./tools.js";

export const ASSISTANT_MODEL = "claude-sonnet-4-6";
const MAX_LOOP_ITERATIONS = 8;
const MAX_STORED_TURNS = 20;
const MAX_TOKENS = 1024;

export const SYSTEM_PROMPT = `You are ParkAgent's parking assistant. You do exactly two jobs: find the user one parking spot, or plan the parking for a multi-stop day. Nothing else — for any other topic, reply with one short, friendly sentence that you only help with parking.

Style: terse. One or two sentences between tool calls, no filler, no repetition of what a card already shows. Use dollars with two decimals.

Rules you cannot break (the tools enforce them too):
- You never book, pay, or spend. To get anything paid for, call propose_plan and stop — the user's Confirm tap is the only authorization, and it happens outside this conversation.
- book_garage and start_session work only with a confirmation_token from that tap. You normally never have one; if a call is refused, propose a plan instead.
- Quote street prices with quote_street and garages with search_garages — never invent a price, address, or availability.
- An itinerary's total must fit the user's remaining daily budget (build_itinerary shows it). If it doesn't fit, say what to cut.
- Garage checkout today is a SpotHero deep link: the user finishes the purchase in SpotHero and the pass lives there. Say so when it matters, in a few words.
- If the user's location or times are missing and needed, ask one short question instead of guessing.`;

/** One content block of an assistant message, Messages-API shaped. */
export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ModelTurn {
  role: "user" | "assistant";
  content:
    | string
    | (
        | ModelContentBlock
        | { type: "tool_result"; tool_use_id: string; content: string }
      )[];
}

export interface ModelResponse {
  content: ModelContentBlock[];
  stopReason: string;
}

/** The transport seam: the real one wraps @anthropic-ai/sdk streaming;
 * tests inject a scripted fake. onText receives streamed text deltas. */
export interface ModelClient {
  create(
    args: { system: string; messages: ModelTurn[]; tools: typeof TOOL_DEFINITIONS; maxTokens: number },
    onText?: (delta: string) => void,
  ): Promise<ModelResponse>;
}

export interface AssistantResult {
  conversationId: string;
  reply: string;
  plan: { planId: string; plan: AssistantPlanBody } | null;
}

export interface RunArgs {
  db: AppDb;
  model: ModelClient;
  tools: AssistantTools;
  userId: string;
  conversationId: string;
  text: string;
  location?: { lat: number; lng: number } | undefined;
  onText?: ((delta: string) => void) | undefined;
}

export async function runAssistantTurn(args: RunArgs): Promise<AssistantResult> {
  const stored = await args.db.conversation.findUnique({ where: { id: args.conversationId } });
  const history: ModelTurn[] =
    stored && stored.userId === args.userId ? (stored.turns as ModelTurn[]) : [];

  const userText = args.location
    ? `${args.text}\n\n[phone location: ${args.location.lat.toFixed(5)}, ${args.location.lng.toFixed(5)}]`
    : args.text;
  const messages: ModelTurn[] = [...history, { role: "user", content: userText }];

  const ctx: ToolContext = {
    userId: args.userId,
    conversationId: args.conversationId,
    location: args.location,
  };

  let replyText = "";
  let plan: AssistantResult["plan"] = null;

  for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration += 1) {
    const response = await args.model.create(
      { system: SYSTEM_PROMPT, messages, tools: TOOL_DEFINITIONS, maxTokens: MAX_TOKENS },
      args.onText,
    );
    for (const block of response.content) {
      if (block.type === "text") replyText += block.text;
    }
    const toolUses = response.content.filter(
      (b): b is Extract<ModelContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (response.stopReason !== "tool_use" || toolUses.length === 0) {
      messages.push({ role: "assistant", content: response.content });
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
    for (const use of toolUses) {
      const outcome = await args.tools.execute(ctx, use.name, use.input);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(outcome.result),
      });
      if (outcome.endTurn) plan = outcome.endTurn;
    }
    messages.push({ role: "user", content: results });
    // propose_plan ends the turn: the card carries the plan; anything
    // more the model wanted to say waits for the user's next message.
    if (plan) break;
  }

  const trimmed = messages.slice(-MAX_STORED_TURNS);
  await args.db.conversation.upsert({
    where: { id: args.conversationId },
    create: { id: args.conversationId, userId: args.userId, turns: trimmed },
    update: { turns: trimmed },
  });

  return { conversationId: args.conversationId, reply: replyText.trim(), plan };
}
