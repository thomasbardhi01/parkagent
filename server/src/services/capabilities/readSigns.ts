/**
 * readSigns (Issue N): what the parking signs at a park say, read by
 * Claude Sonnet 5.5 from the text the phone recognized on them (and one
 * photo, only when that recognition was unsure), held to a strict JSON
 * schema, every number checked against the sign's own text or the zone
 * data, and compared with the zone data at the car.
 *
 * Advisory only, never on the money path: the answer can warn, or offer a
 * SHORTER max stay for this park, which applies only if the driver accepts
 * it (routes/signs.ts, then the start and extend gates read it). It never
 * loosens a limit, changes a price, or starts or stops anything. One model
 * call per check the driver asks for, counted against the same daily
 * spend cap as the assistant (ASSISTANT_DAILY_SPEND_CAP_USD). Whatever
 * goes wrong (no model answer, a refusal, an answer off the schema, a low
 * confidence) reads as unreadable.
 */

import type { AppDb } from "../../db.js";
import { assistantSpendTodayUsd, estimateCostUsd } from "../assistant/loop.js";
import type { ModelClient, ModelImageBlock } from "../assistant/modelClient.js";
import { SIGN_READER_MODEL } from "../assistant/modelClient.js";
import type { Principal } from "../principal.js";
import type { SignRule, SignRules, Verdict, ZoneView } from "../signs/signRules.js";
import {
  compareWithZone,
  groundRules,
  SIGN_RULES_JSON_SCHEMA,
  signRulesSchema,
} from "../signs/signRules.js";
import type { CandidateFetcher } from "../zoneLookup.js";
import { lookupRadiusM } from "../zoneLookup.js";
import { applyObservedToCandidates } from "../zoneTermsObserved.js";

export interface ReadSignsDeps {
  db: AppDb;
  model: ModelClient;
  findCandidates: CandidateFetcher;
  /** ASSISTANT_DAILY_SPEND_CAP_USD; unset: uncapped (tests). */
  dailySpendCapUsd?: number;
  now?: () => Date;
}

export interface ReadSignsInput {
  /** The text the phone recognized on the signs (on-device OCR). */
  text: string;
  /** One downscaled photo, only when that recognition was unsure. */
  photo?: { mediaType: "image/jpeg" | "image/png"; data: string };
  /** Where the phone is, at the car. */
  fix: { lat: number; lng: number; accuracy: number };
  parkedEventId: string;
}

export type ReadSignsOutcome =
  | { refused: "assistant_budget_exhausted"; decisionId: string }
  | {
      verdict: Verdict;
      rules: SignRule[];
      confidence: number;
      offerMaxStayMinutes: number | null;
      reasons: string[];
      zone: ZoneView | null;
      /** Why a reading fell back to unreadable, when it did. */
      fallback: string | null;
      dropped: { index: number; why: string }[];
      decisionId: string;
    };

/** Below this the reading is not trusted at all. */
const MIN_CONFIDENCE = 0.4;
/** The stay the comparison looks over when the zone has no max stay. */
const DEFAULT_STAY_MINUTES = 120;

const SYSTEM = `You read street parking signs in Boston and New York.
You are given the text a phone recognized on the signs at one parking spot, and sometimes a photo of them.
Return what the signs say as rules, in the JSON schema you are given. One rule per restriction:
- time_limit: a posted time limit ("2 HOUR PARKING"), limitMinutes in minutes.
- meter: pay at the meter or by app during the hours shown; limitMinutes if a limit is shown.
- no_parking, no_stopping, tow_zone: when the car may not be left there.
- street_cleaning: the cleaning window.
- permit_only: resident or permit parking only, permitZone as written.
Days are mon..sun (empty for every day); start and end are 24-hour HH:MM (null for all day).
Use only what is printed on the signs. Never supply a number, hour, day or permit zone that is not on them.
If the signs can't be read, set unreadable to true and leave rules empty. confidence is how sure you are, 0 to 1.`;

