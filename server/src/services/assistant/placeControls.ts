/**
 * How a place lookup is judged against what it should come to: the rule
 * `pnpm -C server verify:places` holds the real search to, and the two
 * kinds of control that keep the name rule (placeTokens.ts) honest in both
 * directions.
 *
 *  - The negative control is a name no place has. It must come back not
 *    found — or as the closest thing only, said as that — under the line a
 *    place is taken at. A real place makes a poor negative: the first one
 *    was "xyzzy restaurant", judged against W XYZ Bar, and W XYZ Bar is a
 *    real bar.
 *  - The positive controls are that bar, said by its own words. A whole
 *    word is the word, so each must be the place, at or above that line:
 *    the rule that stopped "xyzzy" from matching "XYZ" must never cost
 *    "XYZ" its match.
 *
 * Pure: an answer in, a verdict out. The answers are geocode_place's
 * (tools.ts), read as the model reads them.
 */

import { RESOLUTION_THRESHOLDS } from "./placeScore.js";

/** A name that exists nowhere. */
export const NEGATIVE_CONTROL = "Blorptastic Noodle House";
/** A real bar, said by its own words; `named` is what the answer's name
 * must hold for it to be that bar. */
export const POSITIVE_CONTROLS = { queries: ["XYZ bar", "W XYZ"], named: "XYZ" } as const;

/**
 * What a lookup should come to:
 *  - found: the place, by its name;
 *  - sure: found, by its name, at or above the `found` threshold — the
 *    name was carried whole, with nothing held against it;
 *  - area: the neighborhood itself (a result of kind "area"), never a
 *    business named after it;
 *  - ambiguous: a question with choices;
 *  - unsure: nothing found; or only the closest thing, said as that; or a
 *    question — each under the `found` threshold. Never a place taken
 *    with confidence.
 */
export type Expectation = "found" | "sure" | "area" | "ambiguous" | "unsure";

/** Whether a geocode_place answer is what was expected. `named`: words
 * the answer's own name must hold — the place, not merely a place. */
export function meetsExpectation(
  expect: Expectation,
  answer: Record<string, unknown>,
  named?: string,
): boolean {
  const place = answer["place"] as
    { kind?: string | null; name?: string | null; displayName?: string } | undefined;
  const confidence = typeof answer["confidence"] === "number" ? answer["confidence"] : null;
  const byName = answer["found"] === true && answer["match"] === "exact";
  const isIt =
    named === undefined ||
    (place?.name ?? place?.displayName ?? "").toLowerCase().includes(named.toLowerCase());
  switch (expect) {
    case "found":
      return byName && isIt;
    case "sure":
      return byName && isIt && confidence !== null && confidence >= RESOLUTION_THRESHOLDS.found;
    case "area":
      return byName && place?.kind === "area";
    case "ambiguous":
      return answer["ambiguous"] === true;
    case "unsure":
      return (
        answer["found"] === false ||
        // The closest thing only (said as that), or a question: either
        // way under the line a place is taken at.
        ((answer["match"] === "closest" || answer["ambiguous"] === true) &&
          confidence !== null &&
          confidence < RESOLUTION_THRESHOLDS.found)
      );
  }
}
