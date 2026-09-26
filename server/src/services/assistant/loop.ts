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
import { coveredCitiesSentence, providerForCity } from "../../providers/registry.js";
import { nycStartOfDay } from "../hours.js";
import { homeMetroForPoint } from "./geocoder.js";
import type { AssistantPlanBody } from "./plans.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import type { StreetOption } from "./streetOptions.js";
import type { AssistantTools, StreetQuote, Suggestion, ToolContext } from "./tools.js";

/** Overridden by ASSISTANT_MODEL (legacy fallback: ANTHROPIC_MODEL). */
export const DEFAULT_ASSISTANT_MODEL = "claude-sonnet-5";
/** The cheap model that phrases explain_decision output (EXPLAIN_MODEL). */
export const DEFAULT_EXPLAIN_MODEL = "claude-haiku-4-5-20251001";
const MAX_LOOP_ITERATIONS = 8;
const MAX_STORED_TURNS = 20;
const MAX_TOKENS = 1024;

export const SYSTEM_PROMPT = `You are ParkAgent's parking assistant. You do exactly two jobs: find the user one parking spot, or plan the parking for a multi-stop day. Nothing else — for any other topic, reply with one short, friendly sentence that you only help with parking.

ParkAgent pays meters in ${coveredCitiesSentence()}. The phone location line on a message names the covered city the phone is in or near — that is the user's city unless they name another, so never ask which city then. Without that line, don't assume a city. A place outside the covered cities is one we can't help with yet.

Style: terse. One or two sentences between tool calls, no filler, and never repeat a sentence you already said this turn. Use dollars with two decimals.

Rules you cannot break (the tools enforce them too):
- You never book, pay, or spend. Whenever you have quoted a price — street or garage — you MUST present it by calling propose_plan; never leave a quote in prose. The user acts by TAPPING a card, never by saying or typing "confirm" — never invite a verbal confirmation, and if someone types "confirm", point them at the card.
- How the tap works, so you phrase cards correctly: a garage option and a street option for RIGHT NOW get a Confirm button. A street option for a FUTURE time gets no button at all — set startsAt on the option and the card says "We'll pay automatically when you park here" (the detector pays at the curb) — that line is the card's own, so keep it out of the option's detail, which describes the spot. Don't promise to start future meters now; meters run from the moment they're paid.
- book_garage and start_session work only with a confirmation_token from a card tap. You normally never have one; if a call is refused, propose a plan instead.
- Quote street prices with quote_street and garages with search_garages — never invent a price, address, or availability.
- quote_street searches every metered block within a walk of the point and says what each is doing during the stay ("Free after 6 PM on Seaport Blvd — 4 min walk", "Metered until 8 PM, then free", "$3.75/hr, 2 hr max"). Offer the best street option (or two) using its summary. Say there's no street parking ONLY when quote_street returns found:false, and then say the radius it searched.
- When the user names a PLACE rather than "here" — a restaurant, bar, venue, business, hotel, landmark, street, or neighborhood — call geocode_place FIRST with their words (keep the area they named: "Lola 42 Seaport"), then quote_street / search_garages at the place's coordinates — never silently use the phone's location for a named place. For garages at a named place, pass within_m: 600 so every option is walkable from it. When you geocoded a place, put it on the plan as destination {lat, lng, label} so the card can show it on a map. If geocode_place returns choices, ask which one with ask_user. If its match is "closest", the name wasn't found: say so and say what you're searching instead. If it finds nothing, say you couldn't find it and ask for the address — never substitute the current location or a neighborhood center.
- To ask the user anything, call ask_user (one short question, 2–4 tappable suggestions) — never ask in prose. Ask only when you truly can't proceed.
- If search_garages returns garage_search_unavailable, the search FAILED — say "I couldn't check garages right now", never "no garages available", and still propose the street option. Only an empty options list means none were found. If every garage was dropped for distance, the result's nearestBeyondM says how far the closest one is — tell the user that distance ("the nearest garage is about 900 m away") rather than "none found".
- A follow-up message edits the CURRENT plan: "cheaper?", "closer", "make it 5 instead", "add a stop at 3" refer to what you just proposed. Re-run only the tools whose inputs changed and propose the revised plan. Ask a clarifying question only when you truly cannot proceed; otherwise assume the sensible reading and say what you assumed in a few words.
- An itinerary's total must fit the user's remaining daily budget (build_itinerary shows it). If it doesn't fit, say what to cut.
- Garage checkout is a deep link to the site the option came from (each search_garages option names its provider — SpotHero or ParkWhiz): the user finishes the purchase there and the pass lives in that site's account. Say so when it matters, in a few words, naming the right site.
- Every user message ends with the CURRENT date and time in brackets. Compute every date from it — "tonight", "tomorrow", "at 2pm" are relative to that timestamp. NEVER guess or recall a date; a window in the past is always a mistake, and the tools will bounce it back to you with the current time so you can retry.`;

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
  { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ModelTurn {
  role: "user" | "assistant";
  content:
    string | (ModelContentBlock | { type: "tool_result"; tool_use_id: string; content: string })[];
}

export interface ModelResponse {
  content: ModelContentBlock[];
  stopReason: string;
  /** Which model actually answered and what it billed — logged per turn
   * on the assistant_turn decision row. Fakes may omit it. */
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Which model runs where. The loop takes ASSISTANT_MODEL, falling back to
 * the legacy ANTHROPIC_MODEL, then claude-sonnet-5; explanations always
 * run on the cheap EXPLAIN_MODEL.
 */
export function resolveAssistantModels(env: {
  ASSISTANT_MODEL?: string | undefined;
  ANTHROPIC_MODEL?: string | undefined;
  EXPLAIN_MODEL?: string | undefined;
}): { assistant: string; explain: string } {
  return {
    assistant: env.ASSISTANT_MODEL ?? env.ANTHROPIC_MODEL ?? DEFAULT_ASSISTANT_MODEL,
    explain: env.EXPLAIN_MODEL ?? DEFAULT_EXPLAIN_MODEL,
  };
}

/** One model call's bill — what the turn's accounting row sums. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Anthropic list prices per million tokens (checked 2026-09-24), most
 * specific first: a generation can reprice a family (Sonnet 5 is $2/$10,
 * Sonnet 4.x $3/$15). Unknown models estimate at the priciest tier so the
 * cap errs toward refusing. */
const MODEL_PRICES_PER_MTOK: { match: RegExp; inputUsd: number; outputUsd: number }[] = [
  { match: /haiku/, inputUsd: 1, outputUsd: 5 },
  { match: /sonnet-5/, inputUsd: 2, outputUsd: 10 },
  { match: /sonnet/, inputUsd: 3, outputUsd: 15 },
  { match: /opus-5-5/, inputUsd: 4, outputUsd: 20 },
  { match: /opus/, inputUsd: 5, outputUsd: 25 },
  { match: /fable|mythos/, inputUsd: 10, outputUsd: 50 },
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES_PER_MTOK.find((p) => p.match.test(model)) ?? {
    inputUsd: 10,
    outputUsd: 50,
  };
  const usd = (inputTokens * price.inputUsd + outputTokens * price.outputUsd) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

/** Today's (ET) estimated assistant model spend for one user, from the
 * assistant_turn decision rows — what the daily cap compares against. */
export async function assistantSpendTodayUsd(db: AppDb, userId: string, at: Date): Promise<number> {
  const rows = await db.decision.findMany({
    // Midnight ET, the same day boundary the parking caps use.
    where: { userId, kind: "assistant_turn", createdAt: { gte: nycStartOfDay(at) } },
  });
  return rows
    .filter((r) => r.kind === "assistant_turn" && r.userId === userId)
    .reduce((sum, r) => {
      const outcome = r.outcome as { estimatedCostUsd?: number } | null;
      return sum + (typeof outcome?.estimatedCostUsd === "number" ? outcome.estimatedCostUsd : 0);
    }, 0);
}

/** The transport seam: the real one wraps @anthropic-ai/sdk streaming;
 * tests inject a scripted fake. onText receives streamed text deltas. */
export interface ModelClient {
  create(
    args: {
      system: string;
      messages: ModelTurn[];
      /** Omitted for plain phrasing calls (explain_decision). */
      tools?: typeof TOOL_DEFINITIONS;
      maxTokens: number;
    },
    onText?: (delta: string) => void,
  ): Promise<ModelResponse>;
}

export interface AssistantResult {
  conversationId: string;
  reply: string;
  plan: { planId: string; plan: AssistantPlanBody } | null;
  /** Tappable answers to the question the reply asks (ask_user, or the
   * ambiguous-place choices when the model asked in prose); null when the
   * reply asks nothing. */
  suggestions: Suggestion[] | null;
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
  /** Fired the moment propose_plan lands, before the reply is final — the
   * SSE route forwards it as its own event so the card renders early. */
  onPlan?: ((plan: { planId: string; plan: AssistantPlanBody }) => void) | undefined;
  now?: (() => Date) | undefined;
}

/** Eastern time, both cities: the bracket every user message carries so
 * the model never has to guess what "tonight" means. */
export function currentTimeLine(at: Date): string {
  const eastern = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => eastern.find((p) => p.type === type)?.value ?? "";
  return `[current time: ${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ET]`;
}

/** What this turn's quoting tools produced — the raw material for a
 * synthesized plan when the model won't call propose_plan itself. */
interface QuoteContext {
  street: {
    zoneId: string;
    zoneNumber: string | null;
    street: string | null;
    summary: string | null;
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
  const scrubbed = reply
    .replace(VERBAL_CONFIRM_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const pointer = hasPlan ? "Tap Confirm on a card to go ahead." : "";
  return [scrubbed, pointer]
    .filter((s) => s.length > 0)
    .join(" ")
    .trim();
}

export async function runAssistantTurn(args: RunArgs): Promise<AssistantResult> {
  const stored = await args.db.conversation.findUnique({ where: { id: args.conversationId } });
  const history: ModelTurn[] =
    stored && stored.userId === args.userId ? (stored.turns as ModelTurn[]) : [];

  const at = args.now?.() ?? new Date();
  const envelope = [
    args.location ? phoneLocationLine(args.location) : null,
    // The prod bug this cures: without a clock, "tonight" became a
    // hallucinated 2024 date and SpotHero 400ed the past window.
    currentTimeLine(at),
  ].filter((line): line is string => line !== null);
  const userText = `${args.text}\n\n${envelope.join("\n")}`;
  const messages: ModelTurn[] = [...history, { role: "user", content: userText }];

  // Calls a tool makes on its own model (explain_decision's phrasing) —
  // billed on this turn's accounting row with the loop's own.
  const sideCalls: ModelUsage[] = [];
  const ctx: ToolContext = {
    userId: args.userId,
    conversationId: args.conversationId,
    location: args.location,
    // Earlier turns' grounding counts: "go ahead and propose" after a
    // clarifying question proposes what the previous turn quoted, and a
    // "make it 5 instead" plan keeps the place it was about.
    ...groundingIn(history),
    onModelUsage: (usage) => sideCalls.push(usage),
  };

  const segments: string[] = [];
  let plan: AssistantResult["plan"] = null;
  let asked: { question: string; suggestions: Suggestion[] } | null = null;
  const quotes: QuoteContext = { street: null, garages: [], minutes: null };
  let reminded = false;
  // Per-turn accounting, logged on the assistant_turn decision row.
  const startedMs = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let modelId = "unknown";
  let modelCalls = 0;

  // The accounting row is written in the `finally` below: a turn that
  // dies mid-flight (provider error, timeout) has still SPENT the tokens
  // it spent, and those must count against the daily cap rather than
  // escaping it.
  try {
    for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration += 1) {
      const response = await args.model.create(
        { system: SYSTEM_PROMPT, messages, tools: TOOL_DEFINITIONS, maxTokens: MAX_TOKENS },
        args.onText,
      );
      modelCalls += 1;
      if (response.model) modelId = response.model;
      inputTokens += response.usage?.inputTokens ?? 0;
      outputTokens += response.usage?.outputTokens ?? 0;
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
        if (outcome.ask) asked = outcome.ask;
      }
      messages.push({ role: "user", content: results });
      // propose_plan ends the turn: the card carries the plan; anything
      // more the model wanted to say waits for the user's next message.
      // ask_user ends it the same way — the question waits for a tap.
      if (plan || asked) break;
    }

    // The model was reminded and still didn't propose: build the plan from
    // its own quotes, through the same validated/audited tool.
    if (plan === null && asked === null && (quotes.street !== null || quotes.garages.length > 0)) {
      const synthesized = synthesizePlan(quotes);
      if (synthesized) {
        const outcome = await args.tools.execute(ctx, "propose_plan", { plan: synthesized });
        if (outcome.endTurn) plan = outcome.endTurn;
      }
    }
    if (plan) args.onPlan?.(plan);
  } finally {
    // What this turn cost and how long it took, on the record next to the
    // tool calls it drove. The daily spend cap reads these rows back, so
    // every paid call counts — the loop's and any a tool made itself.
    const estimatedCostUsd =
      Math.round(
        (estimateCostUsd(modelId, inputTokens, outputTokens) +
          sideCalls.reduce(
            (sum, c) => sum + estimateCostUsd(c.model, c.inputTokens, c.outputTokens),
            0,
          )) *
          10_000,
      ) / 10_000;
    await args.db.decision.create({
      data: {
        kind: "assistant_turn",
        inputs: { conversationId: args.conversationId },
        rule: "turn_complete",
        outcome: {
          model: modelId,
          modelCalls,
          inputTokens,
          outputTokens,
          ...(sideCalls.length > 0 ? { otherModelCalls: sideCalls } : {}),
          latencyMs: Date.now() - startedMs,
          estimatedCostUsd,
          proposedPlan: plan !== null,
        },
        userId: args.userId,
      },
    });
  }

  // Models often propose with tool calls alone (Sonnet 5 did on every
  // live run): an empty reply left the card under a bare "…" bubble. An
  // ask_user question is part of the reply, said once.
  const said = scrubVerbalConfirm(
    joinReplySegments(asked ? [...segments, asked.question] : segments),
    plan !== null,
  );
  const reply =
    said.length > 0 || plan === null
      ? said
      : plan.plan.kind === "itinerary"
        ? "Here's a plan for your day — review it, then Sign off."
        : "Here are your options — tap one to go ahead.";

  const trimmed = messages.slice(-MAX_STORED_TURNS);
  await args.db.conversation.upsert({
    where: { id: args.conversationId },
    create: { id: args.conversationId, userId: args.userId, turns: trimmed },
    update: { turns: trimmed },
  });

  // The tappable answers: ask_user's own, else — when a place search this
  // turn came back ambiguous and the model asked in prose anyway — those
  // places, so the question is still one tap to answer.
  const suggestions =
    asked?.suggestions ??
    (plan === null && (ctx.placeChoices?.length ?? 0) >= 2 ? ctx.placeChoices! : null);

  return { conversationId: args.conversationId, reply, plan, suggestions };
}

/** "[phone location: 42.22060, -71.00410 — in or near Boston]" — the city
 * spelled out, so the model never has to ask which one: a phone just
 * outside the metro box (Braintree) is still in that city for a driver. */
export function phoneLocationLine(location: { lat: number; lng: number }): string {
  const coords = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
  const metro = homeMetroForPoint(location.lat, location.lng);
  const city = metro ? providerForCity(metro)?.cityDisplayName : undefined;
  return city
    ? `[phone location: ${coords} — in or near ${city}]`
    : `[phone location: ${coords} — outside the cities we cover]`;
}

/** What a stored transcript already grounded: every quote_street result
 * that found a zone (with the point it was asked about — the option's
 * pin), the latest geocode_place match, and the latest search_garages.
 * A result whose tool_use was trimmed away is skipped. Derived from the
 * transcript rather than held in memory, so it survives a restart and
 * holds across machines, and it is the conversation OWNER's by
 * construction (the loop only loads a transcript for its owner). */
export function groundingIn(
  turns: ModelTurn[],
): Pick<ToolContext, "streetQuotes" | "geocode" | "garageSearch"> {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const streetQuotes: StreetQuote[] = [];
  let geocode: ToolContext["geocode"];
  let garageSearch: ToolContext["garageSearch"];
  for (const turn of turns) {
    if (typeof turn.content === "string") continue;
    for (const block of turn.content) {
      if (block.type === "tool_use") {
        const input =
          typeof block.input === "object" && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {};
        calls.set(block.id, { name: block.name, input });
      }
      if (block.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(block.content) as Record<string, unknown>;
      } catch {
        continue; // Not JSON — nothing grounded.
      }
      if (call.name === "quote_street" && r["found"] === true && Array.isArray(r["options"])) {
        const window = r["window"] as { startsAt?: string } | undefined;
        const stay = call.input["duration_minutes"];
        for (const option of r["options"] as StreetOption[]) {
          if (typeof option.zoneId !== "string") continue;
          streetQuotes.push({
            zoneId: option.zoneId,
            costUsd: Number(option.costUsd ?? 0),
            lat: option.lat,
            lng: option.lng,
            option,
            ...(typeof window?.startsAt === "string" ? { startsAt: window.startsAt } : {}),
            ...(typeof stay === "number" ? { stayMinutes: stay } : {}),
          });
        }
      } else if (
        call.name === "quote_street" &&
        r["found"] === true &&
        typeof r["zoneId"] === "string"
      ) {
        // A quote stored before street search: one zone at the quoted point.
        const { lat, lng } = call.input;
        streetQuotes.push({
          zoneId: r["zoneId"],
          costUsd: Number(r["costUsd"] ?? 0),
          ...(typeof lat === "number" && typeof lng === "number" ? { lat, lng } : {}),
        });
      } else if (call.name === "geocode_place" && r["found"] === true && r["ambiguous"] !== true) {
        const top =
          (r["place"] as Record<string, unknown> | undefined) ??
          (r["results"] as Record<string, unknown>[] | undefined)?.[0];
        if (
          top &&
          typeof top["lat"] === "number" &&
          typeof top["lng"] === "number" &&
          typeof top["displayName"] === "string"
        ) {
          geocode = { lat: top["lat"], lng: top["lng"], label: top["displayName"] };
        }
      } else if (
        call.name === "search_garages" &&
        typeof r["provider"] === "string" &&
        typeof r["searchedAt"] === "string"
      ) {
        garageSearch = { provider: r["provider"], searchedAt: r["searchedAt"] };
      }
    }
  }
  return { streetQuotes, geocode, garageSearch };
}

/** The street quotes in a stored transcript (see groundingIn). */
export function streetQuotesIn(turns: ModelTurn[]): StreetQuote[] {
  return groundingIn(turns).streetQuotes ?? [];
}

function captureQuotes(quotes: QuoteContext, tool: string, input: unknown, result: unknown): void {
  const r = result as Record<string, unknown>;
  const args = input as Record<string, unknown>;
  const best = Array.isArray(r["options"]) ? (r["options"] as StreetOption[])[0] : undefined;
  if (tool === "quote_street" && r["found"] === true && best) {
    quotes.street = {
      zoneId: best.zoneId,
      zoneNumber: best.zoneNumber,
      street: best.street,
      summary: best.summary,
      costUsd: best.costUsd,
      minutes: best.clampedMinutes,
      startsAt: String(args["when"] ?? ""),
    };
    quotes.minutes = Number(args["duration_minutes"] ?? best.clampedMinutes);
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
      // The zone id is an internal slug ("bos-…") and never shown; a
      // block with no known number says so on the meter instead.
      label: quotes.street.street
        ? `Street — ${quotes.street.street}`
        : quotes.street.zoneNumber
          ? `Street — Zone ${quotes.street.zoneNumber}`
          : "Street — zone number on the meter",
      detail: quotes.street.summary ?? "Metered street parking",
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
