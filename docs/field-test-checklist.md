# Field-test checklist — per stop, and reading the logs

The per-stop routine and the log-reading reference for any field day.
**`docs/field-test-plan.md` is the plan**: which day is dry run and which is
real money, the switch order, and the go/no-go criteria. This checklist is
written for the dry-run days (`DRY_RUN=true` on Fly, or the policy's
`dry_run: true`). The app detects, quotes, and decides, but no money moves
and you pay the meter by hand as usual.

## Before leaving the house

1. **Server**: `curl https://parkagent-api.fly.dev/health` → `ok: true`
   and `dryRun: true`. If `dryRun` is false, STOP and fix the env before
   driving anywhere.
2. **Zones loaded**: Home at street zoom draws curb lines around you (tap
   one for its rate and zone number), and the Home chip names your city
   when you're in one.
3. **Phone setup** (per phone, both users):
   - Location: Settings → ParkAgent → **Always** (not While Using), with
     **Precise Location on**. Motion & Fitness: on. Notifications: on.
     Background App Refresh: on.
   - Account → Privacy names each one exactly as iOS Settings does
     ("Always", "While Using", …). Home shows a banner for anything
     missing, with the fix one tap away; clear the banners before the drive.
   - Diagnostics → **Run detector self-test** must end in "PASS — ready to
     drive" (it takes a real fix, reads motion history, and checks the
     background wake-ups).
4. **Turn on the signal log** (a Debug build from Xcode — TestFlight builds
   have no Diagnostics): Account (the avatar on Home) → About → tap the version five
   times → Diagnostics → **Log raw detector signals**. This writes every motion, car-audio, and location event
   with a timestamp to a file on the phone; it is the only way to debug
   a missed or false park after the fact.
5. **Payment source** (onboarding "How do you want to pay", or the Wallet
   tab): the default is **Your card on ParkNYC/ParkBoston**
   (`provider_card`), the card already saved on your provider account. On
   that path there is **no ParkAgent card setup**. Linking just captures
   the session, and the executor pays with the account's own card (it
   picks the card on file at the "Your Cards" screen). The **ParkAgent
   card** is always listed, tagged "Coming soon", until the server has
   `ISSUING_LIVE=true`. A Debug build can choose it only with the
   Diagnostics sandbox toggle, which must be off for a field test. **Link**
   reads "coming soon" until the Link OAuth client is set, and it pays
   garages only, never street meters. Daily and per-stop caps apply the
   same whichever card pays.
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
2. **Sit in the car for two minutes first** (FR-55). Nothing may arrive
   while you are in it: no notification, no sheet. If you open the app,
   the Park tab shows the park quietly ("ParkAgent will ask when you walk
   away"). Then walk away. Within about a minute of leaving you should get
   **"Pay $… for zone …?"** with **Pay · Not now · Wrong spot** (only
   where there's something to pay; an unmetered spot or a free period
   stays silent). Note, on paper or in a message to yourself:
   - Did anything arrive while you were still in the car? (It must not.)
   - How far from the car, and how long after leaving, did it arrive?
   - The quoted zone number vs the number **posted on the meter/sign**.
   - The quoted rate and max stay vs the sign.
   - Park once **right in front of where you're going** (under 30 m from
     the door). The prompt must still come: the phone reports that you
     are on foot. If it doesn't within three minutes, note the time and
     the block.
   - Once, long-press the notification with the phone **locked** and tap
     Pay: it must ask for Face ID or the passcode first.
   - Once, tap **Pay in the app while still in the car** (Park tab →
     Review). It must say it pays when you walk away, and the session
     must appear only after you do.
3. **Boston only**: the first park on any block will ask for the zone
   number (`needsZoneNumber`) — read the posted number off the meter and
   enter it. That's the crowdsourced bootstrap working as designed; the
   second user confirming the same number marks it verified.
4. Pay the meter by hand (dry run — the app only says what it *would*
   have paid). Compare its total to what the provider app actually
   charges.
5. While parked, walk a block away and back with the app backgrounded —
   the extension worker's inputs (distance, heading) come from the
   session's location reports (every 25 m moved, at most every 15 s, and a
   60-second heartbeat standing still); you'll read its decisions in the
   evening. **Coming back ends the session** (FR-55): stand at the car for
   a minute, or start driving. Note what the app showed, and check in the
   provider's own app what happened to the meter (New York: stopped;
   Boston: still paid until its end, with nothing more bought). Two that
   must not end it: walking **past** the car without stopping, and sitting
   somewhere within 30 m of it the whole time. If either ends the session,
   note the time: in New York that is a stopped meter you didn't ask for.
6. Drive through at least one red light and one drive-through/pickup lane
   during the day — these must NOT fire a park. If a sheet appears, note
   the time and what you were doing.
7. **A garage, a paid lot, and home** (FR-54). At each, note what you got
   and when:
   - **Garage**: a notification **"Looks like the <garage's name>"** (or
     "Parked in a garage?" when no outline matched), saying ParkAgent
     can't pay drive-up garages yet, with **Not here** and **Not a
     garage**. It must not arrive while you're still rolling: it waits
     until the car has been still for a minute. Underground with no
     signal you get "Parked in a garage?" with no buttons first, and the
     named sheet once the phone is back online.
   - **Paid lot**: **"Parked at <lot's name>"**, with **Not here** and
     **No payment**.
   - **Somewhere the server can't place**: a quiet **"Parked?"** (no
     sound, not time-sensitive) with **Street · Garage · Lot · No
     payment**.
   - **Home / a driveway**: nothing at all, the first time (no zone, no
     outline). Never a "Pay" notice.
   - Open the sheet and answer it truthfully each time. The **second**
     time you park at the same place and give the same answer, it becomes
     a saved place: the third park there is silent (or, for a saved street
     spot, goes straight to the quote). Write down which park was which.
   - Park at the same garage twice in one day: the second park says
     nothing.
   - **The one that must never happen:** a metered spot where the app
     says nothing because it thinks there's nothing to pay. If you park at
     a meter and get no notification within three minutes, note the time
     and the block: that is the bug this whole step is looking for.

