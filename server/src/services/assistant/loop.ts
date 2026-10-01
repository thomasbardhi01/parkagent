/**
 * The assistant's tool-use loop (Anthropic Messages API, manual loop —
 * we need propose_plan to hard-end the turn and a transport we can fake
 * byte-for-byte in tests). The model plans and phrases; tools.ts
 * enforces policy; this file only moves messages — and holds the turn to
 * three conversational rules:
 *
 *  - a turn that searched owes the user a card, never a price in prose
 *    inviting a verbal "confirm" (chat text can't mint a confirmation
 *    token, so a verbal confirm is a dead end that reads like
 *    authorization). The model is reminded once. The loop never builds a
 *    plan the model didn't propose (FR-43): the one card it issues itself
 *    is the "no", when the latest search found nothing that meets the
 *    request — and that card is the server's verdict, through the same
 *    validated tool;
 *  - a "no" is said in the server's words: the reply on a none_meets or
 *    no_data card is the card's own headline;
 *  - every dollar amount in any other reply must be one the server stands
 *    behind — a price on the card, or a number a tool reported this
 *    conversation. A sentence carrying any other amount is dropped.
 */

import type { AppDb } from "../../db.js";
import { coveredCitiesSentence, providerForCity } from "../../providers/registry.js";
import { nycStartOfDay } from "../hours.js";
import { homeMetroForPoint } from "./geocoder.js";
import { suggestionsForQuestion } from "./clarify.js";
import {
  appendDisplay,
  displayFromTurns,
  titleFrom,
  titleFromTurns,
  trimTurns,
} from "./history.js";
import { suggestionsForPlan } from "./plans.js";
import type { AssistantPlanBody } from "./plans.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import type { Ask, AssistantTools, Suggestion, ToolContext } from "./tools.js";
import { requestedTimeChoices, requestedTimeIn, requestedTimeLine } from "./requestedTime.js";
import {
  currentRequestBlock,
  emptyState,
  parseStoredState,
  resolveTappedCandidate,
} from "./requestState.js";
import type { RequestState } from "./requestState.js";
import { lastSearchIn } from "./search.js";

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
- You never book, pay, or spend. Whenever you have searched — street or garage — you MUST end the turn by calling propose_plan; never leave a price in prose. The user acts by TAPPING a card, never by saying or typing "confirm" — never invite a verbal confirmation, and if someone types "confirm", point them at the card.
- How the tap works, so you phrase cards correctly: a garage option and a street option for RIGHT NOW get a Confirm button. A street option for a FUTURE time gets no button at all — the card says "We'll pay automatically when you park here" (the detector pays at the curb) — that line is the card's own, so keep it out of the option's detail, which describes the spot. Don't promise to start future meters now; meters run from the moment they're paid.
- book_garage and start_session work only with a confirmation_token from a card tap. You normally never have one; if a call is refused, propose a plan instead.
- The request is the server's — the "Current request" below. quote_street and search_garages take NO arguments: they search the request as it stands (its place, time, stay, limits, and ranking). To search another place, time, stay, or budget, change the request first, then search. Never invent a price, address, or availability.
- Each search answers with \`satisfying\` (the options that meet every limit, already ranked — never reorder them), \`nearMisses\` (options that break a limit; \`violates\` says which and by how much), and a \`verdict\`. propose_plan takes options BY ID, exactly as the latest search returned them; the server attaches each option's price, walk, time, and link. After any change to the request, search again before proposing: ids from an earlier search are refused.
- When nothing meets the request (verdict none_meets), say so: call propose_plan with {kind: "none_meets"}. Never present a near-miss as if it met the request, and never loosen a limit yourself — the card gives the user one-tap ways to relax it.
- quote_street searches every metered block within a walk of the place and says what each is doing during the stay ("Free after 6 PM on Seaport Blvd — 4 min walk", "Metered until 8 PM, then free", "$3.75/hr, 2 hr max"). Say there's no street parking ONLY when the search says our data has none within its radius, and then say the radius.
- When the user names a PLACE rather than "here" — a restaurant, bar, venue, business, hotel, landmark, street, or neighborhood — call geocode_place FIRST with their words (keep the area they named: "Lola 42 Seaport"). It makes that the request's place, and the searches then search THERE — never the phone's location for a named place. If geocode_place returns choices, ask which one with ask_user. If its match is "closest", the name wasn't found: say so and say what you're searching instead. If it finds nothing, say you couldn't find it and ask for the address — never substitute the current location or a neighborhood center.
- To ask the user anything, call ask_user (one short question, 2–4 tappable suggestions) — never ask in prose. Ask only when you truly can't proceed: when the user gave no time, assume now; no duration, 2 hours — instead of asking. When you do ask, offer the common answers ("1 hour", "2 hours", "3 hours"; "Now", "Tonight at 7").
- Always state your assumptions in one short line when you propose — the window and the place, e.g. "7:00–10:00 PM, near Lola 42, Seaport". The card shows the same line.
- If a search says the garage search is unavailable, the search FAILED — say "I couldn't check garages right now", never "no garages available", and still propose the street options. Only a search that found none means none were found. If every garage was dropped for distance, the result says how far the closest one is — tell the user that distance ("the nearest garage is about 900 m away") rather than "none found".
- When the user changes anything about the request, call update_request with only what changed before searching.
- A follow-up message edits the CURRENT plan: "cheaper?", "closer", "make it 5 instead", "add a stop at 3" refer to what you just proposed. Put the change on the request, search again, and propose the revised plan. Ask a clarifying question only when you truly cannot proceed; otherwise assume the sensible reading and say what you assumed in a few words.
- An itinerary's total must fit the user's remaining daily budget (build_itinerary shows it). If it doesn't fit, say what to cut.
- Garage checkout is a deep link to the site the option came from (each garage option names its provider — SpotHero or ParkWhiz): the user finishes the purchase there and the pass lives in that site's account. Say so when it matters, in a few words, naming the right site.
- A clock time the user names is theirs: put it on the request (update_request startsAt) and never move it to now or to any other time. When they name one with no day, their message carries a [requested time] line saying whether it is later today or has already passed; a time that has passed means its next occurrence — plan for that (the card says "Assuming tomorrow") or ask with ask_user ("Tomorrow at 7 PM" / "Now"). "Tonight" asked after midnight means this coming evening. The tools refuse a search or plan that moves a requested time.
- Every user message ends with the CURRENT date and time in brackets. Compute every date from it — "tonight", "tomorrow", "at 2pm" are relative to that timestamp. NEVER guess or recall a date; a window in the past is always a mistake, and the tools will bounce it back to you with the current time so you can retry.`;

