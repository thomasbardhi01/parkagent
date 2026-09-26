/**
 * Saved conversations: what the app's history list and a reopened
 * conversation show. The model's context (`turns`) is trimmed to the last
 * 20 messages and carries tool calls and the time/location envelope, so a
 * conversation keeps its own readable record next to it:
 *
 *  - `title` — the first request, set once;
 *  - `display` — [{role, text, at, planId?, suggestions?}], the transcript
 *    as the user saw it, appended every turn and never trimmed with the
 *    model's context (capped at MAX_DISPLAY entries);
 *
 * and each conversation's outcome — a booking or plan made in it — comes
 * from its plans (the one the user confirmed, else the latest proposed).
 * Conversations are deleted on request or after the retention period
 * (jobs/conversationRetentionTick.ts, default 90 days).
 */

import type { AssistantPlanRow } from "../../db.js";
import type { ModelTurn } from "./loop.js";
import type { ItineraryPlan, SingleSpotPlan } from "./plans.js";
import type { Suggestion } from "./tools.js";

export const DEFAULT_RETENTION_DAYS = 90;
const MAX_DISPLAY = 400;
const TITLE_MAX = 80;

export interface DisplayEntry {
  role: "user" | "assistant";
  text: string;
  at: string;
  planId?: string;
  suggestions?: Suggestion[];
}

export interface ConversationOutcome {
  /** garage | street | itinerary — something the user confirmed;
   * proposed — a plan was offered but not acted on. */
  kind: "garage" | "street" | "itinerary" | "proposed";
  label: string;
  amountUsd: number | null;
  planId: string;
  at: string;
}

/** The first request as a one-line title. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function appendDisplay(existing: unknown, entries: DisplayEntry[]): DisplayEntry[] {
  const prior = Array.isArray(existing) ? (existing as DisplayEntry[]) : [];
  return [...prior, ...entries].slice(-MAX_DISPLAY);
}

/** The envelope the loop appends to every user message ("\n\n[phone
 * location: …]\n[current time: …]") — not the user's words. */
function withoutEnvelope(text: string): string {
  return text.replace(/\n\n\[(?:phone location|current time):[\s\S]*$/, "").trim();
}

/**
 * A readable transcript rebuilt from the model's context, for a
 * conversation saved before `display` existed: the user's own messages
 * and the assistant's text, tool traffic left out. Only as much as the
 * trimmed context still holds.
 */
export function displayFromTurns(turns: unknown): DisplayEntry[] {
  if (!Array.isArray(turns)) return [];
  const out: DisplayEntry[] = [];
  for (const turn of turns as ModelTurn[]) {
    if (turn.role === "user" && typeof turn.content === "string") {
      if (turn.content.startsWith("[system reminder]")) continue;
      out.push({ role: "user", text: withoutEnvelope(turn.content), at: "" });
    } else if (turn.role === "assistant" && Array.isArray(turn.content)) {
      const text = turn.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (text) out.push({ role: "assistant", text, at: "" });
    }
  }
  return out;
}

/** A title for a conversation saved before titles existed. */
export function titleFromTurns(turns: unknown): string | null {
  const first = displayFromTurns(turns).find((e) => e.role === "user");
  return first ? titleFrom(first.text) : null;
}

/**
 * The model context to store: the last `max` messages, starting at a real
 * user message. A cut in the middle of a tool round-trip would leave the
 * stored context opening on an assistant turn or on a tool_result whose
 * tool_use was cut away — both refused by the Messages API, which would
 * break every later turn of a resumed conversation.
 */
export function trimTurns(messages: ModelTurn[], max: number): ModelTurn[] {
  if (messages.length <= max) return messages;
  // A real user message — not the loop's own "[system reminder]", which
  // would leave a resumed context opening on an orphaned instruction.
  const isUserText = (m: ModelTurn) =>
    m.role === "user" &&
    typeof m.content === "string" &&
    !m.content.startsWith("[system reminder]");
  let start = messages.length - max;
  while (start < messages.length && !isUserText(messages[start]!)) start += 1;
  if (start < messages.length) return messages.slice(start);
  // No user text in the window: keep from the last one, however long.
  const last = messages.map(isUserText).lastIndexOf(true);
  return last >= 0 ? messages.slice(last) : messages.slice(-max);
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** What a conversation came to: the plan the user confirmed most
 * recently, else the latest one proposed, else nothing. A signed-off day
 * reads its itinerary row (`signedDays`, by plan id) — the card's edits,
 * re-priced — rather than the proposal. */
export function conversationOutcome(
  plans: AssistantPlanRow[],
  signedDays: ReadonlyMap<string, { stops: unknown; totalUsd: unknown }> = new Map(),
): ConversationOutcome | null {
  const confirmed = plans
    .filter((p) => p.confirmedAt)
    .sort((a, b) => b.confirmedAt!.getTime() - a.confirmedAt!.getTime())[0];
  if (confirmed) {
    if (confirmed.kind === "itinerary") {
      const day = confirmed.plan as ItineraryPlan;
      const signed = signedDays.get(confirmed.id);
      const stops = signed ? (signed.stops as unknown[]).length : day.stops.length;
      return {
        kind: "itinerary",
        label: `Day plan signed off — ${stops} ${stops === 1 ? "stop" : "stops"}`,
        amountUsd: signed ? Number(signed.totalUsd) : day.totalUsd,
        planId: confirmed.id,
        at: confirmed.confirmedAt!.toISOString(),
      };
    }
    const option = (confirmed.plan as SingleSpotPlan).options.find(
      (o) => o.id === confirmed.confirmedOptionId,
    );
    if (option) {
      return option.type === "garage"
        ? {
            kind: "garage",
            label: `Garage — ${option.label}`,
            amountUsd: option.priceUsd,
            planId: confirmed.id,
            at: confirmed.confirmedAt!.toISOString(),
          }
        : {
            kind: "street",
            label: `Street — ${option.street ?? option.label}`,
            amountUsd: option.priceUsd,
            planId: confirmed.id,
            at: confirmed.confirmedAt!.toISOString(),
          };
    }
  }
  const latest = [...plans].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return null;
  if (latest.kind === "itinerary") {
    const day = latest.plan as ItineraryPlan;
    return {
      kind: "proposed",
      label: `Day plan proposed — ${day.stops.length} stops, ${money(day.totalUsd)}`,
      amountUsd: null,
      planId: latest.id,
      at: latest.createdAt.toISOString(),
    };
  }
  const options = (latest.plan as SingleSpotPlan).options;
  const cheapest = Math.min(...options.map((o) => o.priceUsd));
  return {
    kind: "proposed",
    label: `${options.length} ${options.length === 1 ? "option" : "options"} proposed, from ${money(cheapest)}`,
    amountUsd: null,
    planId: latest.id,
    at: latest.createdAt.toISOString(),
  };
}
