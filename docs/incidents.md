# Incidents

Short postmortems for anything that took prod down or moved money wrongly.
Newest first. Times are UTC.

---

## 2026-09-26: prod API down ~4.5 h on a misnamed Maps secret (Fly v82)

**Impact.** `parkagent-api` served nothing from about 17:31 to 21:59, and
again for about 6 minutes from 23:20. Prod was in dry run, so no money was
affected. Parks detected in those windows got no answer from `/parked`.

**Cause.** Setting up the assistant's Apple Maps search, the Maps key was
set as `APPLE_MAPS_PRIVATE_KEY`, a name the server doesn't read, with
`APPLE_MAPS_KEY_ID` and `APPLE_MAPS_TEAM_ID` under their right names (and,
on the first try, from the wrong .p8). `server/src/env.ts` treated the three
as a set: "APPLE_MAPS_KEY, APPLE_MAPS_KEY_ID, and APPLE_MAPS_TEAM_ID are a
set — set all three or none". Two of three was a refusal to boot:
`loadEnv` printed "Refusing to start" and exited. `fly secrets set` rolls
the machine onto the new settings, the machine crash-looped, and Fly
doesn't roll a failed secrets release back.

The rule existed so a half-configured feature couldn't fail its first
user. It made an optional search feature able to take down the whole API.
Every other optional group (Link, Sign in with Apple, email, Google,
Stripe) had the same kind of rule.

**Timeline.**