/** What each model call is told: the fixed prompt, then the request as it
 * stands at that call (requestState.ts) — re-rendered after an
 * update_request, so the block is never behind the state. */
export function systemPromptFor(state: RequestState): string {
  return `${SYSTEM_PROMPT}\n\n${currentRequestBlock(state)}`;
}

/** The one-shot correction when a turn searched but never proposed. */
const PROPOSE_PLAN_REMINDER =
  "[system reminder] You searched but did not call propose_plan. Call propose_plan NOW: a single_spot " +
  'plan of option ids from the latest search, or {kind: "none_meets"} if nothing met the request. Do not ' +
  "ask the user to say or type anything — they act by tapping the card.";

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

/** A dollar amount in prose: "$4.50", "$20", "$1,000.00". */
const AMOUNT_PATTERN = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

/** A reply cut into sentences, each keeping its own spacing. A sentence
 * ends at . ! or ? followed by whitespace (so "$4.50" is not two), or at
 * a line break. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    const ends =
      ch === "\n" ||
      ((ch === "." || ch === "!" || ch === "?") && (next === undefined || /\s/.test(next)));
    if (ends) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * V6 (FR-43): drop every sentence that states a dollar amount the server
 * doesn't stand behind. `groundedCents` holds the amounts it does, in
 * cents — "$20" and "$20.00" are the same amount. Returns the reply and
 * the amounts dropped (dollars, in order, each once). A reply with nothing
 * to drop comes back untouched.
 */
