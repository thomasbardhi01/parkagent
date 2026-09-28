/**
 * requestedTime.ts — reading the clock time a message asks for, and
 * where it lands. The loop-level behavior (what the model is told, what
 * the tools refuse, what the card says) is assistantRequestedTime.test.ts.
 */
import { describe, expect, test } from "vitest";

import {
  requestedTimeIn,
  requestedTimeProblem,
  type RequestedClockTime,
} from "../src/services/assistant/requestedTime.js";
import { easternIso } from "../src/services/hours.js";

const at = (iso: string) => new Date(iso);

function clock(text: string, now: string): { label: string; status: string; next: string } | null {
  const r = requestedTimeIn(text, at(now));
  if (!r || r.kind !== "clock") return null;
  return { label: r.label, status: r.status, next: easternIso(r.next) };
}

describe("reading the requested clock time", () => {
  const SUNDAY_811PM = "2026-09-27T20:11:00-04:00";

  test("a time that has passed today means tomorrow; one still ahead means today", () => {
    expect(clock("at Seaport at 7 PM near Lola 42", SUNDAY_811PM)).toEqual({
      label: "7 PM",
      status: "passed",
      next: "2026-09-28T19:00:00-04:00",
    });
    expect(clock("at Seaport at 7 PM near Lola 42", "2026-09-27T15:00:00-04:00")).toEqual({
      label: "7 PM",
      status: "later_today",
      next: "2026-09-27T19:00:00-04:00",
    });
  });

  test("a time that began under 15 minutes ago still means today", () => {
    expect(clock("at 7 PM", "2026-09-27T19:10:00-04:00")?.status).toBe("later_today");
    expect(clock("at 7 PM", "2026-09-27T19:16:00-04:00")?.status).toBe("passed");
  });

  test("the ways people write it", () => {
    expect(clock("at 7:30pm please", SUNDAY_811PM)?.label).toBe("7:30 PM");
    expect(clock("at 7 p.m.", SUNDAY_811PM)?.label).toBe("7 PM");
    expect(clock("at 19:00", SUNDAY_811PM)?.label).toBe("7 PM");
    expect(clock("around noon", SUNDAY_811PM)).toMatchObject({ label: "noon", status: "passed" });
    // Midnight tonight is the next midnight.
    expect(clock("until midnight", SUNDAY_811PM)?.next).toBe("2026-09-28T00:00:00-04:00");
  });

  test("a window starts at its first time", () => {
    const noonish = "2026-09-27T12:00:00-04:00";
    expect(clock("parking 7-10 PM", noonish)?.label).toBe("7 PM");
    expect(clock("from 7 PM to 10 PM near Fenway", noonish)?.label).toBe("7 PM");
    expect(clock("from 11 to 1 pm", "2026-09-27T09:00:00-04:00")?.label).toBe("11 AM");
  });

  test("a named day is left to the model; so are several unrelated times", () => {
    for (const text of [
      "tomorrow at 7 PM",
      "Friday at 7pm",
      "on Tuesday, October 6 at 7 PM",
      "on Oct 3 at 7pm",
      "on 10/3 at 7pm",
      "lunch at noon near Fenway, dinner at 7 PM in Seaport",
    ]) {
      expect(requestedTimeIn(text, at(SUNDAY_811PM)), text).toBeNull();
    }
    // No clock time at all: nothing to read.
    expect(requestedTimeIn("for 2 hours now", at(SUNDAY_811PM))).toBeNull();
    expect(requestedTimeIn("at 7:30", at(SUNDAY_811PM))).toBeNull(); // AM or PM?
  });

  test("the next occurrence keeps the wall clock across a DST change", () => {
    // Fall back (Nov 1): tomorrow's 1 AM is EST.
    expect(clock("at 1 AM", "2026-11-01T01:30:00-04:00")?.next).toBe("2026-11-02T01:00:00-05:00");
    // Spring forward (Mar 8): tomorrow's 7 PM is EDT.
    expect(clock("at 7 PM", "2026-03-07T20:30:00-05:00")?.next).toBe("2026-03-08T19:00:00-04:00");
  });
});

describe('"tonight"', () => {
  test("asked after midnight, means this coming evening", () => {
    const r = requestedTimeIn("parking near Fenway tonight", at("2026-09-28T01:30:00-04:00"));
    expect(r?.kind).toBe("tonight");
    expect(r?.kind === "tonight" && easternIso(r.evening)).toBe("2026-09-28T19:00:00-04:00");
  });

  test("asked in the evening, is plain tonight — nothing to read", () => {
    expect(requestedTimeIn("parking near Fenway tonight", at("2026-09-27T18:00:00-04:00"))).toBe(
      null,
    );
  });
});

describe("what the tools refuse", () => {
  const NOW = at("2026-09-27T20:11:00-04:00");
  const passed = requestedTimeIn("at 7 PM", NOW) as RequestedClockTime;

  test("a window for now, or today's passed 7 PM, is moved; tomorrow's 7 PM isn't", () => {
    expect(requestedTimeProblem(passed, NOW, NOW)).toContain("Never move a requested time to now");
    expect(requestedTimeProblem(passed, at("2026-09-27T19:00:00-04:00"), NOW)).not.toBeNull();
    expect(requestedTimeProblem(passed, at("2026-09-28T19:00:00-04:00"), NOW)).toBeNull();
    expect(requestedTimeProblem(passed, at("2026-09-28T19:20:00-04:00"), NOW)).toBeNull();
  });

  test("a plan must start at it; a quote may start later (a day's other stop)", () => {
    const later = at("2026-09-28T21:00:00-04:00");
    expect(requestedTimeProblem(passed, later, NOW)).not.toBeNull();
    expect(requestedTimeProblem(passed, later, NOW, { earlierOnly: true })).toBeNull();
  });

  test("no request, nothing to refuse", () => {
    expect(requestedTimeProblem(undefined, NOW, NOW)).toBeNull();
  });
});