## What "working" looks like per signal (in the exported log)

Export: Account → About → version ×5 → Diagnostics → **Export signal log** (share sheet → AirDrop /
Files / mail to yourself). One line per event, v2 format (this PR):
`2026-09-27T14:03:22.512Z location_fix 42.350380,-71.076300 ±6m 0.3m/s`.
Fixes carry coordinates, so an exported log can be replayed through the
engine in a unit test (`ios/Fixtures/Traces/`, `SignalTraceTests`).

- **lifecycle** — `armed`, `wake <reason>` (significantChange, visit…,
  foreground, locationLaunch), `tracking_started`/`tracking_stopped`. No
  `wake` for a whole drive means iOS never woke the app: check Always and
  Background App Refresh.
- **motion** — raw `motion automotive high` lines, then `motion_driving`
  while driving and `motion_stop` shortly after you stop. At a red light
  you should see nothing (CoreMotion stays "automotive" while stopped), or a
  `motion_stop` followed by `driving_resumed_cleared` when you pull away.
  `motion_walking` is you walking away from the car.
- **car audio** — `audio_disconnect carPlay|bluetooth` the moment the car
  lets go of audio. `audio_disconnect_ignored` is Bluetooth dropping with
  no drive behind it (headphones), deliberately not a park signal.
- **location** — a `burst_started`, a run of `location_fix` lines, ending
  in `location_settled` once three fixes agree within 20 m.
  `fix_rejected coarse|stale|outlier` are fixes too vague, too old, or too
  jumpy to say which block (coarse on every fix = Precise Location off).
- **the verdict** — `park_fired <signals>`. A park needs two of motion,
  audio, and location, plus something a red light never does (walking
  away, the car audio dropping, an iOS visit, or 150 s stopped) and a
  precise fix. `park_unlocated` means a park with no fix good enough to
  report (you get a notification saying so). `debounced` is a would-be
  fire inside the 3-minute cooldown.

A missed park = which line never appeared. A false park = which lines
paired that shouldn't have. Say exactly that when reporting the bug.

**Where it parked (FR-53).** Every park is also classified on the phone:

- `entry_fix <fix>` — the last good fix of the car still moving in, logged
  when the stop begins. In a garage it should be at or just inside the
  entrance.
- `gps_lost accuracy ±…m` or `gps_lost silence …s` — GPS went bad on the
  way in (a garage ramp). None on a street park; one then good fixes again
  before the stop is a tunnel, and doesn't count.
- `altimeter_started` / `altimeter_stopped` bracket the stop's window, and
  `altitude <climb>m <pressure>kPa` lines appear only between them. An
  `altitude` line outside that bracket is a battery bug: report it.
- `place_classified <class> <confidence> …` — the verdict: `garage`,
  `lot`, `nopay`, `street`, or `unknown`, with `footprint=`, `memory=`,
  `gps_loss=`, `baro=`, `crawl=`, `located=`. Diagnostics shows the last
  one under **Last place**. On a street park it's normally `unknown` (the
  phone has no zone data; the server decides as always).
- `footprints_fetched n=<count> truncated=0` — the phone fetched the garage
  and lot outlines for the 2 km cell it is driving through (`GET
  /garages/near`), once a week per cell. `footprints_fetched failed` means
  no signal or a refusal; it tries again five minutes later. A garage park
  with no `footprint=` on its `place_classified` line had no outline for
  that garage on the phone: either the cell never fetched (look for the
  line earlier in the drive) or the garage isn't in the table, and it
  reads `garage 0.60` (GPS lost, no footprint) at best.

For each garage, lot, or home park, write down what the place really was
(and the garage's name and level): that plus the exported log is a trace
for `ios/Fixtures/Traces/` with a `<name>.truth.json` sidecar (see
`ios/Fixtures/make-traces.py` for the format).

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
- `executorErrors` (per city): should be `{}` in dry run. Anything here is
  a bug.
- `shadow` — only meaningful with `shadow_mode` on (Boston rehearsal):
  `fired` should equal sessions started, `declined` should be 0.
- `spendUsd` vs what you actually fed meters — the quote accuracy check.

Deeper: `pnpm -C server decisions:recent --city bos --limit 50` (prod:
through the fly proxy, see server/README.md) shows every decision with its
rule, and the `decisions` table has the full inputs. Leave out the `--`
before the flags: pnpm 12 passes it through, and the script rejects it.

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

## After the dry-run days

Track daily: false parks, missed parks, zone accuracy vs signs, and quote
vs actual paid. What happens next is in `docs/field-test-plan.md`: Boston
real money on your own card (#135), then friends in dry run (#139). Real
money anywhere else needs its own paid verification first. ParkBoston's
start, extend, and stop were walked for real in #112/#113, but ParkNYC's
paid `record` run (#24) is still to do.
