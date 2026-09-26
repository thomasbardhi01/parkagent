/**
 * Idempotency keys: an unsafe request (POST/PUT/PATCH/DELETE) that carries
 * `Idempotency-Key` runs once per (user, key), and its first answer is its
 * answer. The app sends one key per action and reuses it on every
 * automatic retry, so a response lost in a tunnel — or a phone that gave
 * up at its own timeout while the server went on to pay — is fetched
 * again instead of paying again.
 *
 *  - First sight: the key is claimed (`in_progress`), the route runs, and
 *    its status and body are stored (`done`) — errors included: a 502
 *    from the provider is as much an answer as a 200.
 *  - Same key, same request, done → the stored answer, marked
 *    `Idempotent-Replayed: true`. Nothing runs.
 *  - Same key, same request, still running → 409 `request_in_progress`
 *    with `retryAfterSeconds`; the app waits and asks again.
 *  - Same key, different request → 422 `idempotency_key_reused`.
 *  - A claim older than ten minutes that never finished (the process died
 *    mid-request) may be taken over by the next retry.
 *
 * Requests without the header behave exactly as before. Keys are per
 * user (the auth hook runs first) and kept for 24 hours.
 */

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppDb } from "../db.js";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** An unfinished claim this old belonged to a request that died. */
export const IDEMPOTENCY_STALE_MS = 10 * 60_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Answers that must never sit in a table: a card number and CVC (the Link
 * reveal — "never store card numbers" is a non-negotiable), Stripe client
 * secrets, an OAuth state. These routes keep their own one-shot semantics;
 * a key sent with them is ignored, and the app neither keys nor retries
 * them.
 */
const NEVER_STORED = [
  /^\/link\/spend-requests\/[^/]+\/card$/,
  /^\/wallet\/setup-intent$/,
  /^\/card\/funding\/topup-intent$/,
  /^\/link\/connect$/,
];

declare module "fastify" {
  interface FastifyRequest {
    /** Set when this request claimed an idempotency key. */
    idempotencyClaim?: { id: string } | undefined;
  }
}

/** Sorted keys at every level, so formatting can't change the hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method} ${path}\n${canonical(body ?? null)}`)
    .digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

export function registerIdempotency(
  app: FastifyInstance,
  deps: { db: AppDb; now?: () => Date },
): void {
  const now = () => deps.now?.() ?? new Date();

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers[IDEMPOTENCY_HEADER];
    if (header === undefined || !UNSAFE.has(req.method) || !req.authedUser) return;
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !KEY_PATTERN.test(key)) {
      return reply.code(400).send({ error: "invalid_idempotency_key" });
    }
    const userId = req.authedUser.id;
    const path = req.url.split("?")[0] ?? req.url;
    if (NEVER_STORED.some((pattern) => pattern.test(path))) return;
    const hash = requestHash(req.method, path, req.body);
    const at = now();

    try {
      const row = await deps.db.idempotencyKey.create({
        data: {
          userId,
          key,
          method: req.method,
          path,
          requestHash: hash,
          state: "in_progress",
          createdAt: at,
        },
      });
      req.idempotencyClaim = { id: row.id };
      return;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    const existing = await deps.db.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!existing) {
      // Swept between the insert and the read: treat as a fresh conflict.
      return reply.code(409).send({ error: "request_in_progress", retryAfterSeconds: 1 });
    }
    if (existing.requestHash !== hash) {
      return reply.code(422).send({ error: "idempotency_key_reused" });
    }
    if (existing.state === "done" && existing.statusCode !== null) {
      return reply
        .code(existing.statusCode)
        .header("content-type", "application/json; charset=utf-8")
        .header("idempotent-replayed", "true")
        .send(existing.response ?? "");
    }
    // Still running. A claim that never finished — the process died — may
    // be taken over, once, by whoever asks first.
    if (at.getTime() - existing.createdAt.getTime() >= IDEMPOTENCY_STALE_MS) {
      const taken = await deps.db.idempotencyKey.updateMany({
        where: { id: existing.id, state: "in_progress", createdAt: existing.createdAt },
        data: { createdAt: at, requestHash: hash },
      });
      if (taken.count === 1) {
        req.log.warn({ idempotencyKey: existing.id }, "took over an abandoned idempotent request");
        req.idempotencyClaim = { id: existing.id };
        return;
      }
    }
    return reply.code(409).send({ error: "request_in_progress", retryAfterSeconds: 2 });
  });

  // The answer, stored as it leaves — whatever it is.
  app.addHook("onSend", async (req, reply, payload) => {
    const claim = req.idempotencyClaim;
    if (!claim) return payload;
    req.idempotencyClaim = undefined;
    const body =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf8")
          : null;
    try {
      if (body === null) {
        // A stream (the assistant's SSE) can't be replayed: release the key.
        await deps.db.idempotencyKey.delete({ where: { id: claim.id } });
      } else {
        await deps.db.idempotencyKey.update({
          where: { id: claim.id },
          data: { state: "done", statusCode: reply.statusCode, response: body, completedAt: now() },
        });
      }
    } catch (err) {
      // Never fail the response over its bookkeeping; the claim goes stale
      // and a retry can take it over.
      req.log.warn({ err }, "idempotency answer not stored");
    }
    return payload;
  });
}

/** Keys older than a day are gone; the app never retries that late. */
export function makeIdempotencyJanitor(deps: {
  db: AppDb;
  now?: () => Date;
  log: { warn: (msg: string) => void };
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const sweep = async () => {
    const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - IDEMPOTENCY_TTL_MS);
    try {
      await deps.db.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });
    } catch (err) {
      deps.log.warn(`idempotency sweep failed: ${String(err)}`);
    }
  };
  return {
    sweep,
    start(intervalMs = 60 * 60_000) {
      timer ??= setInterval(() => void sweep(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
