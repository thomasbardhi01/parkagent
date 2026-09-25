/**
 * Model-supplied times: an offset-less timestamp is Eastern wall-clock
 * time, never the host's zone. The bug this pins was invisible locally —
 * `new Date("2026-09-26T18:00:00")` is 18:00 ET on a dev Mac and 18:00 UTC
 * (14:00 ET) on Fly — so every assertion here is an absolute instant,
 * and the host zone is pinned to one that is neither: a parser that
 * leaned on the host's zone would pass on a Mac in ET and fail only in
 * prod.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { easternIso, easternWallClock, parseEasternTime } from "../src/services/hours.js";

const hostTz = process.env["TZ"];
beforeAll(() => {
  process.env["TZ"] = "Asia/Tokyo";
});
afterAll(() => {
  if (hostTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = hostTz;
});

describe("parseEasternTime", () => {
  test("offset-less wall-clock time is read as NYC time in summer and winter", () => {
    expect(parseEasternTime("2026-09-26T18:00:00")?.toISOString()).toBe("2026-09-26T22:00:00.000Z");
    expect(parseEasternTime("2026-09-26T18:00")?.toISOString()).toBe("2026-09-26T22:00:00.000Z");
    expect(parseEasternTime("2026-01-05T14:00:00")?.toISOString()).toBe("2026-01-05T19:00:00.000Z");
    expect(parseEasternTime("2026-01-05 14:00:00.250")?.toISOString()).toBe(
      "2026-01-05T19:00:00.000Z",
    );
  });

  test("an explicit offset or Z is honored as written", () => {
    expect(parseEasternTime("2026-09-26T22:00:00Z")?.toISOString()).toBe(
      "2026-09-26T22:00:00.000Z",
    );
    expect(parseEasternTime("2026-09-26T18:00:00-04:00")?.toISOString()).toBe(
      "2026-09-26T22:00:00.000Z",
    );
    expect(parseEasternTime("2026-09-26T15:00:00-0700")?.toISOString()).toBe(
      "2026-09-26T22:00:00.000Z",
    );
  });

  test("DST: the hour after spring-forward and both sides of fall-back resolve sanely", () => {
    // 2026-03-08 03:30 EDT exists; 2026-11-01 00:30 is still EDT.
    expect(parseEasternTime("2026-03-08T03:30:00")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(parseEasternTime("2026-11-01T00:30:00")?.toISOString()).toBe("2026-11-01T04:30:00.000Z");
    expect(parseEasternTime("2026-11-01T03:00:00")?.toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });

  test("unreadable or out-of-range input is null, never a guess", () => {
    for (const bad of [
      "",
      "garbage",
      "2026-09-26",
      "tomorrow at 2",
      "2026-13-45T99:00",
      "2026-02-30T10:00",
    ]) {
      expect(parseEasternTime(bad), bad).toBeNull();
    }
  });
});

describe("easternIso / easternWallClock", () => {
  test("format an instant in NYC's own offset", () => {
    const summer = new Date("2026-09-26T22:00:00.000Z");
    expect(easternIso(summer)).toBe("2026-09-26T18:00:00-04:00");
    expect(easternWallClock(summer)).toBe("2026-09-26T18:00:00");
    const winter = new Date("2026-01-05T19:00:00.000Z");
    expect(easternIso(winter)).toBe("2026-01-05T14:00:00-05:00");
  });

  test("round-trips through parseEasternTime", () => {
    for (const iso of ["2026-09-26T18:00:00-04:00", "2026-01-05T14:00:00-05:00"]) {
      expect(easternIso(parseEasternTime(iso)!)).toBe(iso);
      expect(easternIso(parseEasternTime(iso.slice(0, 19))!)).toBe(iso);
    }
  });
});