export function scrubUngroundedAmounts(
  reply: string,
  groundedCents: ReadonlySet<number>,
): { text: string; dropped: number[] } {
  const dropped: number[] = [];
  const kept = sentencesOf(reply).filter((sentence) => {
    const ungrounded = [...sentence.matchAll(AMOUNT_PATTERN)]
      .map((m) =>
        Math.round(Number(`${m[1]!.replace(/,/g, "")}.${(m[2] ?? "").padEnd(2, "0")}`) * 100),
      )
      .filter((cents) => !groundedCents.has(cents));
    for (const cents of ungrounded) {
      if (!dropped.includes(cents / 100)) dropped.push(cents / 100);
    }
    return ungrounded.length === 0;
  });
  if (dropped.length === 0) return { text: reply, dropped };
  return {
    text: kept
      .join("")
      .replace(/\s{2,}/g, " ")
      .trim(),
    dropped,
  };
}

/** The tools whose results are the server's own numbers a reply may say:
 * the request, a day's quotes and budget, past sessions, an explanation.
 * A search's prices are not here — those are sayable only next to the
 * card that carries them (groundedCents). */
const AMOUNT_TOOLS = new Set([
  "update_request",
  "build_itinerary",
  "get_history",
  "explain_decision",
  "book_garage",
  "start_session",
]);
const MONEY_KEY = /usd|price|cost|cap|budget|total|amount|fee|rate/i;

/** Every dollar amount in a tool result, in cents: numbers under a
 * money-named key, and "$…" written out in its strings. */
function amountsIn(value: unknown, into: Set<number>, key = ""): void {
  if (typeof value === "number") {
    if (Number.isFinite(value) && MONEY_KEY.test(key)) into.add(Math.round(value * 100));
    return;
  }
  if (typeof value === "string") {
    for (const m of value.matchAll(AMOUNT_PATTERN)) {
      into.add(
        Math.round(Number(`${m[1]!.replace(/,/g, "")}.${(m[2] ?? "").padEnd(2, "0")}`) * 100),
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) amountsIn(item, into, key);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) amountsIn(v, into, k);
  }
}

/** Whether a tool's result holds amounts a reply may state on their own. */
function reportsAmounts(tool: string, result: unknown): boolean {
  if (AMOUNT_TOOLS.has(tool)) return true;
  // A day refused for the cap comes back with the totals to explain it.
  return (
    tool === "propose_plan" && (result as { error?: unknown })?.error === "plan_over_daily_cap"
  );
}

/** The amounts earlier turns' tools reported, read back from the stored
 * transcript: "what did that come to again?" is answerable next turn. */
function amountsReported(turns: readonly ModelTurn[]): Set<number> {
  const tools = new Map<string, string>();
  const into = new Set<number>();
  for (const turn of turns) {
    if (typeof turn.content === "string") continue;
    for (const block of turn.content) {
      if (block.type === "tool_use") tools.set(block.id, block.name);
      if (block.type !== "tool_result") continue;
      const tool = tools.get(block.tool_use_id);
      if (!tool) continue;
      try {
        const result: unknown = JSON.parse(block.content);
        if (reportsAmounts(tool, result)) amountsIn(result, into);
      } catch {
        // Not JSON: nothing reported.
      }
    }
  }
  return into;
}

/**
 * The amounts this turn's reply may state, in cents:
 *  - the request's own budget, and what relaxing it a step would make it;
 *  - what the other tools reported (`reported`);
 *  - a search's prices only where a card stands behind them: the prices
 *    on this turn's card, plus the latest search's satisfying options —
 *    unless this turn searched and ended with no card (a quote in prose).
 * A near-miss's price is never here: the card says it, with what it
 * breaks, and prose can't restate it as a fit.
 */
