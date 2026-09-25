/**
 * The FR throwaway purge (scripts/purge-fr-throwaways.ts): it must find
 * every account create-fr-throwaway minted that a run left behind, tear it
 * down exactly as DELETE /me does — and never touch the FR user, a person,
 * or a throwaway a run may still be using.
 */

import { describe, expect, test } from "vitest";

import type { UserIdentityRow } from "../src/db.js";
import {
  applyThrowawayPurge,
  FR_THROWAWAY_MARKER,
  frThrowawayName,
  planThrowawayPurge,
  type ThrowawayVerdict,
} from "../src/services/frThrowaways.js";
import { makeFakeDb, type FakeDbState } from "./helpers.js";

const NOW = new Date("2026-09-25T10:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function user(
  id: string,
  name: string,
  createdAt: Date,
  overrides: Partial<FakeDbState["users"][number]> = {},
): FakeDbState["users"][number] {
  const row: UserIdentityRow = {
    id,
    name,
    isAdmin: false,
    paymentSource: "provider_card",
    email: null,
    emailVerified: false,
    phone: null,
    phoneVerified: false,
    appleSub: null,
    googleSub: null,
    deletedAt: null,
    createdAt,
  };
  return { ...row, ...overrides };
}

/** A throwaway exactly as create-fr-throwaway mints one: the name, the
 * marker decision, and a refresh session. */
function mint(state: FakeDbState, id: string, createdAt: Date, tokens = 1) {
  state.users.push(user(id, frThrowawayName(createdAt), createdAt));
  mark(state, id);
  for (let i = 0; i < tokens; i += 1) {
    state.refreshTokens.push({
      id: `rt-${id}-${i}`,
      userId: id,
      familyId: `fam-${id}`,
      tokenHash: `hash-${id}-${i}`,
      deviceId: `fr-throwaway-${id}`,
      expiresAt: new Date(NOW.getTime() + 60 * 86_400_000),
      rotatedAt: i < tokens - 1 ? createdAt : null,
      revokedAt: null,
      createdAt,
    });
  }
}

function mark(state: FakeDbState, userId: string) {
  state.decisions.push({
    ...FR_THROWAWAY_MARKER,
    inputs: { via: "create-fr-throwaway" },
    outcome: { ok: true },
    userId,
  });
}

const byUser = (plan: ThrowawayVerdict[]) =>
  Object.fromEntries(plan.map((v) => [v.userId, v.action]));

describe("planThrowawayPurge", () => {
  test("selects only minted throwaways past the age gate; never the FR user or a person", async () => {
    const { db, state } = makeFakeDb();
    // The dedicated FR user: admin, api key — even if a marker ever named it.
    state.users.push(
      user("fr-user", "fr-nightly", minutesAgo(10_000), { isAdmin: true, apiKeyHash: "h" }),
    );
    mark(state, "fr-user");
    // A person who signed in with Apple, wearing a throwaway-shaped name.
    state.users.push(
      user("person", frThrowawayName(minutesAgo(600)), minutesAgo(600), { appleSub: "apple-1" }),
    );
    mark(state, "person");
    // u1 (the seeded admin with the test key), named by a stray marker.
    mark(state, "u1");
    // An admin with no key or identity left (say, mid key rotation) in a
    // throwaway's clothes: admin alone keeps it off the list.
    state.users.push(
      user("keyless-admin", frThrowawayName(minutesAgo(600)), minutesAgo(600), { isAdmin: true }),
    );
    mark(state, "keyless-admin");
    // A throwaway-shaped row nothing minted: no marker, never considered.
    state.users.push(user("unmarked", frThrowawayName(minutesAgo(600)), minutesAgo(600)));
    // A marked row someone renamed: no longer provably ours.
    state.users.push(user("renamed", "Tommy", minutesAgo(600)));
    mark(state, "renamed");

    mint(state, "old", minutesAgo(120), 2);
    mint(state, "fresh", minutesAgo(5));
    mint(state, "carded", minutesAgo(120));
    state.users.find((u) => u.id === "carded")!.stripeCustomerId = "cus_1";
    // Tombstoned by a previous run's DELETE /me — one with a stray token.
    mint(state, "gone-dirty", minutesAgo(900));
    mint(state, "gone-clean", minutesAgo(900), 0);
    for (const id of ["gone-dirty", "gone-clean"]) {
      Object.assign(
        state.users.find((u) => u.id === id)!,
        {
          name: "Deleted account",
          deletedAt: minutesAgo(890),
        },
      );
    }

    const plan = await planThrowawayPurge(db, { now: NOW, minAgeMinutes: 30 });
    expect(byUser(plan)).toEqual({
      "fr-user": "not_a_throwaway",
      person: "not_a_throwaway",
      u1: "not_a_throwaway",
      "keyless-admin": "not_a_throwaway",
      renamed: "not_a_throwaway",
      old: "delete",
      fresh: "too_fresh",
      carded: "needs_manual",
      "gone-dirty": "clear_sessions",
      "gone-clean": "clean",
    });
    expect(plan.find((v) => v.userId === "old")!.refreshTokens).toBe(2);
    expect(plan.find((v) => v.userId === "fr-user")!.reason).toBe("has an api key");
    expect(plan.find((v) => v.userId === "person")!.reason).toBe("has a sign-in identity");
    expect(plan.find((v) => v.userId === "renamed")!.reason).toBe("renamed");
    expect(plan.find((v) => v.userId === "keyless-admin")!.reason).toBe("is an admin");
  });

  test("--include lifts only the age gate, and only for the ids named", async () => {
    const { db, state } = makeFakeDb();
    mint(state, "this-run", minutesAgo(3));
    mint(state, "other-run", minutesAgo(3));
    state.users.push(
      user("fr-user", "fr-nightly", minutesAgo(3), { isAdmin: true, apiKeyHash: "h" }),
    );
    mark(state, "fr-user");

    const plan = await planThrowawayPurge(db, {
      now: NOW,
      minAgeMinutes: 30,
      include: ["this-run", "fr-user"],
    });
    expect(byUser(plan)).toEqual({
      "this-run": "delete",
      "other-run": "too_fresh",
      // Named explicitly, and still refused: include never skips identity checks.
      "fr-user": "not_a_throwaway",
    });
  });

  test("nothing minted → an empty plan", async () => {
    const { db } = makeFakeDb();
    expect(await planThrowawayPurge(db, { now: NOW, minAgeMinutes: 0 })).toEqual([]);
  });
});

