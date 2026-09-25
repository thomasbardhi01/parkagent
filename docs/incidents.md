# Incidents

Short postmortems for anything that took prod down or moved money wrongly.
Newest first. Times are UTC.

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
has been. The `[[vm]]` block in `fly.toml` is re-applied too.

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
