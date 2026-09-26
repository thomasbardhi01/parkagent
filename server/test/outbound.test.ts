/**
 * Outbound calls have deadlines. A third party that accepts the connection
 * and never answers used to hold its caller forever: a sign-in email, a
 * garage search, and — worst — an APNs push awaited inside a session start
 * or an extension holding its lock.
 */

import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, expect, test } from "vitest";

import { postNotification } from "../src/services/apns.js";
import { fetchWithTimeout } from "../src/services/http.js";

// A server that takes the request and never answers.
const silent = createServer(() => {});
let url = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  silent.closeAllConnections();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

test("a fetch to a server that never answers gives up at its deadline", async () => {
  const started = Date.now();
  await expect(fetchWithTimeout(url, {}, 200)).rejects.toThrow(/timeout|aborted/i);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("the caller's own abort still works", async () => {
  const controller = new AbortController();
  const pending = fetchWithTimeout(url, { signal: controller.signal }, 10_000);
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toThrow(/abort/i);
});

/** A stand-in for an HTTP/2 session: `answer` says what the request does. */
function fakeHttp2(answer: "never" | "ok") {
  let destroyed = false;
  const connect = () => {
    const client = Object.assign(new EventEmitter(), {
      request: () => {
        const req = Object.assign(new EventEmitter(), {
          setEncoding: () => {},
          end: () => {
            if (answer === "ok") {
              setTimeout(() => {
                req.emit("response", { ":status": 200 });
                req.emit("end");
              }, 5);
            }
          },
        });
        return req;
      },
      close: () => {},
      destroy: () => {
        destroyed = true;
      },
    });
    return client as never;
  };
  return { connect, destroyed: () => destroyed };
}

test("an APNs connection that never answers is torn down at the deadline", async () => {
  const fake = fakeHttp2("never");
  const started = Date.now();
  await expect(
    postNotification("apns.test", "jwt", "bundle", "token", {}, fake.connect, 100),
  ).rejects.toThrow(/did not answer within 100 ms/);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(fake.destroyed()).toBe(true);
});

test("an APNs answer in time resolves and leaves nothing behind", async () => {
  const fake = fakeHttp2("ok");
  await expect(
    postNotification("apns.test", "jwt", "bundle", "token", {}, fake.connect, 1_000),
  ).resolves.toEqual({
    status: 200,
    body: "",
  });
  expect(fake.destroyed()).toBe(false);
});
