/**
 * load:zone-numbers' withdrawn-import reverts: when a re-run no longer
 * claims a zone, the number the import previously put on it must not
 * linger with no backing source — it falls back to the zone's reports,
 * or to "" (unknown) when nobody has reported.
 */

import { expect, test } from "vitest";

import { planWithdrawnReverts } from "../src/services/zoneNumberReverts.js";

const T0 = new Date("2026-09-22T10:00:00Z");
const T1 = new Date("2026-09-22T11:00:00Z");

test("an orphaned import number reverts to unknown when there are no reports", () => {
  const reverts = planWithdrawnReverts(
    [{ zoneId: "bos-x", number: "55555" }],
    [{ zoneId: "bos-x", providerZoneNumber: "55555", providerZoneNumberVerified: false }],
    [],
  );
  expect(reverts).toEqual([{ zoneId: "bos-x", number: "", verified: false }]);
});

test("reverts to the latest report, verified when two users agree with it", () => {
  const reverts = planWithdrawnReverts(
    [{ zoneId: "bos-x", number: "55555" }],
    [{ zoneId: "bos-x", providerZoneNumber: "55555", providerZoneNumberVerified: false }],
    [
      { zoneId: "bos-x", userId: "u1", number: "81234", createdAt: T0 },
      { zoneId: "bos-x", userId: "u2", number: "81234", createdAt: T1 },
    ],
  );
  expect(reverts).toEqual([{ zoneId: "bos-x", number: "81234", verified: true }]);
});

test("a single report restores its number unverified", () => {
  const reverts = planWithdrawnReverts(
    [{ zoneId: "bos-x", number: "55555" }],
    [{ zoneId: "bos-x", providerZoneNumber: "55555", providerZoneNumberVerified: false }],
    [{ zoneId: "bos-x", userId: "u1", number: "81234", createdAt: T0 }],
  );
  expect(reverts).toEqual([{ zoneId: "bos-x", number: "81234", verified: false }]);
});

test("a verified zone, or a number from another source, is left alone", () => {
  const reverts = planWithdrawnReverts(
    [
      { zoneId: "bos-verified", number: "55555" },
      { zoneId: "bos-other-source", number: "55555" },
      { zoneId: "bos-missing", number: "55555" },
    ],
    [
      // Verified by two users — the import's withdrawal changes nothing.
      { zoneId: "bos-verified", providerZoneNumber: "55555", providerZoneNumberVerified: true },
      // The zone's current number is NOT the import's — leave it.
      {
        zoneId: "bos-other-source",
        providerZoneNumber: "81234",
        providerZoneNumberVerified: false,
      },
      // bos-missing has no zone row loaded — nothing to revert.
    ],
    [],
  );
  expect(reverts).toEqual([]);
});

test("conflicting reports fall back to the newest one, counted on its own number", () => {
  const reverts = planWithdrawnReverts(
    [{ zoneId: "bos-x", number: "55555" }],
    [{ zoneId: "bos-x", providerZoneNumber: "55555", providerZoneNumberVerified: false }],
    [
      { zoneId: "bos-x", userId: "u1", number: "81234", createdAt: T0 },
      { zoneId: "bos-x", userId: "u2", number: "99999", createdAt: T1 },
    ],
  );
  expect(reverts).toEqual([{ zoneId: "bos-x", number: "99999", verified: false }]);
});
