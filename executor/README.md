# executor

Playwright scripts that drive the ParkNYC web app — the only module in this
repo allowed to touch ParkNYC. The server reaches it exclusively through
`server/src/services/parknycExecutor.ts`, which implements the same
`Executor` protocol as the dry-run executor.

> **Personal-use prototype, not a shipping integration.** This automates
> ParkNYC's consumer web app with the owner's own account, for the owner's
> own parking. That sits outside the app's intended use and likely its
> Terms of Service — acceptable only as a personal experiment, never as a
> product. **Issue #37** tracks moving this package to a private repo; it
> must move before any customer uses it. There is no public ParkNYC API;
> when a real integration path exists, this package is the part to replace.

## One-time setup

```sh
pnpm install                              # workspace deps
pnpm -C executor exec playwright install chromium   # the browser itself
pnpm -C executor run login                    # see below
```

## Login (auth without credentials in the repo)

`pnpm -C executor run login` opens a **headed** browser on the ParkNYC sign-in
page. Sign in by hand — credentials never touch code, env, or disk — then
press Enter in the terminal. The session's cookies/localStorage are saved as
Playwright `storageState` to `PARKNYC_STATE_PATH` (default:
`executor/storageState.json`, gitignored, chmod 600).

When ParkNYC expires the session, executor calls start returning
`auth_expired`: just run login again and (for prod) re-set the Fly secret.

### Wiring the server to it

| Env var | Meaning |
|---|---|
| `PARKNYC_STATE_PATH` | Path to the storage-state file. Required for the real executor; without it every session uses the dry-run executor (with a warning when `DRY_RUN=false`). |
| `PARKNYC_STATE_JSON` | Prod only: the file's *contents* as a Fly secret; the server writes them to `PARKNYC_STATE_PATH` at boot (Fly machines have no persistent disk). |
| `PARKNYC_PLATE` | Plate to park when a call doesn't name one; else ParkNYC's first saved vehicle. |
| `EXECUTOR_CAPTURE_DIR` | Optional: unexpected-screen evidence also written here as files (it always rides along on the `decisions` row). |
| `EXECUTOR_LLM_RECOVERY` | `true` enables the (currently stubbed) LLM recovery hook — see `src/parknyc/recovery.ts`. Default off. |

`executorFor()` picks the real executor only when env `DRY_RUN=false` **and**
`PARKNYC_STATE_PATH` is set; the per-call effective dry-run flag
(env ‖ policy.json) still routes any dry-run call to the DryRunExecutor.

## Recording fixtures

```sh
pnpm -C executor run record -- --flow start --zone 110436 --minutes 15
pnpm -C executor run record -- --flow extend --session <providerSessionId>
pnpm -C executor run record -- --flow stop --session <providerSessionId>
```

Drives one flow against the **real** site, headed, with tracing on, and
saves to `executor/fixtures/<flow>-<stamp>/` (gitignored): `har.har`,
`trace.zip`, and a `NN-<step>.html` + `.png` pair per screen. **`start` and
`extend` pay a real meter** — the harness makes you type `pay` first; use a
cheap zone and the minimum duration. Open traces with
`pnpm -C executor exec playwright show-trace <dir>/trace.zip`.

To grow the unit tests, sanitize a recorded page (strip email, plate, card
hints, tokens) and drop it into `test/fixtures/pages/` named for its
expectation — see the README there. Tests are **unit tests against recorded
fixtures only**: no test launches a browser or contacts ParkNYC, and nothing
in this package runs in CI (CI only compiles it for the server's types).

## When ParkNYC changes its UI

1. Every selector lives in `src/parknyc/selectors.ts`, grouped by screen —
   a UI change is a one-file fix. Prefer `getByRole`/visible text over CSS.
2. Re-record the affected flow, adjust the selector, and if a message or
   receipt changed wording, update `classify.ts` / `parse.ts` patterns and
   refresh the fixture pages so the tests pin the new reality.
3. Unrecognized screens don't crash: the executor captures a screenshot +
   visible text, returns `ui_changed`, and the server attaches both to the
   `decisions` row — that capture is your repro.

The flows in `src/parknyc/client.ts` were drafted before the first
recording; the duration-stepper increment, URLs, and receipt patterns carry
`TODO` markers to verify on the first `record` run.

## Error taxonomy

| Code | Meaning |
|---|---|
| `auth_expired` | Storage state missing or ParkNYC asked to sign in again |
| `zone_not_found` | ParkNYC rejected the zone number |
| `payment_declined` | The payment step refused |
| `ui_changed` | An expected screen/element never appeared (capture attached) |
| `network` | Couldn't reach ParkNYC |
| `unknown` | Anything else |

On any failure the session stays unpaid and the server sends the
`payment_failed` push with a `parkagent://pay?zone=<zone>` deep link.
