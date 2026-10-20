/**
 * Anthropic API failures on /assistant/message: billing, auth, rate limit,
 * and overload answer 503 assistant_unavailable with the reason (not a
 * bare 500 that reads like our bug), and a billing or auth failure puts
 * "assistant" in /health's degraded until a turn succeeds. The fakes
 * throw the SDK's own error classes, built the way the SDK builds them.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";

import { classifyModelError } from "../src/services/assistant/anthropicClient.js";
import type { ModelClient } from "../src/services/assistant/loop.js";
import { API_KEY, makeTestApp } from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const REQUEST_ID = "req_011CSHoEeqs5C35K2UUqR7Fy";

/** What the SDK throws for an HTTP error response. */
function httpError(status: number, type: string, message: string): Anthropic.APIError {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    undefined,
    new Headers({ "request-id": REQUEST_ID }),
  );
}

/** What the SDK throws for an `error` event mid-stream: a type, no status. */
function streamError(type: string, message: string): Anthropic.APIError {
  const body = { type: "error", error: { type, message } };
  return new Anthropic.APIError(
    undefined,
    body,
    undefined,
    new Headers({ "request-id": REQUEST_ID }),
    type as Anthropic.APIError["type"],
  );
}

const CREDIT =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

/** Throws `failure` until it is set to null, then answers. */
function switchableModel(failure: unknown): ModelClient & { failure: unknown } {
  const model = {
    failure,
    async create() {
      if (model.failure !== null) throw model.failure;
      return { content: [{ type: "text" as const, text: "Where to?" }], stopReason: "end_turn" };
    },
  };
  return model;
}

function ask(t: ReturnType<typeof makeTestApp>, stream = false) {
  return t.app.inject({
    method: "POST",
    url: "/assistant/message",
    headers: stream ? { ...HEADERS, accept: "text/event-stream" } : HEADERS,
    payload: { text: "park me near the museum" },
  });
}

async function degraded(t: ReturnType<typeof makeTestApp>): Promise<string[]> {
  const res = await t.app.inject({ method: "GET", url: "/health" });
  return res.json().degraded as string[];
}

describe("POST /assistant/message when the provider fails", () => {
  test.each([
    ["billing", httpError(400, "invalid_request_error", CREDIT)],
    ["billing", httpError(402, "billing_error", "Billing problem on this account.")],
    ["auth", httpError(401, "authentication_error", "invalid x-api-key")],
    ["auth", httpError(403, "permission_error", "Not allowed for this credential.")],
    ["rate_limit", httpError(429, "rate_limit_error", "Number of request tokens exceeded.")],
    ["overloaded", httpError(529, "overloaded_error", "Overloaded")],
    ["overloaded", streamError("overloaded_error", "Overloaded")],
  ])("%s → 503 assistant_unavailable with the reason (%#)", async (reason, err) => {
    const t = makeTestApp({ assistantModel: switchableModel(err) });
    const res = await ask(t);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "assistant_unavailable", reason, requestId: REQUEST_ID });
  });

  test.each([
    ["bad_request", httpError(400, "invalid_request_error", "messages: roles must alternate")],
    ["unknown", httpError(500, "api_error", "Internal server error")],
  ])("%s stays a 500: it's ours to fix, or not a provider outage", async (kind, err) => {
    expect(classifyModelError(err)?.kind).toBe(kind);
    const t = makeTestApp({ assistantModel: switchableModel(err) });
    const res = await ask(t);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });

  test("an error that isn't the provider's is still a 500, and /health stays clean", async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'content')");
    expect(classifyModelError(bug)).toBeNull();
    const t = makeTestApp({ assistantModel: switchableModel(bug) });
    const res = await ask(t);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(await degraded(t)).toEqual([]);
  });

  test("a streamed turn's error event carries the same body", async () => {
    const t = makeTestApp({
      assistantModel: switchableModel(httpError(400, "invalid_request_error", CREDIT)),
    });
    const res = await ask(t, true);
    expect(res.body).toContain(
      `event: error\ndata: ${JSON.stringify({
        error: "assistant_unavailable",
        reason: "billing",
        requestId: REQUEST_ID,
      })}`,
    );
  });
});

describe("GET /health and the assistant", () => {
  test("lists assistant after a billing failure, until a turn succeeds", async () => {
    const model = switchableModel(httpError(400, "invalid_request_error", CREDIT));
    const t = makeTestApp({ assistantModel: model });
    expect(await degraded(t)).toEqual([]);

    expect((await ask(t)).statusCode).toBe(503);
    expect(await degraded(t)).toEqual(["assistant"]);

    model.failure = null;
    expect((await ask(t)).statusCode).toBe(200);
    expect(await degraded(t)).toEqual([]);
  });

  test("an auth failure shows for 15 minutes; a rate limit doesn't show", async () => {
    let at = new Date("2026-10-20T15:00:00Z");
    const model = switchableModel(httpError(401, "authentication_error", "invalid x-api-key"));
    const t = makeTestApp({ assistantModel: model, now: () => at });

    await ask(t);
    at = new Date("2026-10-20T15:14:59Z");
    expect(await degraded(t)).toEqual(["assistant"]);
    at = new Date("2026-10-20T15:15:00Z");
    expect(await degraded(t)).toEqual([]);

    model.failure = httpError(429, "rate_limit_error", "Number of request tokens exceeded.");
    expect((await ask(t)).statusCode).toBe(503);
    expect(await degraded(t)).toEqual([]);
  });
});
