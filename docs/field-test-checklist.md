# Field-test checklist — Boston and NYC dry-run days

What to do, in order, when taking ParkAgent out in the car for the first
time in each city. Everything runs in **dry run** (`policy.json
dry_run: true` AND env `DRY_RUN=true` on Fly): the app detects, quotes,
and decides, but no money moves and you pay the meter by hand as usual.

## Before leaving the house

1. **Server**: `curl https://parkagent-api.fly.dev/health` → `ok: true`
   and `dryRun: true`. If `dryRun` is false, STOP and fix the env before
   driving anywhere.
2. **Zones loaded**: Home at street zoom draws curb lines around you (tap
   one for its rate and zone number), and the Home chip names your city
   when you're in one.
3. **Phone setup** (per phone, both users):
   - Location: Settings → ParkAgent → **Always** (not While Using).
   - Motion & Fitness: on. Notifications: on.
   - If either is off, Home shows a banner with an Open Settings button —
     clear the banners before the drive.
4. **Turn on the signal log**: Account (the avatar on Home) → About → tap the version five
   times → Diagnostics → **Log raw detector signals**. This writes every motion, car-audio, and location event
   with a timestamp to a file on the phone; it is the only way to debug
   a missed or false park after the fact.
5. **Payment source** (onboarding "How do you want to pay", or the Wallet
   tab): the default is **My card on ParkNYC/ParkBoston** —
   `provider_card`, the card already saved on your provider account. On
   that path there is **no ParkAgent card setup and no Add money step**:
   linking just captures the session and the executor pays with the
   account's own card (it picks the card on file at the "Your Cards"
   screen). The **ParkAgent card** option only appears when the server has
   `ISSUING_LIVE=true`; until then it reads "coming soon". Daily and
   per-stop caps apply the same either way — the choice only moves where
   the charge lands. If you switch sources, re-link isn't required, but a
   switch to the ParkAgent card needs a fresh setup-card (consent prompt in
   the link flow).
6. **Provider link** (needed even in dry run — session start refuses
   without it): Account → Cities & accounts → connect ParkNYC (NYC) or ParkBoston
   (Boston). ParkBoston sign-in is passwordless: T&C accept, e-mail/phone
   code, then a 4-digit PIN. On the `provider_card` default the link flow
   shows "the card already saved on your account keeps paying" instead of
   the card-replacement consent, and finishes without a card-setup job.
7. Note the time you leave. Everything in the decisions table is
   timestamped; knowing "I parked around 2:10" is how you find the rows.

## The drive (each parking stop)

1. Park normally. Turn the car off, unplug/step away as you normally
   would. **Don't open the app first** — the point is unattended
   detection.
2. Within a few minutes of walking away you should get a **"Parked in
   zone …"** notification (only where there's something to pay — an
   unmetered spot or a free period stays silent). Tap it for the sheet.
   Note, on paper or in a message to yourself:
   - Did it fire at all? How long after shutdown?
   - The quoted zone number vs the number **posted on the meter/sign**.
   - The quoted rate and max stay vs the sign.
3. **Boston only**: the first park on any block will ask for the zone
   number (`needsZoneNumber`) — read the posted number off the meter and
   enter it. That's the crowdsourced bootstrap working as designed; the
   second user confirming the same number marks it verified.
4. Pay the meter by hand (dry run — the app only says what it *would*
   have paid). Compare its total to what the provider app actually
   charges.
5. While parked, walk a block away and back with the app backgrounded —
   the extension worker's inputs (distance, heading) come from the
   60-second location reports; you'll read its decisions in the evening.
6. Drive through at least one red light and one drive-through/pickup lane
   during the day — these must NOT fire a park. If a sheet appears, note
   the time and what you were doing.

## What "working" looks like per signal (in the exported log)

Export: Account → About → version ×5 → Diagnostics → **Export signal log** (share sheet → AirDrop /
Files / mail to yourself). One line per event:
`2026-09-27T14:03:22.512Z motion_stop`.

- **motion** — `motion_driving` while driving; `motion_stop` shortly
  after you park and start walking. At a red light you should see either
  nothing, or a `motion_stop` followed by `driving_resumed_cleared` when
  you pull away (that clearing is what stops false parks).
- **car audio** — `audio_disconnect` the moment the car (CarPlay or
  Bluetooth) lets go of audio, i.e. when you turn the car off. If you
  never see it, check the phone was actually connected to the car.
- **location** — a run of `location_fix ±Nm` lines right after motion or
  audio (the burst), ending in `location_settled ±Nm` once three fixes
  agree within 20 m. In an urban canyon expect larger ±N and a slower
  settle.
- **the verdict** — `park_fired motion_stop+location_settled` (any two
  names) when the event was reported; `debounced` when a would-be fire
  was inside the 3-minute cooldown.

A missed park = which of the three lines never appeared. A false park =
which two lines paired that shouldn't have. Say exactly that when
reporting the bug.

## During/after the day: /admin/summary

From any machine with your api key:

    curl -H "x-api-key: $KEY" https://parkagent-api.fly.dev/admin/summary | jq

Watch for:

- `cities.<city>.parks` ≈ the number of times you actually parked, and
  `detectorSignals` roughly 2–3 signal names per park. `unknownZone` > 0
  in a metered area means zone data gaps — note where you were.
- `declines` — every `confirm`-producing rule fired today
  (`candidates_disagree` means the two-sides-of-the-street prompt;
  `needs_zone_number` is normal for fresh Boston blocks).
- `executorErrors` — should be empty in dry run; anything here is a bug.
- `shadow` — only meaningful with `shadow_mode` on (Boston rehearsal):
  `fired` should equal sessions started, `declined` should be 0.
- `spendUsd` vs what you actually fed meters — the quote accuracy check.

Deeper: `pnpm -C server decisions:recent -- --city bos --limit 50`
(prod: through the fly proxy, see server/README.md) shows every decision
with its rule; the `decisions` table has the full inputs.

**Push notifications** — before relying on them in the field, confirm they
actually land on the phone:

    curl -X POST -H "x-api-key: $KEY" https://parkagent-api.fly.dev/admin/push-test | jq

sends a sample of each push type
(`session_started`/`session_extended`/`session_expiring`/`payment_failed`/`provider_relink`)
to every device registered to your key and reports the APNs status per
device. Watch for `allAccepted: true`; a `reason` like `"BadDeviceToken"`
or `"Unregistered"` means the token is stale (open the app to re-register)
and the server has already dropped it.

## Reporting a bug

Open a GitHub issue (repo `thomasbardhi01/parkagent`, label `bug` + the
area label `ios`/`server`/`executor`/`data`) with:

1. **When and where**: timestamp (with timezone) and the block/corner.
2. **What happened vs expected** — one sentence each.
3. **The evidence**:
   - detector issues → attach the exported signal log (trim to ±10 min);
   - quote/zone issues → the `decisionId` from the app sheet, or the
     matching `decisions:recent` line, plus a photo of the posted sign;
   - executor issues → the decision row's `outcome.code`, and note that
     `ui_changed` rows carry a screenshot in the decisions table.
4. What the provider's own app showed (zone, price) if you cross-checked.

## After the dry-run week (per the build plan)

Track daily: false parks, missed parks, zone accuracy vs signs, quote vs
actual paid. When a few days run clean: week 2 is `dry_run: false` with
every session on one-tap confirm, executor live, extensions capped at
one — and before that flip, both providers need one verified PAID
`record` run (see executor/README.md) so the post-zone screens stop
being TODO-verify.