function groundedCents(
  ctx: ToolContext,
  plan: AssistantResult["plan"],
  reported: ReadonlySet<number>,
): Set<number> {
  const cents = new Set<number>(reported);
  const add = (usd: unknown) => {
    if (typeof usd === "number" && Number.isFinite(usd)) cents.add(Math.round(usd * 100));
  };
  add(ctx.requestState?.hard.maxPriceUsd);
  const last = ctx.lastSearch;
  for (const relax of last?.relaxSuggestions ?? []) {
    if (relax.field === "maxPriceUsd") add(relax.to);
  }
  const body = plan?.plan;
  if (body?.kind === "itinerary") {
    for (const stop of body.stops) add(stop.costUsd);
    add(body.totalUsd);
    add(body.capUsd);
  }
  if (body?.kind === "single_spot") {
    for (const option of body.options) {
      if (option.nearMiss) continue;
      add(option.priceUsd);
      add(option.priceBreakdown?.meterUsd);
      add(option.priceBreakdown?.feeUsd);
      add(option.ratePerHourUsd);
    }
  }
  const quotedWithoutCard = plan === null && (ctx.searchesThisTurn ?? 0) > 0;
  if (last && !quotedWithoutCard && body?.kind !== "itinerary") {
    for (const option of last.satisfying) {
      add(option.priceUsd);
      add(option.facts?.meterUsd);
      add(option.facts?.feeUsd);
      add(option.facts?.ratePerHourUsd);
    }
  }
  return cents;
}

/**
 * The text deltas a client sees while a turn runs, held to whole sentences
 * and gated: a sentence streams only while `open()` says so and only if it
 * states no dollar amount. Everything withheld still reaches the reply
 * check, and the final reply is what the client keeps.
 */
function amountFreeStream(
  onText: (delta: string) => void,
  open: () => boolean,
): { push: (delta: string) => void; flush: () => void } {
  let pending = "";
  const emit = (text: string) => {
    if (text.length > 0 && open() && !text.includes("$")) onText(text);
  };
  return {
    push(delta) {
      pending += delta;
      const whole = sentencesOf(pending);
      // The last piece may still be growing: keep it until it ends.
      const last = whole[whole.length - 1] ?? "";
      const ended = /[.!?\n]\s*$/.test(last) && /\s$/.test(pending);
      const ready = ended ? whole : whole.slice(0, -1);
      pending = ended ? "" : last;
      for (const sentence of ready) emit(sentence);
    },
    flush() {
      emit(pending);
      pending = "";
    },
  };
}

