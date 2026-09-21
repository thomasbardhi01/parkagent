/**
 * Link jobs are durable: the chained setup-card's poll answer lives in
 * link_jobs, survives a process restart, and a janitor times out rows a
 * dead process left in progress.
 */

import { expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { makeLinkJobJanitor } from "../src/jobs/linkJobJanitor.js";
import {
  API_KEY,
  MONDAY_2PM,
  makeFakeProviderOps,
  makeTestApp,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const NOW = new Date(MONDAY_2PM);

const LINK_BODY = {
  cookies: [{ name: "session", value: "abc", domain: ".nyc.flowbirdapp.com" }],
  set_up_card: true,
  consent_replace_payment_method: true,
};

test("a link job survives a restart: a second app over the same db answers the poll", async () => {
  const t = makeTestApp({ providerOps: () => makeFakeProviderOps() });
  t.state.issuingCards.push({ stripeCardId: "ic_1", userId: "u1" });

  const link = await t.app.inject({
    method: "POST",
    url: "/providers/parknyc/link",
    headers: HEADERS,
    payload: LINK_BODY,
  });
  expect(link.statusCode).toBe(200);
  const { jobId } = link.json();
  expect(jobId).toBeTruthy();
  expect(t.state.linkJobs).toHaveLength(1);

  // "Restart": a fresh app instance over the same database.
  const rebooted = buildApp(t.deps);
  const status = await rebooted.inject({
    method: "GET",
    url: `/providers/parknyc/link-status?jobId=${jobId}`,
    headers: HEADERS,
  });
  expect(status.statusCode).toBe(200);
  // The chained job ran to completion in-process (fake ops), and the
  // rebooted instance reads that durable answer.
  expect(["done", "adding_card"]).toContain(status.json().phase);
});

test("the janitor times out jobs stuck in progress past 15 minutes", async () => {
  const t = makeTestApp({ now: () => NOW });
  t.state.linkJobs.push(
    {
      id: "job-stuck",
      userId: "u1",
      provider: "parknyc",
      phase: "adding_card",
      reason: null,
      retrySafe: null,
      dryRun: null,
      createdAt: new Date(NOW.getTime() - 20 * 60_000),
    },
    {
      id: "job-fresh",
      userId: "u1",
      provider: "parknyc",
      phase: "adding_card",
      reason: null,
      retrySafe: null,
      dryRun: null,
      createdAt: new Date(NOW.getTime() - 5 * 60_000),
    },
    {
      id: "job-done",
      userId: "u1",
      provider: "parknyc",
      phase: "done",
      reason: null,
      retrySafe: null,
      dryRun: null,
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
    },
  );

  const janitor = makeLinkJobJanitor({
    db: t.deps.db,
    log: { info() {}, warn() {} },
    now: () => NOW,
  });
  const timedOut = await janitor.tick();
  expect(timedOut).toBe(1);

  const stuck = t.state.linkJobs.find((j) => j.id === "job-stuck")!;
  expect(stuck).toMatchObject({ phase: "failed", reason: "timeout", retrySafe: true });
  expect(t.state.linkJobs.find((j) => j.id === "job-fresh")!.phase).toBe("adding_card");
  expect(t.state.linkJobs.find((j) => j.id === "job-done")!.phase).toBe("done");

  // The app's poll now gets the settled failure.
  const status = await t.app.inject({
    method: "GET",
    url: "/providers/parknyc/link-status?jobId=job-stuck",
    headers: HEADERS,
  });
  expect(status.json()).toMatchObject({ phase: "failed", reason: "timeout", retrySafe: true });
});
