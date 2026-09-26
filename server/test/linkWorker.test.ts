/**
 * The link worker: the whole link runs as a durable job. A slow provider
 * times out under the 45-second budget and retries with backoff until the
 * job is dead-lettered; a restart picks up an attempt it cut off; two
 * workers never run one attempt twice; and the user who moved on gets the
 * outcome as a push.
 */

import { expect, test } from "vitest";

import { LINK_BUDGET_MS, makeLinkWorker } from "../src/jobs/linkWorker.js";
import type { ProviderAccountOps } from "../src/services/providerOps.js";
import {
  API_KEY,
  MONDAY_2PM,
  makeFakeProviderOps,
  makeTestApp,
  testStateCrypto,
} from "./helpers.js";

const HEADERS = { "x-api-key": API_KEY };
const COOKIES = [{ name: "session", value: "abc", domain: ".ppprk.com", path: "/" }];

function appAt(ops: () => ProviderAccountOps) {
  let clock = new Date(MONDAY_2PM);
  const t = makeTestApp({ seedLinkedProvider: false, providerOps: ops, now: () => clock });
  return {
    t,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function startLink(t: ReturnType<typeof makeTestApp>): Promise<string> {
  const res = await t.app.inject({
    method: "POST",
    url: "/providers/passport/link",
    headers: HEADERS,
    payload: { cookies: COOKIES, set_up_card: false },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { jobId: string }).jobId;
}

async function status(t: ReturnType<typeof makeTestApp>, jobId: string) {
  const res = await t.app.inject({
    method: "GET",
    url: `/providers/passport/link-status?jobId=${jobId}`,
    headers: HEADERS,
  });
  return res.json() as Record<string, unknown>;
}

test("a provider past the 45 s budget retries with backoff, then is dead-lettered and says so", async () => {
  let calls = 0;
  const budgets: (number | undefined)[] = [];
  const { t, advance } = appAt(() =>
    makeFakeProviderOps({
      verifyAccount: async (options) => {
        calls += 1;
        budgets.push(options?.budgetMs);
        return { ok: false, code: "timeout", message: "provider did not answer within 45s" };
      },
    }),
  );
  const jobId = await startLink(t);
  await t.linkWorker.tick();

  // Attempt 1: the full budget, a typed timeout, a retry in a minute, and
  // the user will hear the outcome (the app told them "we'll let you know").
  expect(budgets[0]).toBe(LINK_BUDGET_MS);
  let job = await status(t, jobId);
  expect(job).toMatchObject({ phase: "retrying", reason: "timeout", attempt: 1, linked: false });
  expect(t.state.linkJobs[0]!.notify).toBe(true);

  // Not due yet: no hammering.
  await t.linkWorker.tick();
  expect(calls).toBe(1);

  advance(61_000);
  await t.linkWorker.tick();
  expect(calls).toBe(2);
  expect(await status(t, jobId)).toMatchObject({ phase: "retrying", attempt: 2 });

  advance(5 * 60_000 + 1_000);
  await t.linkWorker.tick();
  expect(calls).toBe(3);
  job = await status(t, jobId);
  expect(job).toMatchObject({ phase: "failed", reason: "timeout", retrySafe: true, attempt: 3 });
  const row = t.state.linkJobs[0]!;
  expect(row.deadAt).not.toBeNull();
  expect(row.stateSealed).toBeNull();
  expect(t.state.decisions.at(-1)).toMatchObject({
    kind: "provider_link",
    rule: "link_dead_letter",
  });
  expect(t.pushes.at(-1)!.push).toMatchObject({
    type: "provider_link_failed",
    title: "Couldn't connect ParkBoston",
  });

  // Dead is dead: nothing runs it again.
  advance(60 * 60_000);
  await t.linkWorker.tick();
  expect(calls).toBe(3);
});

test("a retry that succeeds links the account and pushes 'connected' with the card", async () => {
  let calls = 0;
  const { t, advance } = appAt(() =>
    makeFakeProviderOps({
      verifyAccount: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, code: "network", message: "net::ERR_CONNECTION_RESET" }
          : { ok: true, walletBalanceCents: null };
      },
      readSavedCard: async () => ({ ok: true, brand: "Visa", last4: "4242" }),
    }),
  );
  const jobId = await startLink(t);
  await t.linkWorker.tick();
  advance(61_000);
  await t.linkWorker.tick();
  expect(await status(t, jobId)).toMatchObject({ phase: "done", linked: true, cardLast4: "4242" });
  expect(t.state.providerAccounts[0]).toMatchObject({ provider: "passport", status: "linked" });
  expect(t.pushes.at(-1)!.push).toMatchObject({
    type: "provider_linked",
    title: "ParkBoston connected",
    body: "ParkAgent will pay meters with your Visa ••4242 on ParkBoston.",
  });
});

test("the app's 'continue, let me know' asks for a push; watching users get none", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { t } = appAt(() =>
    makeFakeProviderOps({
      verifyAccount: async () => {
        await gate;
        return { ok: true, walletBalanceCents: null };
      },
    }),
  );
  // Watching: finishes with no push.
  const watched = await startLink(t);
  release();
  await t.linkWorker.tick();
  expect(await status(t, watched)).toMatchObject({ phase: "done" });
  expect(t.pushes).toHaveLength(0);

  // Moved on before it finished: the outcome arrives as a push. (No kick,
  // so the job is still pending when the app says it's leaving, as with a
  // slow provider.)
  const { t: t2 } = appAt(() =>
    makeFakeProviderOps({ verifyAccount: async () => ({ ok: true, walletBalanceCents: null }) }),
  );
  t2.deps.linkWorker = undefined;
  const res = await t2.app.inject({
    method: "POST",
    url: "/providers/passport/link",
    headers: HEADERS,
    payload: { cookies: COOKIES, set_up_card: false },
  });
  const jobId = (res.json() as { jobId: string }).jobId;
  const notify = await t2.app.inject({
    method: "POST",
    url: `/providers/passport/link-jobs/${jobId}/notify`,
    headers: HEADERS,
  });
  expect(notify.statusCode).toBe(200);
  expect(notify.json()).toMatchObject({ notify: true });
  await t2.linkWorker.tick();
  expect(t2.pushes.map((p) => p.push.type)).toEqual(["provider_linked"]);
});