export async function runAssistantTurn(args: RunArgs): Promise<AssistantResult> {
  const stored = await args.db.conversation.findUnique({ where: { id: args.conversationId } });
  const history: ModelTurn[] =
    stored && stored.userId === args.userId ? (stored.turns as ModelTurn[]) : [];
  // The request this conversation has built so far, loaded before the
  // first model call; a new conversation (or a row from before request
  // state) starts from the empty request.
  const at = args.now?.() ?? new Date();
  // …and, when this message is a tap on one of the places the last turn
  // couldn't choose between, with that place already chosen: the choice is
  // the user's, so it is taken from the request, not left to the model.
  const requestState = resolveTappedCandidate(
    stored && stored.userId === args.userId ? parseStoredState(stored.requestState) : emptyState(),
    args.text,
    at,
  );

  // The clock time the message names, read here rather than left to the
  // model: a 7 PM that has passed today means tomorrow, never "now"
  // (requestedTime.ts). The tools hold the plan to it.
  const timeRequest = requestedTimeIn(args.text, at) ?? undefined;
  const envelope = [
    args.location ? phoneLocationLine(args.location) : null,
    // The prod bug this cures: without a clock, "tonight" became a
    // hallucinated 2024 date and SpotHero 400ed the past window.
    currentTimeLine(at),
    timeRequest ? requestedTimeLine(timeRequest, at) : null,
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
    // The latest search at the request's current version counts: "go
    // ahead and propose" after a clarifying question proposes what the
    // previous turn found. Read back from the stored transcript, so it
    // survives a restart and holds across machines (search.ts).
    lastSearch: lastSearchIn(history, requestState.version) ?? undefined,
    searchesThisTurn: 0,
    onModelUsage: (usage) => sideCalls.push(usage),
    timeRequest,
    requestState,
    requestEdits: 0,
    utterance: args.text,
  };

  // What streams to the user while the turn runs is provisional (the
  // `done` reply replaces it), but it is still seen: nothing with a dollar
  // amount in it streams, and nothing at all once this turn has searched —
  // what the model says about prices reaches the user only after the
  // reply check below.
  const stream = args.onText
    ? amountFreeStream(args.onText, () => (ctx.searchesThisTurn ?? 0) === 0)
    : null;
  const segments: string[] = [];
  let plan: AssistantResult["plan"] = null;
  let asked: Ask | null = null;
  let reminded = false;
  // The amounts tools other than the searches have reported, this turn
  // and before: what a reply may state without a card (V6).
  const reported = amountsReported(history);
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
        {
          system: systemPromptFor(ctx.requestState ?? requestState),
          messages,
          tools: TOOL_DEFINITIONS,
          maxTokens: MAX_TOKENS,
        },
        stream?.push,
      );
      stream?.flush();
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
        // The turn is ending in prose. If it searched, the user is owed a
        // card: re-prompt once, and only once.
        if (plan === null && (ctx.searchesThisTurn ?? 0) > 0 && !reminded) {
          reminded = true;
          messages.push({ role: "user", content: PROPOSE_PLAN_REMINDER });
          continue;
        }
        break;
      }

      const results: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
      for (const use of toolUses) {
        const outcome = await args.tools.execute(ctx, use.name, use.input);
        if (reportsAmounts(use.name, outcome.result)) amountsIn(outcome.result, reported);
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
      // ask_user ends it the same way — the question waits for a tap. So
      // does a search that can't tell where to look (it asks), and a
      // garage-only search whose source is down (it has its own card).
      if (plan || asked) break;
    }

    // The model searched, was reminded, and still proposed nothing. The
    // loop never builds a plan out of quotes (that fallback could
    // re-propose what the user had just ruled out). The one card it does
    // issue is the "no": when the latest search found nothing that meets
    // the request, saying so is the server's call — through the same
    // validated, audited tool, which first completes the search.
    if (plan === null && asked === null && (ctx.searchesThisTurn ?? 0) > 0) {
      const last = ctx.lastSearch;
      const version = (ctx.requestState ?? requestState).version;
      if (last && last.stateVersion === version && last.satisfying.length === 0) {
        const outcome = await args.tools.execute(ctx, "propose_plan", {
          plan: { kind: "none_meets" },
        });
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
          ...(plan ? { planKind: plan.plan.kind } : {}),
          stateEdits: ctx.requestEdits ?? 0,
          requestVersion: (ctx.requestState ?? requestState).version,
        },
        userId: args.userId,
      },
    });
  }

  const body = plan?.plan;
  // The turn searched and left no card: whatever it said about prices is
  // a quote in prose.
  const quotedWithoutCard = plan === null && asked === null && (ctx.searchesThisTurn ?? 0) > 0;
  let said: string;
  if (body?.kind === "none_meets" || body?.kind === "no_data") {
    // A "no" is said in the server's words. The model's are dropped
    // whole: no phrasing of its own can restate a near-miss as a fit.
    said = body.headline;
  } else {
    // An ask_user question is part of the reply, said once. A question the
    // SERVER asked (a search that couldn't tell where to look) is its own
    // words and may quote the user's: it is added after the check.
    const serverAsked = asked?.server ? asked.question : null;
    const spoken = scrubVerbalConfirm(
      joinReplySegments(asked && !serverAsked ? [...segments, asked.question] : segments),
      plan !== null,
    );
    const scrub = scrubUngroundedAmounts(spoken, groundedCents(ctx, plan, reported));
    if (scrub.dropped.length > 0) {
      await args.db.decision.create({
        data: {
          kind: "assistant_reply",
          inputs: { conversationId: args.conversationId },
          rule: "ungrounded_number",
          outcome: {
            amounts: scrub.dropped,
            hasPlan: plan !== null,
            quotedWithoutCard,
            requestVersion: (ctx.requestState ?? requestState).version,
          },
          userId: args.userId,
        },
      });
    }
    said = serverAsked
      ? joinReplySegments([scrub.text, serverAsked])
      : scrub.text.length > 0 || scrub.dropped.length === 0
        ? scrub.text
        : asked
          ? "Which would you like?"
          : plan
            ? ""
            : quotedWithoutCard
              ? "I found options but couldn't put them on a card."
              : "I couldn't back those numbers up, so I've left them out.";
  }
  // Models often propose with tool calls alone (Sonnet 5 did on every
  // live run): an empty reply left the card under a bare "…" bubble — the
  // one-liner states what the plan assumed.
  const assumed = body && "assumptions" in body ? body.assumptions : undefined;
  const reply =
    said.length > 0 || !body
      ? said
      : body.kind === "itinerary"
        ? `Here's a plan for your day${assumed ? ` (${assumed})` : ""} — review it, then Sign off.`
        : `Here are your options${assumed ? ` (${assumed})` : ""} — tap one to go ahead.`;

  // The tappable answers: ask_user's own (or the places a search couldn't
  // choose between); a "no" card's ways to relax the request; else — when
  // a place search this turn came back ambiguous and the model asked in
  // prose anyway — those places, so the question is still one tap.
  // Else, a question asked in prose about the city, the time, or the
  // stay gets its usual answers (clarify.ts).
  // A question about a requested time that has passed ("tomorrow at 7, or
  // now?") gets exactly those two answers. And a turn that searched but
  // left no card offers the one thing that can fix it.
  const suggestions =
    (asked && asked.suggestions.length > 0 ? asked.suggestions : null) ??
    (body ? suggestionsForPlan(body) : null) ??
    (plan === null && (ctx.placeChoices?.length ?? 0) >= 2 ? ctx.placeChoices! : null) ??
    (plan === null && reply.trim().endsWith("?") ? requestedTimeChoices(timeRequest) : null) ??
    (plan === null ? suggestionsForQuestion(reply) : null) ??
    (quotedWithoutCard ? [{ label: "Search again", reply: "Search again" }] : null);

  // The model's context, cut only where a user message starts; and the
  // readable transcript the history list shows, which is never trimmed
  // with it (history.ts).
  const trimmed = trimTurns(messages, MAX_STORED_TURNS);
  const owned = stored && stored.userId === args.userId ? stored : null;
  // A conversation saved before the transcript existed starts it from
  // what its model context still holds.
  const prior =
    Array.isArray(owned?.display) && (owned.display as unknown[]).length > 0
      ? owned.display
      : displayFromTurns(history);
  const display = appendDisplay(prior, [
    { role: "user", text: args.text, at: at.toISOString() },
    {
      role: "assistant",
      text: reply,
      at: at.toISOString(),
      ...(plan ? { planId: plan.planId } : {}),
      ...(suggestions ? { suggestions } : {}),
    },
  ]);
  // Saved with the turn that made it: a turn that fails mid-flight saves
  // neither, so the request never runs ahead of the transcript.
  const savedState = ctx.requestState ?? requestState;
  await args.db.conversation.upsert({
    where: { id: args.conversationId },
    create: {
      id: args.conversationId,
      userId: args.userId,
      turns: trimmed,
      title: titleFrom(args.text),
      display,
      requestState: savedState,
    },
    // A conversation saved before titles existed gets one now, from the
    // first request its context still holds.
    update: {
      turns: trimmed,
      display,
      requestState: savedState,
      ...(owned && !owned.title ? { title: titleFromTurns(history) ?? titleFrom(args.text) } : {}),
    },
  });

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
