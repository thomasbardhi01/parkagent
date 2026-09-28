/**
 * The FR suite's pinned request times (fr/client.ts): a run's assistant
 * scenario must be the same whatever hour it runs at, and the "asked after
 * the time" test must really be asked after it.
 */
import { describe, expect, test } from "vitest";

import { passedClockTime, pinnedDay } from "../fr/client.js";

const at = (iso: string) => new Date(iso);

describe("pinnedDay", () => {
  test("the next Tuesday at least two days out, said the way a person says it", () => {
    // Sunday evening (the 8:11 PM nightly) and the Tue–Sat 5 AM crons.
    expect(pinnedDay(at("2026-09-27T20:11:00-04:00"))).toEqual({
      phrase: "on Tuesday, September 29",
      date: "2026-09-29",
    });
    // Monday: tomorrow is Tuesday, too close — the one after.
    expect(pinnedDay(at("2026-09-28T05:17:00-04:00")).date).toBe("2026-10-06");
    // Tuesday itself: next week's.
    expect(pinnedDay(at("2026-09-29T05:17:00-04:00")).date).toBe("2026-10-06");
    expect(pinnedDay(at("2026-10-03T05:17:00-04:00")).phrase).toBe("on Tuesday, October 6");
  });

  test("reads the Eastern date, not the host's (late evening is still today in Boston)", () => {
    // 11:30 PM Monday ET is already Tuesday in UTC.
    expect(pinnedDay(at("2026-09-28T23:30:00-04:00")).date).toBe("2026-10-06");
  });
});

describe("passedClockTime", () => {
  test("90 minutes back, on the half hour, and tomorrow at that time", () => {
    expect(passedClockTime(at("2026-09-27T20:11:00-04:00"))).toEqual({
      label: "6:30 PM",
      clock: "6:30",
      tomorrowIso: "2026-09-28T18:30:00-04:00",
    });
    expect(passedClockTime(at("2026-09-29T05:17:00-04:00"))).toEqual({
      label: "3:30 AM",
      clock: "3:30",
      tomorrowIso: "2026-09-30T03:30:00-04:00",
    });
    expect(passedClockTime(at("2026-09-29T13:05:00-04:00"))?.label).toBe("11:30 AM");
    expect(passedClockTime(at("2026-09-29T13:45:00-04:00"))?.label).toBe("12 PM");
  });

  test("nothing within 90 minutes of midnight has passed that long today", () => {
    expect(passedClockTime(at("2026-09-28T01:00:00-04:00"))).toBeNull();
    expect(passedClockTime(at("2026-09-28T01:31:00-04:00"))?.label).toBe("12 AM");
  });

  test("tomorrow's offset is tomorrow's, across a DST change", () => {
    // Mar 7 → 8 springs forward: tomorrow evening is EDT. Oct 31 → Nov 1
    // falls back at 2 AM: tomorrow afternoon is EST.
    expect(passedClockTime(at("2026-03-07T21:00:00-05:00"))?.tomorrowIso).toBe(
      "2026-03-08T19:30:00-04:00",
    );
    expect(passedClockTime(at("2026-10-31T17:00:00-04:00"))?.tomorrowIso).toBe(
      "2026-11-01T15:30:00-05:00",
    );
  });
});