| Time | Event |
|---|---|
| 15:12:33 | **v81**: healthy. |
| 17:31:25 | **v82**: a secrets release on v81's image, with the Maps settings above. Crash loop. |
| 21:59:02 | **v83**: #150's deploy, on consistent Maps settings. Healthy. |
| 23:20:26 | **v84**: another secrets release on v83's image. Fails. |
| 23:26:05 | **v85**: a secrets release on the same image. Healthy. |
| 23:52:31 | **v86**: #151's deploy (`44f677e`). Healthy. |
| 2026-09-27 00:59 | Nightly FR against `44f677e`: red on FR-35/36/40 (Maps search, #152, unrelated to the key) and FR-10/11 (suite order, #153). |

Read-only checks afterwards: prod's `APPLE_MAPS_KEY` is the same .p8 as
`APNS_KEY`, under the same key id, and Apple issues Maps tokens for it: one
key with both services enabled, which works. Maps search itself still fails
on a request bug, #152.

**Fix (fix/config-resilience).**
- **Only core settings refuse boot.** That's `DATABASE_URL`,
  `AUTH_JWT_SECRET`, `API_KEY_PEPPER`, and a malformed
  `PROVIDER_STATE_KEY`. An optional feature with a missing, partial, or
  malformed setting is switched off, and one `config: <feature> is off — …`
  line names the variable. `/health` lists it under `degraded`. An
  unreadable `DRY_RUN` runs dry.
- **Contents are checked, not just presence.** A .p8 must parse as an EC
  P-256 private key. The same key in two slots, and a name with one of our
  prefixes that the server doesn't read, are logged by name, the latter with
  "did you mean APPLE_MAPS_KEY?".
- **`pnpm -C server check-secrets NAME=value …`** runs the same checks
  before `fly secrets set`, against the names already on the app. It
  rejects this incident's settings with the right name, and a .p8 whose
  `AuthKey_<id>` file name disagrees with the proposed key id. `--live`
  asks Apple whether the key works.
- **CI** adds `scripts/boot-check.sh broken`: every optional feature
  misconfigured, this incident included. The server must boot and list them
  all as degraded. Against the old `env.ts` that run fails with "Refusing to
  start".
- The new `env.ts` was run against prod's own settings before merging
  (read-only, verdict only): nothing fatal, nothing degraded.

**Still open.**
- A core-setting mistake still takes prod down. `check-secrets` is the
  guard: run it before every `fly secrets set` (CLAUDE.md).
- The #130 items below: `boot` isn't a required status check, and nothing
  rolls a failed release back automatically.

---

## 2026-09-25: prod API down ~31 min after the 1.0.0-rc1 deploy (Fly v70)

**Impact.** `parkagent-api` served nothing from about 16:15 to 16:47. There
is one Fly machine, and a failed deploy leaves it on the failed image, so
nothing else took traffic. Prod was in dry run, so no money was affected.
Parks detected in that window got no answer from `/parked`. The migration
the deploy's `release_command` had already applied
(`20260925120000_apple_refresh_token`, an added column) stayed applied. The
old image ran fine against it.

**Cause.** In #130, `server/src/index.ts` logged a boot notice through a
`log` shim that closed over `const app`, two lines before `app` was
declared:

```ts
if (!appleTokens) log.info("APPLE_SIGNIN_* not set; …");   // index.ts:218
const app = buildApp({ … });                                 // index.ts:220
```

Reading `app` in its temporal dead zone throws `ReferenceError: Cannot
access 'app' before initialization` (`dist/index.js:59`, called from
`:186`). The process died before `listen`, so Fly's `/health` check never
passed. The server's unit tests build the app through `buildApp` with fakes
and never run `index.ts`, so all 629 were green. The crashing branch is the
one where the `APPLE_SIGNIN_*` secrets are **unset**.

**Timeline.**

| Time | Event |
|---|---|
| 15:46 | #130 squash-merged (`45d4f37`). CI starts. |
| 16:12 | `deploy` job starts after `ios` passes. |
| 16:14:56 | Fly release **v70** created. The release command migrates. The machine is updated to the new image and crash-loops. |
| 16:21 | `deploy` fails: "timeout reached waiting for health checks to pass" (CI run 36156453068). The machine stays on v70. |
| 16:39:23 | **v71**: same image after a secrets change. It crashes the same way, because unsetting `APPLE_SIGNIN_*` is the crashing branch. |
| 16:46:39 | **v72**: rollback to v69's image. `/health` answers again. |
| 17:25 | #133 merged (`2a930c4`) with the fix and a CI boot check. |
| 17:44:08 | **v73**: #133 deployed. Tagged `v1.0.0-rc2`. |
| 17:45 | Nightly FR suite dispatched against `2a930c4`: green. |

**How it was found.** The CI `deploy` job failed on Fly's health-check
timeout. The machine's log (`fly logs -a parkagent-api`) had the
`ReferenceError` stack.

**Rollback.** This is the procedure, also in CLAUDE.md:

```sh
fly releases -a parkagent-api --image        # find the last good release's image
fly deploy -a parkagent-api --image registry.fly.io/parkagent-api:deployment-<id>
curl -s https://parkagent-api.fly.dev/health  # commit is the old one, ok: true
```

A rollback redeploys only the image. Migrations aren't reverted, so this
works only while the new migrations are additive. Every migration so far
has been. The `[[vm]]` block in `fly.toml` (machine size) is re-applied
too.

**Fix (#133).** `app.ts` gained `createFastify()`, which returns the bare,
logger-configured instance. `index.ts` creates `app` right after
`loadEnv()`, so `app.log` exists before anything that logs at boot, and
`buildApp(deps, app)` attaches the routes later.

**Prevention.** CI has a new `boot` job:
- It brings up a PostGIS service and runs `prisma migrate deploy`.
- It then runs `scripts/boot-check.sh off` and `on`. Each boots
  `node dist/index.js` and asserts that `/health` is ok, that
  `/auth/methods` matches the mode, and that the process is still up 8
  seconds later.
- `deploy` now `needs: [server, boot, ios]`.

Against the broken build, only the **off** run failed (every optional var
unset). The on run passed. That's why both run, and why every new optional
env var goes into both lists in `boot-check.sh`.

**Still open.**
- `boot` gates deploy but isn't a required status check on `main`. Only
  `server`, `ios`, and `executor` are, so a PR could merge with a red boot
  check. The deploy just wouldn't run.
- CI's rolling deploy on one machine has no automatic rollback. A failed
  health check leaves prod down until someone runs the rollback above.