describe("applyThrowawayPurge", () => {
  test("runs the DELETE /me teardown on stale throwaways and leaves everyone else whole", async () => {
    const { db, state } = makeFakeDb();
    state.users.push(
      user("fr-user", "fr-nightly", minutesAgo(10_000), { isAdmin: true, apiKeyHash: "h" }),
    );
    mark(state, "fr-user");
    state.refreshTokens.push({
      id: "rt-u1",
      userId: "u1",
      familyId: "fam-u1",
      tokenHash: "hash-u1",
      deviceId: "phone",
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      rotatedAt: null,
      revokedAt: null,
      createdAt: NOW,
    });
    mint(state, "old", minutesAgo(120), 2);
    // Whatever else a throwaway could hold goes the way DELETE /me takes it.
    state.deviceTokens.push({
      id: "dt1",
      userId: "old",
      token: "tok",
      platform: "ios",
      environment: "development",
    });
    state.conversations.push({ id: "conv1", userId: "old", turns: [] });
    mint(state, "fresh", minutesAgo(5));
    mint(state, "gone-dirty", minutesAgo(900));
    Object.assign(
      state.users.find((u) => u.id === "gone-dirty")!,
      {
        name: "Deleted account",
        deletedAt: minutesAgo(890),
      },
    );

    const plan = await planThrowawayPurge(db, { now: NOW, minAgeMinutes: 30 });
    const result = await applyThrowawayPurge({ db, now: () => NOW }, plan, "purge-fr-throwaways");
    expect(result).toEqual({ deleted: ["old"], sessionsCleared: ["gone-dirty"] });

    const old = state.users.find((u) => u.id === "old")!;
    expect(old.name).toBe("Deleted account");
    expect(old.deletedAt).toEqual(NOW);
    expect(state.refreshTokens.filter((t) => t.userId === "old")).toHaveLength(0);
    expect(state.deviceTokens.filter((t) => t.userId === "old")).toHaveLength(0);
    expect(state.conversations.filter((c) => c.userId === "old")).toHaveLength(0);
    const deletion = state.decisions.find((d) => d.kind === "account_delete" && d.userId === "old");
    expect(deletion?.rule).toBe("deleted");
    expect(deletion?.inputs).toMatchObject({ via: "purge-fr-throwaways", frThrowaway: true });

    expect(state.refreshTokens.filter((t) => t.userId === "gone-dirty")).toHaveLength(0);
    const cleared = state.decisions.find(
      (d) => d.kind === "account_delete" && d.userId === "gone-dirty",
    );
    expect(cleared?.rule).toBe("fr_throwaway_sessions_cleared");
    expect(cleared?.outcome).toEqual({ ok: true, removed: 1 });

    // Untouched: the FR user, the seeded people, a run's live throwaway.
    for (const id of ["fr-user", "u1", "u2", "fresh"]) {
      const row = state.users.find((u) => u.id === id)!;
      expect(row.deletedAt, id).toBeNull();
      expect(row.name, id).not.toBe("Deleted account");
    }
    expect(state.refreshTokens.map((t) => t.userId).sort()).toEqual(["fresh", "u1"]);
    expect(state.decisions.filter((d) => d.kind === "account_delete")).toHaveLength(2);
  });

  test("a dry run's plan changes nothing until it is applied", async () => {
    const { db, state } = makeFakeDb();
    mint(state, "old", minutesAgo(120));
    const before = structuredClone({ users: state.users, tokens: state.refreshTokens });
    await planThrowawayPurge(db, { now: NOW, minAgeMinutes: 30 });
    expect({ users: state.users, tokens: state.refreshTokens }).toEqual(before);
  });
});
