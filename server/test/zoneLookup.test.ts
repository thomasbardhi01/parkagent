import { expect, test } from "vitest";

import { candidatesAgree, lookupRadiusM, resolveCandidates } from "../src/services/zoneLookup.js";
import { BROADWAY_A, BROADWAY_B, MONDAY_2PM, MOTT_A, MOTT_B } from "./helpers.js";

const AT = new Date(MONDAY_2PM);

test("lookup radius is max(accuracy, 25 m)", () => {
  expect(lookupRadiusM(12.5)).toBe(25);
  expect(lookupRadiusM(48)).toBe(48);
});

test("no candidates resolves to unknown", () => {
  expect(resolveCandidates([], AT, true)).toEqual({ kind: "unknown" });
});

test("Broadway & W 72nd: both sides agree, nearest wins", () => {
  const resolution = resolveCandidates([BROADWAY_A, BROADWAY_B], AT, true);
  expect(resolution).toEqual({ kind: "agree", nearest: BROADWAY_A });
});

test("Mott & Canal: max stay 120 vs 300 disagrees, surfaces both sides", () => {
  const resolution = resolveCandidates([MOTT_A, MOTT_B], AT, true);
  expect(resolution).toEqual({
    kind: "disagree",
    nearest: MOTT_A,
    alternative: MOTT_B,
  });
});

test("differing rates disagree", () => {
  const pricier = { ...BROADWAY_B, rateFirstHourUsd: 5.5 };
  expect(candidatesAgree(BROADWAY_A, pricier, AT, true)).toBe(false);
});

test("hours posted differently but identical for the next 60 min agree", () => {
  // A: Mon-Sat 08:30-19:00; B: Mon-Fri 08:00-20:00. At Monday 14:00 both
  // are enforced for the whole next hour.
  const b = {
    ...BROADWAY_B,
    hours: [
      {
        days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        start: "08:00",
        end: "20:00",
      },
    ],
  };
  expect(candidatesAgree(BROADWAY_A, b, AT, true)).toBe(true);
});

test("hours diverging inside the next 60 min disagree", () => {
  // B's enforcement ends 14:30; A runs to 19:00 — they differ from 14:30 on.
  const b = {
    ...BROADWAY_B,
    hours: [
      {
        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        start: "08:30",
        end: "14:30",
      },
    ],
  };
  expect(candidatesAgree(BROADWAY_A, b, AT, true)).toBe(false);
  const resolution = resolveCandidates([BROADWAY_A, b], AT, true);
  expect(resolution.kind).toBe("disagree");
});

test("hour differences are ignored when respect_enforcement_hours is off", () => {
  const b = {
    ...BROADWAY_B,
    hours: [
      {
        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        start: "08:30",
        end: "14:30",
      },
    ],
  };
  expect(candidatesAgree(BROADWAY_A, b, AT, false)).toBe(true);
});

test("empty hours (nothing posted) count as always enforced", () => {
  // At Monday 20:00, A (ends 19:00) is off but an empty-hours zone is on.
  const at = new Date("2026-01-05T20:00:00-05:00");
  const b = { ...BROADWAY_B, hours: [] };
  expect(candidatesAgree(BROADWAY_A, b, at, true)).toBe(false);
  expect(candidatesAgree(BROADWAY_A, b, new Date(MONDAY_2PM), true)).toBe(true);
});
