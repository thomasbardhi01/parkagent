/**
 * Input Postgres refuses (#281), against the real database: the fake DB
 * stores a NUL byte as happily as any other, so only here does the error
 * services/pgErrors.ts reads exist. A NUL in text is 22021, in JSON 22P05,
 * and a request that carries one to a query answers 400, not 500.
 */

import { afterAll, expect, test } from "vitest";

import { isBadInputSqlState, sqlStateOf } from "../../src/services/pgErrors.js";
import { makePgApp, prisma } from "./pgApp.js";

afterAll(() => prisma.$disconnect());

const thrown = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (err: unknown) => err,
  );

test("a NUL in an id is Postgres's 22021, read off Prisma's error", async () => {
  const err = await thrown(prisma.user.findUnique({ where: { id: "a\u0000b" } }));
  expect(err).not.toBeNull();
  expect(sqlStateOf(err)).toBe("22021");
  expect(isBadInputSqlState(err)).toBe(true);
});

test("a NUL in a JSON column is 22P05", async () => {
  const t = await makePgApp();
  const err = await thrown(
    prisma.decision.create({
      data: {
        kind: "pg_bad_input",
        rule: "nul_in_json",
        inputs: { text: "a\u0000b" },
        outcome: {},
        userId: t.user.id,
      },
    }),
  );
  expect(err).not.toBeNull();
  expect(sqlStateOf(err)).toBe("22P05");
  expect(isBadInputSqlState(err)).toBe(true);
});

test("a request whose field carries a NUL to a query answers 400, not 500", async () => {
  const t = await makePgApp();
  // PATCH /me's name is any text up to 100 characters: the backstop is
  // what answers for it.
  const res = await t.app.inject({
    method: "PATCH",
    url: "/me",
    headers: { "x-api-key": t.user.apiKey },
    payload: { name: "a\u0000b" },
  });
  expect(res.statusCode, res.body).toBe(400);
  expect(res.json()).toEqual({ error: "bad_request" });
});

test("a path id with a NUL never reaches Postgres", async () => {
  const t = await makePgApp();
  const res = await t.app.inject({
    method: "POST",
    url: "/parked/a%00b/confirm",
    // As the app sends it: the idempotency hook stores nothing for it, so
    // the route's own 400 answers (the zod tree), not the backstop's.
    headers: { "x-api-key": t.user.apiKey, "idempotency-key": "pg-bad-path-id-0001" },
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(400);
  expect(res.json().error.properties.id).toBeDefined();
});