test("cookies that aren't a session fail at once, keeping how long the check took", async () => {
  let calls = 0;
  const { t } = appAt(() =>
    makeFakeProviderOps({
      verifyAccount: async () => {
        calls += 1;
        // As the guarded bridge returns it: the executor's timings ride along.
        return {
          ok: false,
          code: "auth_expired",
          message: "Passport asked to sign in; cookies are not a session",
          meta: { queueMs: 0, runMs: 1_550, retries: 0, queuedBehind: 0 },
        } as Awaited<ReturnType<ProviderAccountOps["verifyAccount"]>>;
      },
    }),
  );
  const jobId = await startLink(t);
  await t.linkWorker.tick();
  expect(await status(t, jobId)).toMatchObject({
    phase: "failed",
    reason: "auth_expired",
    retrySafe: false,
  });
  expect(calls).toBe(1);
  expect(t.state.linkJobs[0]!.stages).toMatchObject({ queueMs: 0, verifyMs: 1_550 });
});

test("a restart picks up an attempt it cut off (the lease lapsed)", async () => {
  const { t, advance } = appAt(() =>
    makeFakeProviderOps({ verifyAccount: async () => ({ ok: true, walletBalanceCents: null }) }),
  );
  // A previous process claimed the job and died mid-verification.
  const sealed = testStateCrypto().seal(JSON.stringify({ cookies: COOKIES, origins: [] }));
  t.state.linkJobs.push({
    id: "job-orphan",
    userId: "u1",
    provider: "passport",
    phase: "verifying",
    reason: null,
    retrySafe: null,
    dryRun: null,
    createdAt: new Date(MONDAY_2PM),
    stateSealed: sealed,
    setUpCard: false,
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAt: new Date(MONDAY_2PM),
    lockedUntil: new Date(new Date(MONDAY_2PM).getTime() + 100_000),
    startedAt: new Date(MONDAY_2PM),
    finishedAt: null,
    deadAt: null,
    lastError: null,
    queuePosition: null,
    stages: {},
    notify: false,
    notifiedAt: null,
  });

  // A fresh worker (the new process): the lease is still live, hands off.
  const worker = makeLinkWorker({
    db: t.deps.db,
    policy: t.deps.policy,
    sendPush: t.deps.sendPush,
    stateCrypto: t.deps.stateCrypto,
    providerOps: t.deps.providerOps,
    log: { info() {}, warn() {} },
    now: t.deps.now!,
  });
  await worker.tick();
  expect(t.state.linkJobs[0]!.phase).toBe("verifying");

  advance(101_000);
  await worker.tick();
  expect(t.state.linkJobs[0]).toMatchObject({ phase: "done", attempts: 2 });
  expect(t.state.providerAccounts[0]).toMatchObject({ provider: "passport", status: "linked" });
});

