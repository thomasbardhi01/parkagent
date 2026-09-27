# Reliability

How ParkAgent stays correct when the phone, the network, a provider, or the
server misbehaves. Four PRs on 2026-09-25/26 came out of one round of device
feedback:

| PR | Problem found on the phone |
|---|---|
| 1/4 (#145) | Detection with the app closed |
| 3/4 (#146) | Linking ParkBoston "couldn't reach the server" |
| 4/4 (#150) | "Couldn't save to the server" on limits |
| 2/4 (this) | Requests that die with the network |

Each rule below names the code that keeps it and the test that pins it.

## The rules

1. **An action happens once, however many times it's sent.**
   - Every unsafe request from the app carries an `Idempotency-Key`. The
     server runs a key once and answers every retry with the first answer
     (`server/src/services/idempotency.ts`; server/API.md "Idempotency keys").
   - The app keeps one key per action across its own retries
     (`ios/ParkAgent/Networking/LiveAPI.swift` `send`). The park outbox keeps
     one across app launches.
   - What a key can't cover:
     - Sign-in calls (no user yet): these are never retried.
     - Answers that carry secrets (a card reveal, a Stripe client secret):
       never stored, never retried.
     - The executor's own pay click: never retried after it, key or not
       (`afterPayClick`, executor/README.md).
2. **A lost answer is fetched again, not redone.**
   - A payment gets 100 s per attempt and 180 s in all.
   - When an attempt times out, the retry under the same key either
     replays the finished result or hears `request_in_progress` and waits.
   - The phone therefore learns what happened to a payment the server
     finished after the phone stopped listening. Before this it said "Could
     not reach the server" about a meter that was paid.
3. **A lost refresh answer doesn't sign anyone out.**
   - The same phone may present the token it just rotated, within 60 s,
     while the successor is unused (`authService.ts`
     `reissueLostRotation`).
   - Anything else is still theft, and the whole family dies.
4. **Retries only for what a retry can change.**
   - Retried: timeouts, dropped connections, gateway errors (502/503/504),
     and "still running", with backoff (0.5, 1.5, 3 s plus jitter), within
     the call's budget.
   - Never retried: a 4xx, a named refusal, or a 500 (the replay would
     only repeat it).
   - Cancelled tasks stop at once and report `.cancelled`, not "Could not
     reach the server".
5. **Nothing waits forever.**
   - **App:** reads 20 s per attempt and 45 s in all; writes 30 s and 60 s;
     payments 100 s and 180 s. The launch gate gives the server 4 s. A
     provider link offers "Continue — we'll let you know" after 20 s and
     finishes as a background job with a 45 s budget per attempt.
   - **Server, outbound:** APNs 8 s, Stripe 20 s, Resend 10 s, Nominatim,
     ParkWhiz and SpotHero 8 s, Link 15 s, database pool 10 s
     (`test/outboundScan.test.ts` fails a bare `fetch`).
   - **Server, the executor:**
     - each Playwright step has 20 s;
     - a session call waits at most 45 s for a browser slot, then fails
       `busy` (nothing ran);
     - a provider failing three times in a row opens its circuit breaker
       (`provider_unavailable`, nothing ran) for 60 s, doubling up to
       10 min.
6. **Nothing is lost when the phone has no signal.**
   - A park reported with no connection goes to an on-disk outbox
     (`ParkOutbox.swift`) and is sent when the network returns, the app is
     foregrounded, or detection starts. It is sent under its original key,
     and a park that's still fresh shows its sheet.
   - Location fixes aren't queued: the next fix supersedes an old one.
   - Detection signals are persisted on the phone (PR 1) and survive a
     relaunch.
7. **Nothing is lost when the server restarts.**
   - Provider links and Apple token revocations are durable jobs. They
     are leased and claimed with a compare-and-set, back off, and are
     dead-lettered into `/admin/summary` (PR 3).
   - Idempotency claims that a dead process left behind can be taken
     over after 10 minutes.
   - On SIGTERM:
     1. the server stops taking requests;
     2. it finishes those in flight and the job passes in flight;
     3. only then does it close the browser and the database.

     This happens within 25 s; `fly.toml` allows 30 s
     (`services/shutdown.ts`; `scripts/boot-check.sh` requires exit 0).
8. **Readiness is real.**
   - `/health/ready` pings the database, and Fly routes traffic by it.
   - `/health` stays the build-identity check that deploys wait on.
9. **Money paths fail typed, and the words match the fact.**
   - "Nothing ran" codes (`busy`, `provider_unavailable`, `auth_expired`, …)
     tell the user nothing was paid.
   - Anything that may have happened after the pay click says "not
     confirmed — check your parking app", never "unpaid".
   - Holds settle on what the card was actually authorized, not on the
     error code.
10. **Each user's limits are their own.**
    - `policy.json` caps are ceilings.
    - Every cap check reads `policyFor(user)`
      (`test/limitsScan.test.ts`; PR 4).
11. **A settings mistake switches a feature off, never the server.**
    - Only the core refuses boot: `DATABASE_URL`, `AUTH_JWT_SECRET`,
      `API_KEY_PEPPER`, and a malformed `PROVIDER_STATE_KEY`
      (`server/src/env.ts`).
    - An optional feature with a missing, partial, or malformed setting is
      off, gets one `config: <feature> is off — …` log line naming the
      variable, and is listed in `/health`'s `degraded`. An unreadable
      `DRY_RUN` runs dry.
    - Check values with `pnpm -C server check-secrets` before `fly secrets
      set`. CI boots the server with every feature misconfigured
      (`scripts/boot-check.sh broken`).

## When something goes wrong in production

| Symptom | Look at | Likely cause |
|---|---|---|
| Machine crash-loops, `/health` dead | `fly logs`, "Refusing to start: invalid core settings" | A core setting missing or malformed: `DATABASE_URL`, `AUTH_JWT_SECRET`, `API_KEY_PEPPER`, `PROVIDER_STATE_KEY` |
| `/health` lists `degraded` | `fly logs`, `config: <feature> is off —` | That feature's setting is missing, partial, or malformed (the line names it). Fix it with `check-secrets` first |
| `/health` fine, `/health/ready` 503 | Database status | Neon suspended or unreachable; Fly stops routing until it answers |
| Links pile up retrying | `/admin/summary` `providers.passport` | The provider is slow or down; the breaker state and the p95s say which |
| "Still finishing that on the server" | `idempotency_keys` for the user | The first attempt is still running (a slow provider); it answers when done |
| Dead-lettered link or revoke | `/admin/summary` `deadLetters` | Read `lastError`; re-link, or revoke by hand |

## Fault-injection coverage

- **Server:**
  - `idempotency.test.ts`: a lost answer, still running, a reused key, an
    abandoned claim, secrets never stored.
  - `auth.test.ts`: a lost refresh answer.
  - `outbound.test.ts`: a server that never answers, a stalled APNs.
  - `shutdown.test.ts`: order and deadline.
  - `health.test.ts`: a database that's down or hung.
  - `linkWorker.test.ts`: timeouts, backoff, dead letter, a restart
    mid-attempt, two workers.
  - `circuitBreaker.test.ts`, `executorGate.test.ts`.
- **Executor:** `navigate.test.ts` (transient page loads, never after the
  pay click), `retry.test.ts`, `budget.test.ts`, `gatedEntry.dom.test.ts`
  (a sign-in screen drawn late).
- **iOS:**
  - `LiveAPIRequestTests`: the same key on retry, waiting out an in-flight
    payment, no retries for verdicts or sign-in, cancellation, per-call
    timeouts.
  - `ParkOutboxTests`.
  - `ProviderLinkModelTests`: dropped polls, continuing in the background.
  - Detection replays of real traces (PR 1).
- **Live:** FR-41 (`server/fr/55-reliability.fr.test.ts`) replays a keyed
  park against the deployed server every night.