export async function readSigns(
  deps: ReadSignsDeps,
  principal: Principal,
  input: ReadSignsInput,
): Promise<ReadSignsOutcome> {
  const at = deps.now?.() ?? new Date();
  const decide = (rule: string, outcome: Record<string, unknown>) =>
    deps.db.decision.create({
      data: {
        kind: "sign_check",
        inputs: {
          parkedEventId: input.parkedEventId,
          textChars: input.text.length,
          photo: input.photo !== undefined,
          fix: input.fix,
        },
        rule,
        outcome,
        userId: principal.userId,
        parkedEventId: input.parkedEventId,
      },
    });

  // The same daily ceiling as the assistant: a check over it costs nothing.
  if (deps.dailySpendCapUsd !== undefined) {
    const spent = await assistantSpendTodayUsd(deps.db, principal.userId, at);
    if (spent >= deps.dailySpendCapUsd) {
      const decision = await decide("daily_spend_cap", {
        spentUsd: spent,
        capUsd: deps.dailySpendCapUsd,
      });
      return { refused: "assistant_budget_exhausted", decisionId: decision.id };
    }
  }

  // The zone data at the car: the one the fix is inside, else the nearest.
  const candidates = await applyObservedToCandidates(
    deps.db,
    await deps.findCandidates({
      lat: input.fix.lat,
      lng: input.fix.lng,
      radiusM: lookupRadiusM(input.fix.accuracy),
    }),
  );
  const nearest =
    candidates.find((c) => c.containsPoint) ??
    [...candidates].sort((a, b) => a.distanceM - b.distanceM)[0];
  const zone: ZoneView | null = nearest
    ? { zoneId: nearest.zoneId, maxStayMinutes: nearest.maxStayMinutes, hours: nearest.hours }
    : null;

  const read = await interpretSigns(deps.model, input.text, input.photo);
  const { usage, model } = read;
  let fallback = read.fallback;
  const reading = read.reading;
  if (!fallback && reading && reading.confidence < MIN_CONFIDENCE) fallback = "low_confidence";
  const grounded = reading
    ? groundRules(reading.rules, {
        text: input.text,
        zoneMaxStayMinutes: zone?.maxStayMinutes ?? null,
        zoneHours: zone?.hours ?? [],
      })
    : { rules: [], dropped: [] };
  const unreadable = fallback !== null || !reading || reading.unreadable;
  const comparison = compareWithZone(
    { rules: unreadable ? [] : grounded.rules, unreadable },
    zone,
    at,
    zone?.maxStayMinutes ?? DEFAULT_STAY_MINUTES,
  );
  const costUsd = estimateCostUsd(model, usage.inputTokens, usage.outputTokens);
  const decision = await decide(comparison.verdict, {
    verdict: comparison.verdict,
    offerMaxStayMinutes: comparison.offerMaxStayMinutes,
    reasons: comparison.reasons,
    zoneId: zone?.zoneId ?? null,
    rules: unreadable ? [] : grounded.rules,
    dropped: grounded.dropped,
    fallback,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: costUsd,
  });
  return {
    verdict: comparison.verdict,
    rules: unreadable ? [] : grounded.rules,
    confidence: reading?.confidence ?? 0,
    offerMaxStayMinutes: comparison.offerMaxStayMinutes,
    reasons: comparison.reasons,
    zone,
    fallback,
    dropped: grounded.dropped,
    decisionId: decision.id,
  };
}

/**
 * The model's reading of the signs, held to the SignRules schema: one
 * call, no prefill and no thinking budget, the photo only when given.
 * `fallback` says why there is no reading (the call failed, a refusal or a
 * cut-off answer, an answer off the schema). Exported for the live eval
 * (scripts/sign-eval.ts), which runs it without a database.
 */
export async function interpretSigns(
  modelClient: ModelClient,
  text: string,
  photo?: ReadSignsInput["photo"],
): Promise<{
  reading: SignRules | null;
  fallback: string | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}> {
  const image: ModelImageBlock[] = photo
    ? [{ type: "image", source: { type: "base64", media_type: photo.mediaType, data: photo.data } }]
    : [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let model: string = SIGN_READER_MODEL;
  try {
    const response = await modelClient.create({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            ...image,
            { type: "text", text: `Text recognized on the signs:\n${text.trim() || "(none)"}` },
          ],
        },
      ],
      maxTokens: 1500,
      outputSchema: SIGN_RULES_JSON_SCHEMA,
    });
    usage = response.usage ?? usage;
    model = response.model ?? model;
    if (response.stopReason !== "end_turn") {
      return { reading: null, fallback: `stop_${response.stopReason}`, usage, model };
    }
    const answer = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let json: unknown;
    try {
      json = JSON.parse(answer);
    } catch {
      json = undefined;
    }
    const parsed = signRulesSchema.safeParse(json);
    return parsed.success
      ? { reading: parsed.data, fallback: null, usage, model }
      : { reading: null, fallback: "off_schema", usage, model };
  } catch {
    return { reading: null, fallback: "model_error", usage, model };
  }
}