test("two workers never run the same attempt", async () => {
  let calls = 0;
  const { t } = appAt(() =>
    makeFakeProviderOps({
      verifyAccount: async () => {
        calls += 1;
        return { ok: true, walletBalanceCents: null };
      },
    }),
  );
  t.deps.linkWorker = undefined; // no kick: the two workers below race for it
  await startLink(t);
  const second = makeLinkWorker({
    db: t.deps.db,
    policy: t.deps.policy,
    sendPush: t.deps.sendPush,
    stateCrypto: t.deps.stateCrypto,
    providerOps: t.deps.providerOps,
    log: { info() {}, warn() {} },
    now: t.deps.now!,
  });
  await Promise.all([t.linkWorker.tick(), second.tick()]);
  expect(calls).toBe(1);
});

test("a worker holding a stale read can't run an attempt another worker already ran (the backoff holds)", async () => {
  let calls = 0;
  const { t } = appAt(() =>
    makeFakeProviderOps({
      verifyAccount: async () => {
        calls += 1;
        return { ok: false, code: "network", message: "net::ERR_CONNECTION_RESET" };
      },
    }),
  );
  t.deps.linkWorker = undefined;
  await startLink(t);
  // Worker A read the job as due (attempt 0) just before worker B ran it.
  const staleRead = t.state.linkJobs.map((job) => ({ ...job }));
  await t.linkWorker.tick();
  expect(t.state.linkJobs[0]).toMatchObject({ phase: "retrying", attempts: 1, lockedUntil: null });

  const workerA = makeLinkWorker({
    db: { ...t.deps.db, linkJob: { ...t.deps.db.linkJob, findMany: async () => staleRead } },
    policy: t.deps.policy,
    sendPush: t.deps.sendPush,
    stateCrypto: t.deps.stateCrypto,
    providerOps: t.deps.providerOps,
    log: { info() {}, warn() {} },
    now: t.deps.now!,
  });
  await workerA.tick();
  // The lease is free (B released it to back off), but attempt 1 is gone:
  // A's claim names attempt 0 and loses.
  expect(calls).toBe(1);
  expect(t.state.linkJobs[0]).toMatchObject({ phase: "retrying", attempts: 1 });
});

test("while it waits for a browser slot the poll shows its place in line", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const { t } = appAt(() =>
    makeFakeProviderOps({
      verifyAccount: async (options) => {
        const queued = (options as { onQueued?: (ahead: number) => void } | undefined)?.onQueued;
        queued?.(2);
        await hold;
        queued?.(0);
        return { ok: true, walletBalanceCents: null };
      },
    }),
  );
  t.deps.linkWorker = undefined;
  const jobId = await startLink(t);
  const running = t.linkWorker.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await status(t, jobId)).toMatchObject({ phase: "queued", queuePosition: 2 });
  release();
  await running;
  const done = await status(t, jobId);
  expect(done).toMatchObject({ phase: "done" });
  expect(done.queuePosition).toBeUndefined();
});
