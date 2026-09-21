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
# Passport / ParkBoston (the zone number comes from a user report):
pnpm -C executor run record -- --provider passport --flow start --zone 81234 --minutes 15
# Find Parking recon (READ-ONLY, no charge): dump the map's
# zones-by-location feed near a point — number + block name per zone:
pnpm -C executor run record -- --provider passport --flow findParking \
  --query "Boylston St Back Bay" --lat 42.3495 --lng -71.0798
```

Drives one flow against the **real** site, headed, with tracing on, and
saves to `executor/fixtures/<provider>-<flow>-<stamp>/` (gitignored):
`har.har`, `trace.zip`, and a `NN-<step>.html` + `.png` pair per screen.
**`start` and `extend` pay a real meter** — the harness makes you type
`pay` first; use a cheap zone and the minimum duration. (The old
`resolve` flow is gone: the 2026-09-21 recording showed ParkBoston has no
map — signed-in navigation lands on the Enter Zone screen.) Open traces
with `pnpm -C executor exec playwright show-trace <dir>/trace.zip`.

To grow the unit tests, sanitize a recorded page (strip email, plate, card
hints, tokens) and drop it into `test/fixtures/pages/` named for its
expectation — see the README there. Tests are **unit tests against recorded
fixtures only**: no test launches a browser or contacts ParkNYC, and nothing
in this package runs in CI (CI only compiles it for the server's types).

## jQuery Mobile transitions (Passport)

The ParkBoston app animates page transitions (slide/pop/fade), so a
target's box keeps moving and Playwright's actionability check times out.
`PassportClient.stableClick` wraps EVERY click in the flow: it waits for
the active page's transition to finish (no in/out/transition-type classes
on any `.ui-page`) and the target's bounding box to hold still across two
animation frames, scrolls into view, then clicks — retrying once with a
forced click on a stability timeout and logging which path it took
(`options.log`). `activePageSettled` in `parse.ts` is the pure mirror of
the transition check (unit-tested; the bbox stability is live-only).

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

**The Find Parking map IS a zone-number source (corrected 2026-09-21).**
Analyze Boston publishes no ParkBoston zone numbers (every `bos-…` row
starts `""`), and an early recording suggested the signed-in app had no
map. A later signed-in probe (`--flow findParking`) overturned that: the
**Find Parking** screen (`#findParking`) is a real map + "Zone, address
or landmark" search whose list is fed by the `getnearzoneswithoccupancy`
API. With the saved session it returns **every nearby zone's number and
block name** — a Back Bay probe (42.3495, -71.0798) returned 767 zones,
all with distinct numbers and names like "North Boylston between
Dartmouth and Clarendon" (#456). `parseNearbyZones` extracts
`{number, name, lat, lng, distanceFeet}` (pinned by
`test/fixtures/passport/nearby-zones--boylston-back-bay.json`).

Caveat: the feed's coordinates are coarse (this capture: 11 distinct
latitudes / 16 longitudes across 767 zones — a ~1 km grid), so matching
these numbers onto our meter-derived block polygons must key on the
block **name**, not the point. Issue TBD tracks building that importer;
until it lands the server still accepts driver-reported numbers
(`POST /zones/:zoneId/provider-number`) and `startSession` types the
stored number into Enter Zone (input `#zoneNumber`, button `#zoneNext`,
mirrored into `test/fixtures/pages/passport/zone-entry.html`). The
ParkNYC client runs its own **non-fatal map cross-check**; both sides
land on the `decisions` row as `zoneResolution`.

**Enter Zone gotcha (2026-09-21):** a recent-zones panel (`#recentZones`)
pops on input focus and, when the account has recent zones, renders right
after the Continue button (`#zoneNext`) and shifts/overlays it — clicking
Continue then times out. The start flow fills the input, blurs to
collapse the panel, waits for it to hide, then clicks Continue
(`recentZonesState` in `parse.ts` is the pure reading, pinned by the
zone-entry--recent-zones-{visible,hidden} fixtures).

**Duration picker (2026-09-21):** after Length of Stay the app shows
`#durationPickerPage` — day/hour/minute steppers (`#hourPlus`/`#minPlus`,
values in `#hourTimeText`/`#minTimeText`) and `#pickerNext` to continue.
The flow drives the steppers to the requested minutes (minute step
assumed 15, TODO-verify). After `#pickerNext` the app either charges the
default card straight to confirmation (`use_default_card`) or shows the
payment-method page — that next screen stays TODO-verify.

**Review Signage interstitial (2026-09-21):** an optional operator-
configured popup ("check the signage around you for parking restrictions
and meter hours", Continue/Cancel) can appear after Enter Zone. The start
flow clicks Continue when it's present and proceeds when it's absent —
never fails on it. Matched by structure + keyword, not exact wording
(`isSignageModal` in `parse.ts`, pinned by `signage-modal.html`).

**Verification status.** Walked live: the gated entry (Sign In / Register /
Guest), T&C accept, and e-mail verification screens (2026-09-20, headless)
and the Enter Zone screen (2026-09-21, signed in). Everything after zone
submit (zone panel, duration, pay, session, cards) is drafted from the
app's shipped Backbone view source (`js/application/views/*.js` — the
element ids are real, the flows around them are not yet walked) and is
marked TODO-verify in `selectors.ts`. Verify with a signed-in
`record -- --provider passport --flow start` run (pays a real meter) on a
cheap zone before any real use.

## Error taxonomy

| Code | Meaning |
|---|---|
| `auth_expired` | Storage state missing or the provider asked to sign in again |
| `zone_not_found` | The provider rejected the zone number |
| `payment_declined` | The payment step refused |
| `payment_method_missing` | The provider account has no saved payment method — the start flow hit "Add Payment Details" (ParkBoston). The server pushes an "add a card" prompt, not a retry |
| `ui_changed` | An expected screen/element never appeared (capture attached) — includes captcha/bot-check walls, which classify.ts deliberately never reads as `auth_expired` (that would wrongly expire the linked account and push a relink) |
| `network` | Couldn't reach the provider |
| `browser_crashed` | The shared Chromium died mid-call. The executor retries the call ONCE on a fresh context first (warmBrowser relaunches lazily); this code means the retry failed too |
| `unknown` | Anything else |

Account ops (`setupCard` — see the card flow) can additionally return
`unsupported_card_brand`: the Stripe card's brand has no mapping to the
payment form's card-type radio (`brandRadioPattern` in
`src/parknyc/selectors.ts`); it can never appear on a session
start/extend/stop.

On any failure the session stays unpaid and the server sends the
`payment_failed` push with a `parkagent://pay?zone=<zone>` deep link.
