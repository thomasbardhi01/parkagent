# executor

Playwright scripts that drive the parking providers' web apps — ParkNYC
(Flowbird, `src/parknyc/`) and ParkBoston (Passport, `src/passport/`) — the
only module in this repo allowed to touch them. The server reaches it
exclusively through `server/src/services/parknycExecutor.ts`, which
implements the same `Executor` protocol as the dry-run executor.

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
pnpm -C executor run login -- --provider passport   # ParkBoston
```

## Login (auth without credentials in the repo)

`pnpm -C executor run login [-- --provider parknyc|passport]` opens a
**headed** browser on the provider's sign-in page. Sign in by hand —
credentials never touch code, env, or disk (ParkBoston is passwordless:
accept the T&C, then an e-mail/phone code, then a 4-digit PIN) — then press
Enter in the terminal. The session's cookies/localStorage are saved as
Playwright `storageState` to `executor/storageState.json` (parknyc) or
`executor/storageState.passport.json` (passport), both gitignored,
chmod 600. The `record` script reads those files; the **server** no longer
does — its executor auth is the per-user linked provider account
(`POST /providers/:provider/link`, sealed under `PROVIDER_STATE_KEY` in
`provider_accounts` — see server/API.md "Provider accounts").

When ParkNYC expires a linked session, executor calls start returning
`auth_expired`: the account flips to `expired` and the user gets a
`provider_relink` push to sign in again in the app.

### Wiring the server to it

| Env var | Meaning |
|---|---|
| `PROVIDER_STATE_KEY` | 32 bytes base64 (`openssl rand -base64 32`); seals linked provider session state. Without it linking is off and real executor calls fail typed. |
| `PARKNYC_PLATE` | Plate to park when a call doesn't name one; else ParkNYC's first saved vehicle. |
| `EXECUTOR_CAPTURE_DIR` | Optional: unexpected-screen evidence also written here as files (it always rides along on the `decisions` row). |
| `EXECUTOR_LLM_RECOVERY` | `true` enables the (currently stubbed) LLM recovery hook — see `src/parknyc/recovery.ts`. Default off. |

`executorFor({userId, city, dryRun})` picks the real executor only when the
per-call effective dry-run flag (env ‖ policy.json) is false AND the user
has a `linked` account for the city's provider; each call decrypts that
account's cookies into a fresh context on one warm shared Chromium process.

## Recording fixtures

```sh
pnpm -C executor run record -- --flow start --zone 110436 --minutes 15
pnpm -C executor run record -- --flow extend --session <providerSessionId>
pnpm -C executor run record -- --flow stop --session <providerSessionId>
# Passport / ParkBoston:
pnpm -C executor run record -- --provider passport --flow resolve --lat 42.3495 --lng -71.0798
pnpm -C executor run record -- --provider passport --flow start --lat 42.3495 --lng -71.0798 --street "BOYLSTON ST" --minutes 15
```

Drives one flow against the **real** site, headed, with tracing on, and
saves to `executor/fixtures/<provider>-<flow>-<stamp>/` (gitignored):
`har.har`, `trace.zip`, and a `NN-<step>.html` + `.png` pair per screen.
**`start` and `extend` pay a real meter** — the harness makes you type
`pay` first; use a cheap zone and the minimum duration. `resolve` drives
ONLY the map-based zone resolution (no payment screen), so it is the safe
first recording to make in Boston. Open traces with
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

## Passport / ParkBoston (`src/passport/`)

Passport runs the **same white-label web app for many cities** — ParkBoston
is `bostonma.ppprk.com/park/`, other Passport cities live at their own
`<city>.ppprk.com` subdomains — so this client is reusable for another
Passport city by swapping the base URL (`passportUrls(base)` in
`src/passport/selectors.ts`; `PassportExecutorOptions.baseUrl`).

**Map-based zone resolution.** Analyze Boston publishes no ParkBoston zone
numbers (every `bos-…` zone row stores `""`), so the client resolves the
zone from the provider's own map: it feeds the car's fix through browser
geolocation, opens `#findParking`, clicks the pin nearest the (car-centered)
viewport, follows the info window to the zone panel, and reads the zone
number and street off `#zi_zoneno` / `#zi_zoneName`. If the panel's street
doesn't match the street our zone data carries (`zones.street`,
normalized/suffix-canonicalized — `src/passport/parse.ts`), it refuses with
`zone_mismatch` instead of paying the wrong block. The ParkNYC client runs
the same resolution as a **non-fatal cross-check** against its stored zone
number; both sides land on the `decisions` row as `zoneResolution`.

**Verification status.** Investigated headlessly on 2026-09-20: the gated
entry (Sign In / Register / Guest), T&C accept, and e-mail verification
screens were walked live; every signed-in flow (map, zone panel, duration,
pay, session, cards) is drafted from the app's shipped Backbone view source
(`js/application/views/*.js` — the element ids are real, the flows around
them are not yet walked) and is marked TODO-verify in `selectors.ts`.
Verify with a signed-in `record -- --provider passport --flow resolve` run
before any real use.

## Error taxonomy

| Code | Meaning |
|---|---|
| `auth_expired` | Storage state missing or the provider asked to sign in again |
| `zone_not_found` | The provider rejected the zone number (or no pins near the car) |
| `zone_mismatch` | The provider map's zone street disagrees with our zone data |
| `payment_declined` | The payment step refused |
| `ui_changed` | An expected screen/element never appeared (capture attached) |
| `network` | Couldn't reach the provider |
| `unknown` | Anything else |

On any failure the session stays unpaid and the server sends the
`payment_failed` push with a `parkagent://pay?zone=<zone>` deep link.
