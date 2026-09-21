/**
 * The assistant's tool-use loop (Anthropic Messages API, manual loop —
 * we need propose_plan to hard-end the turn and a transport we can fake
 * byte-for-byte in tests). The model plans and phrases; tools.ts
 * enforces policy; this file only moves messages — and enforces one
 * conversational rule the prod test broke: a turn that quoted prices
 * MUST end in a plan card, never in prose inviting a verbal "confirm"
 * (chat text can't mint a confirmation token, so a verbal confirm is a
 * dead end that reads like authorization).
 */

import type { AppDb } from "../../db.js";
import type { AssistantPlanBody } from "./plans.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import type { AssistantTools, ToolContext } from "./tools.js";

/** Overridden by the ANTHROPIC_MODEL env var (see env.ts). */
export const DEFAULT_ASSISTANT_MODEL = "claude-haiku-4-5-20251001";
const MAX_LOOP_ITERATIONS = 8;
const MAX_STORED_TURNS = 20;
const MAX_TOKENS = 1024;

export const SYSTEM_PROMPT = `You are ParkAgent's parking assistant. You do exactly two jobs: find the user one parking spot, or plan the parking for a multi-stop day. Nothing else — for any other topic, reply with one short, friendly sentence that you only help with parking.

Style: terse. One or two sentences between tool calls, no filler, and never repeat a sentence you already said this turn. Use dollars with two decimals.

Rules you cannot break (the tools enforce them too):
- You never book, pay, or spend. Whenever you have quoted a price — street or garage — you MUST present it by calling propose_plan; never leave a quote in prose. The user acts by TAPPING a card, never by saying or typing "confirm" — never invite a verbal confirmation, and if someone types "confirm", point them at the card.
- How the tap works, so you phrase cards correctly: a garage option and a street option for RIGHT NOW get a Confirm button. A street option for a FUTURE time gets no button at all — set startsAt on the option and the card says "We'll pay automatically when you park here" (the detector pays at the curb). Don't promise to start future meters now; meters run from the moment they're paid.
- book_garage and start_session work only with a confirmation_token from a card tap. You normally never have one; if a call is refused, propose a plan instead.
- Quote street prices with quote_street and garages with search_garages — never invent a price, address, or availability.
- If search_garages returns garage_search_unavailable, the search FAILED — say "I couldn't check garages right now", never "no garages available", and still propose the street option. Only an empty options list means none were found.
- An itinerary's total must fit the user's remaining daily budget (build_itinerary shows it). If it doesn't fit, say what to cut.
- Garage checkout today is a SpotHero deep link: the user finishes the purchase in SpotHero and the pass lives there. Say so when it matters, in a few words.
- If the user's location or times are missing and needed, ask one short question instead of guessing.`;

/** The one-shot correction when a turn quoted prices but never proposed. */
const PROPOSE_PLAN_REMINDER =
  "[system reminder] You quoted prices but did not call propose_plan. Call propose_plan NOW with the " +
  "options you quoted (include startsAt on street options). Do not ask the user to say or type " +
  "anything — they act by tapping the card.";

