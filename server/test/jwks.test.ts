/**
 * The JWKS cache behind Apple/Google sign-in. An issuer rotates keys and
 * the first token signed with the new one names a kid the cache has never
 * seen: the verifier forces a refetch. That refetch must actually happen
 * (it used to return the same cache, failing every sign-in for up to an
 * hour), but not on every request — made-up kids mustn't become a JWKS
 * request each.
 */

import { expect, test } from "vitest";

import { JWKS_CACHE_MS, JWKS_MIN_REFETCH_MS, makeJwksFetcher } from "../src/services/idToken.js";

function fakeIssuer() {
  let kid = "old";
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ keys: [{ kty: "RSA", kid, n: "n", e: "AQAB" }] }));
  }) as typeof fetch;
  return {
    fetchImpl,
    rotate: (next: string) => (kid = next),
    get calls() {
      return calls;
    },
  };
}

test("an unknown kid after a rotation forces a real refetch", async () => {
  const issuer = fakeIssuer();
  const clock = { ms: 0 };
  const fetchKeys = makeJwksFetcher("https://issuer.test/keys", {
    fetchImpl: issuer.fetchImpl,
    now: () => clock.ms,
  });
  expect((await fetchKeys()).keys[0]!.kid).toBe("old");

  issuer.rotate("new");
  clock.ms += JWKS_MIN_REFETCH_MS + 1;
  // Unforced: still the cache (it's well inside the hour).
  expect((await fetchKeys()).keys[0]!.kid).toBe("old");
  // Forced: the new key.
  expect((await fetchKeys({ force: true })).keys[0]!.kid).toBe("new");
  expect(issuer.calls).toBe(2);
});

test("forced refetches are rate-limited, and the cache still expires hourly", async () => {
  const issuer = fakeIssuer();
  const clock = { ms: 0 };
  const fetchKeys = makeJwksFetcher("https://issuer.test/keys", {
    fetchImpl: issuer.fetchImpl,
    now: () => clock.ms,
  });
  await fetchKeys();
  // A burst of tokens naming made-up kids inside the minute: no refetches.
  for (let i = 0; i < 20; i += 1) await fetchKeys({ force: true });
  expect(issuer.calls).toBe(1);

  clock.ms += JWKS_CACHE_MS;
  await fetchKeys();
  expect(issuer.calls).toBe(2);
});

test("concurrent cold fetches share one request", async () => {
  const issuer = fakeIssuer();
  const fetchKeys = makeJwksFetcher("https://issuer.test/keys", { fetchImpl: issuer.fetchImpl });
  await Promise.all([fetchKeys(), fetchKeys(), fetchKeys()]);
  expect(issuer.calls).toBe(1);
});
