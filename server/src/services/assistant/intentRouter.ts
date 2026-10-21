/**
 * What the request's intent decides (FR-45).
 *
 * The intent is the server's, derived from the request's start and kinds
 * (requestState.ts): parking now, parking later, or a garage only. Three
 * things follow from it, all here and all pure:
 *
 *  - which tools the model has. A request for now has no day planner; a
 *    garage-only request has no street quote either. The tools that aren't
 *    about what to search (the request itself, a place lookup, a question,
 *    history, an explanation, the two token-gated tools) are on under
 *    every intent. The loop offers the model the intent's tools on every
 *    model call, and a call to one that is off is refused
 *    (`tool_not_available_for_intent`);
 *  - the stay a search uses when the request names none: an hour for
 *    parking now, said as an assumption; nothing for a later or
 *    garage-only request, which is asked for instead;
 *  - whether a start that has passed is refused (V7): a later or
 *    garage-only request is held to it, to five minutes.
 */

import type { Intent, RequestState } from "./requestState.js";

/** The tools each intent switches off. */
const TOOLS_OFF: Record<Intent, readonly string[]> = {
  park_now: ["build_itinerary"],
  park_later: [],
  garage_or_lot: ["quote_street", "build_itinerary"],
};

/** The stay a search for right now assumes when the request names none. */
export const PARK_NOW_STAY_MINUTES = 60;
/** V7: how far past its start a later request may be before it is refused. */
export const TIME_IN_PAST_MS = 5 * 60_000;

/** A request's intent. Null is a stored intent that couldn't be read:
 * such a request is treated as the empty one's, parking now. */
export function intentOf(state: Pick<RequestState, "intent">): Intent {
  return state.intent ?? "park_now";
}

export function toolAllowed(intent: Intent, tool: string): boolean {
  return !TOOLS_OFF[intent].includes(tool);
}

/** The tool definitions an intent leaves on, in their declared order. */
export function toolsForIntent<T extends { name: string }>(
  definitions: readonly T[],
  intent: Intent,
): T[] {
  return definitions.filter((tool) => toolAllowed(intent, tool.name));
}

/** What a model is told when it calls a tool its intent has off. */
export function toolOffInstruction(intent: Intent, tool: string): string {
  if (tool === "quote_street") {
    return (
      "The request is for a garage only, so street parking isn't quoted: use search_garages. " +
      "If the user said street is fine too, change the request first (update_request kinds, or clear hard.kinds)."
    );
  }
  if (tool === "build_itinerary") {
    return intent === "garage_or_lot"
      ? "The request is for a garage only: search it with search_garages. build_itinerary plans a day of several stops, for a request that isn't garage-only and starts later."
      : "build_itinerary plans a day of several stops at set times, for a request that starts later: put the day's first arrival on the request (update_request startsAt) and it is available. For parking right now, use quote_street and search_garages.";
  }
  return `${tool} isn't available for a ${intent} request.`;
}

/** The stay a search of this request uses: the user's, an hour's default
 * for parking now, or null — a later or garage-only request must say. The
 * default is the search's alone: it is never written to the request, so
 * it can't follow the request into a later time. */
export function stayFor(
  state: RequestState,
): { minutes: number; source: "user" | "default" } | null {
  if (state.window.durationMinutes !== null) {
    return { minutes: state.window.durationMinutes, source: "user" };
  }
  return intentOf(state) === "park_now"
    ? { minutes: PARK_NOW_STAY_MINUTES, source: "default" }
    : null;
}

/** Whether V7 applies: a start the user set, on a later or garage-only
 * request. Parking now keeps the looser rule for a mistaken date. */
export function heldToItsStart(state: RequestState): boolean {
  return state.window.startsAt !== null && intentOf(state) !== "park_now";
}