/** Phrasing that invites a verbal confirm — scrubbed if it ever appears. */
const VERBAL_CONFIRM_PATTERN =
  /[^.!?]*(?:say|type|reply|tell me|text me|answer)[^.!?]{0,40}(?:['"“”]?confirm['"“”]?|yes)[^.!?]*[.!?]?/gi;

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

/** What this turn's quoting tools produced — the raw material for a
 * synthesized plan when the model won't call propose_plan itself. */
interface QuoteContext {
  street: {
    zoneId: string;
    zoneNumber: string | null;
    costUsd: number;
    minutes: number;
    startsAt: string;
  } | null;
  garages: {
    id: string;
    name: string;
    priceUsd: number;
    walkMinutes: number;
    entryType: string;
    deepLink: string;
  }[];
  minutes: number | null;
}

/**
 * Join per-iteration text segments, dropping repeats: models restate
 * their opener after tool results ("Let me check… Let me check… it's
 * $4.10"), and the user reads it twice. A later segment that repeats an
 * earlier one (whole or as its prefix) loses the repeated part.
 */
export function joinReplySegments(segments: string[]): string {
  const kept: string[] = [];
  for (const raw of segments) {
    let segment = raw.trim();
    if (segment.length === 0) continue;
    for (const prior of kept) {
      if (segment === prior) {
        segment = "";
        break;
      }
      if (segment.startsWith(prior)) {
        segment = segment.slice(prior.length).trimStart();
      }
    }
    if (segment.length > 0) kept.push(segment);
  }
  return kept.join(" ").trim();
}

/** Strip any sentence that invites a verbal confirm; the card is the
 * only way to authorize, and the reply must say so instead. */
export function scrubVerbalConfirm(reply: string, hasPlan: boolean): string {
  if (!VERBAL_CONFIRM_PATTERN.test(reply)) return reply;
  VERBAL_CONFIRM_PATTERN.lastIndex = 0;
  const scrubbed = reply.replace(VERBAL_CONFIRM_PATTERN, "").replace(/\s{2,}/g, " ").trim();
  const pointer = hasPlan ? "Tap Confirm on a card to go ahead." : "";
  return [scrubbed, pointer].filter((s) => s.length > 0).join(" ").trim();
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

  const segments: string[] = [];
  let plan: AssistantResult["plan"] = null;
  const quotes: QuoteContext = { street: null, garages: [], minutes: null };
  let reminded = false;

  for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration += 1) {
    const response = await args.model.create(
      { system: SYSTEM_PROMPT, messages, tools: TOOL_DEFINITIONS, maxTokens: MAX_TOKENS },
      args.onText,
    );
    for (const block of response.content) {
      if (block.type === "text") segments.push(block.text);
    }
    const toolUses = response.content.filter(
      (b): b is Extract<ModelContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason !== "tool_use" || toolUses.length === 0) {
      // The turn is ending in prose. If it quoted anything, that's the
      // prod bug: first re-prompt once, then synthesize the plan from
      // the tool results ourselves — a quote never stays un-actionable.
      const hasQuotes = quotes.street !== null || quotes.garages.length > 0;
      if (plan === null && hasQuotes && !reminded) {
        reminded = true;
        messages.push({ role: "user", content: PROPOSE_PLAN_REMINDER });
        continue;
      }
      break;
    }

    const results: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
    for (const use of toolUses) {
      const outcome = await args.tools.execute(ctx, use.name, use.input);
      captureQuotes(quotes, use.name, use.input, outcome.result);
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

  // The model was reminded and still didn't propose: build the plan from
  // its own quotes, through the same validated/audited tool.
  if (plan === null && (quotes.street !== null || quotes.garages.length > 0)) {
    const synthesized = synthesizePlan(quotes);
    if (synthesized) {
      const outcome = await args.tools.execute(ctx, "propose_plan", { plan: synthesized });
      if (outcome.endTurn) plan = outcome.endTurn;
    }
  }

  const reply = scrubVerbalConfirm(joinReplySegments(segments), plan !== null);

  const trimmed = messages.slice(-MAX_STORED_TURNS);
  await args.db.conversation.upsert({
    where: { id: args.conversationId },
    create: { id: args.conversationId, userId: args.userId, turns: trimmed },
    update: { turns: trimmed },
  });

  return { conversationId: args.conversationId, reply, plan };
}

function captureQuotes(quotes: QuoteContext, tool: string, input: unknown, result: unknown): void {
  const r = result as Record<string, unknown>;
  const args = input as Record<string, unknown>;
  if (tool === "quote_street" && r["found"] === true) {
    quotes.street = {
      zoneId: String(r["zoneId"]),
      zoneNumber: typeof r["zoneNumber"] === "string" ? r["zoneNumber"] : null,
      costUsd: Number(r["costUsd"] ?? 0),
      minutes: Number(r["clampedMinutes"] ?? args["duration_minutes"] ?? 60),
      startsAt: String(args["when"] ?? ""),
    };
    quotes.minutes = quotes.street.minutes;
  }
  if (tool === "search_garages" && Array.isArray(r["options"])) {
    quotes.garages = (r["options"] as Record<string, unknown>[]).slice(0, 2).map((o) => ({
      id: String(o["id"]),
      name: String(o["name"] ?? "Garage"),
      priceUsd: Number(o["priceUsd"] ?? 0),
      walkMinutes: Number(o["walkMinutes"] ?? 0),
      entryType: String(o["entryType"] ?? "unknown"),
      deepLink: String(o["deepLink"] ?? ""),
    }));
  }
}

/** A single_spot plan straight from the quotes; cheapest option gets the
 * badge. Only the single-spot job is synthesized — a malformed itinerary
 * is worse than a follow-up question. */
function synthesizePlan(quotes: QuoteContext): Record<string, unknown> | null {
  const options: Record<string, unknown>[] = [];
  const minutes = quotes.minutes ?? 60;
  if (quotes.street) {
    options.push({
      id: "street-1",
      type: "street",
      label: quotes.street.zoneNumber
        ? `Street — Zone ${quotes.street.zoneNumber}`
        : `Street — ${quotes.street.zoneId}`,
      detail: "Metered street parking",
      priceUsd: quotes.street.costUsd,
      durationMinutes: quotes.street.minutes,
      zoneId: quotes.street.zoneId,
      ...(quotes.street.startsAt ? { startsAt: quotes.street.startsAt } : {}),
      recommended: false,
    });
  }
  for (const garage of quotes.garages) {
    options.push({
      id: `garage-${garage.id}`,
      type: "garage",
      label: garage.name,
      detail: "Off-street garage",
      priceUsd: garage.priceUsd,
      durationMinutes: minutes,
      walkMinutes: garage.walkMinutes,
      entryType: garage.entryType,
      garageOptionId: garage.id,
      ...(garage.deepLink ? { deepLink: garage.deepLink } : {}),
      recommended: false,
    });
  }
  if (options.length === 0) return null;
  let cheapest = 0;
  options.forEach((option, index) => {
    if ((option["priceUsd"] as number) < (options[cheapest]!["priceUsd"] as number)) {
      cheapest = index;
    }
  });
  options[cheapest]!["recommended"] = true;
  return { kind: "single_spot", options: options.slice(0, 3) };
}
