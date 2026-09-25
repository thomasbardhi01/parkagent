# Field test plan — 1.0.0

Two days in Boston before anyone else gets the app: day 1 in dry run (the
app does everything except pay), day 2 with real money on your own card
through ParkBoston (`provider_card`). Then a go/no-go on inviting friends.

Use a **Debug build installed from Xcode** on your phone for both days —
it is the only build with Diagnostics (tap the version number in Account →
About five times, then the **Diagnostics** row that appears), which you
need for the signal log and the dry-run readout. `ios/Config.xcconfig` must
point `API_BASE_URL` at prod. Friends get the TestFlight (Release) build,
which has no Diagnostics.

`docs/field-test-checklist.md` has the per-stop routine and how to read the
exported signal log; this plan says what to do on which day and what "good
enough" means.

**Dry run is server-wide.** `DRY_RUN` and the policy's `dry_run` apply to
every account on prod. While real money is on (day 2), nobody else may be
using the app; friends join only while the server is back in dry run.

---

## The night before

1. **Prod runs the build you mean to test.** `main` at `v1.0.0-rc3` or
   later. `curl -s https://parkagent-api.fly.dev/health` must show that
   commit and `"dryRun": true`. After a merge, `waitdeploy <PR>` blocks
   until it does (see CLAUDE.md).
2. **The server has room for the browser.** Paying runs headless Chromium
   on the one Fly machine, and nothing has run the executor on Fly yet.
   The size lives in `fly.toml`'s `[[vm]]` block (1 GB), and every deploy
   re-applies it. Don't use `fly scale memory`: the next merge undoes it.
   Check:

       fly scale show -a parkagent-api      # MEMORY 1024 MB

3. **Install** the Debug build from Xcode (Product → Run on your phone).
   Walk `docs/device-smoke-test.md` top to bottom. Every step must pass.
4. **Diagnostics** (Account → About → version × 5 → Diagnostics):
   - Detection: **Detector: Running**, **Fully armed**.
   - Dry run: **On — no money moves**.
   - ParkAgent card sandbox: **off**.
   - Turn on **Log raw detector signals**, and leave it on for both days.
5. **Wallet**: the hero reads **Your card on ParkBoston** with your card's
   last four. If not, fix the card in the ParkBoston app first.
6. **ParkBoston linked** (Account → Cities & accounts). Linking verifies
   your session in the browser on the Fly machine, so watch
   `fly logs -a parkagent-api` while you link: an out-of-memory kill here
   is a no-go for day 2 until memory is raised.
7. **Pushes land**: with your admin key,

       curl -s -X POST -H "x-api-key: $KEY" https://parkagent-api.fly.dev/admin/push-test | jq '.allAccepted'

   must print `true`, and the samples must show up on the phone.

---

## Day 1 — dry run, Boston

Goal: detection, zone resolution, and quotes are right, end to end, with
nothing charged. Pay every meter yourself as usual.

Aim for at least these stops:

| # | Stop | What it tests |
|---|---|---|
| 1–3 | Three metered blocks you know, ideally one of them zone 456 (Boylston, Dartmouth–Clarendon) | detection, zone number, rate, quote |
| 4 | A metered block whose zone number ParkAgent doesn't know yet | the "zone number needed" flow: type the posted number once |
| 5 | One park after 8 pm (or before enforcement starts) | free period: no notification, nothing to pay |
| 6 | Home or another unmetered spot | stays silent |
| — | At least one long red light and one drive-through or pickup lane | must **not** fire a park |

At each stop (details in the checklist):

1. Park and walk away **without opening the app**.
2. Within a few minutes a **"Parked in zone …"** notification should
   arrive, with the price and "Dry run — nothing will be charged". Note
   how long it took after you turned the car off.
3. Tap it. Compare the zone number, rate, and max stay on the sheet with
   the posted sign. Photograph the sign.
4. Tap **Pay**. In dry run this starts a dry-run session ("would have
   paid"), so the extension worker runs against it. Screenshot the sheet
   and the session.
5. At one stop, walk a few blocks away and stay past the last 12 minutes
   of the session. You should get **"Dry run: extended"** ("Auto-extend
   would have added N min ($X) in zone Z."), or **"Meter expiring"** if a
   cap or the max stay is in the way. Then stop the session in the app.
6. Pay the real meter yourself.

### Send me after day 1

Put these in one message (or a folder):

1. **Your notes**, one row per stop: time, place, notification yes/no and
   delay, zone on the sheet vs the sign, price on the sheet, anything odd.
   Include every red light or drive-through that fired a park by mistake.
2. **The signal log**: Diagnostics → Export signal log.
3. **Photos** of the signs and **screenshots** of the sheets and sessions.
4. **The server's view of the day**:

       curl -s -H "x-api-key: $KEY" https://parkagent-api.fly.dev/admin/summary > day1-summary.json
       fly logs -a parkagent-api --no-tail > day1-fly.log

5. Anything that looked wrong, even if you're not sure, with the time.

---

## Go / no-go for day 2

All must hold, or day 2 waits for a fix:

- Every day-1 stop at a metered block produced the notification within 5
  minutes. A missed park gets a diagnosis from the signal log first.
- **Every zone number matched the posted sign.** One wrong zone means a
  real payment for the wrong meter, and a ticket.
- At most one false park across the red lights and drive-throughs, and
  it's understood from the signal log.
- No crash and no out-of-memory kill in `fly logs`.
- `admin/summary` shows no executor errors: `jq '.cities[].executorErrors'`
  prints only `{}`.

---

## Day 2 — real money, your card on ParkBoston

Goal: the provider actually charges your card, for the zone on the sign,
for the amount ParkAgent recorded, and extensions work. Stay in Boston, on
blocks whose zone numbers are known (day 1's).

### Switch real money on

1. **Nobody else on the app today** (dry run is server-wide).
2. Turn the server switch off first. It restarts the machine, and a
   restart reloads `policy.json` from the image, so anything you set in
   the policy before it is lost:

       fly secrets set DRY_RUN=false -a parkagent-api

3. Keep the caps small: Account → Spending limits, **$10 per stop, $20 per
   day**, and **Default stay 15 min**. There's no per-park duration in the
   app: Pay buys the default stay, capped at the zone's max stay, and the
   image's default is 90 minutes. You're the admin, so you can edit these.
   Tap **Save limits**.
4. Then the policy switch (it keeps the caps you just saved):

       curl -s -H "x-api-key: $KEY" https://parkagent-api.fly.dev/policy \
         | jq '.policy | .dry_run = false' \
         | curl -s -X PUT -H "x-api-key: $KEY" -H 'content-type: application/json' \
             --data @- https://parkagent-api.fly.dev/policy | jq '{dryRun, caps: [.policy.session_cap_usd, .policy.daily_cap_usd]}'

   It must print `"dryRun": false` and caps `[10, 20]`, and Diagnostics
   must show **Dry run: OFF — real money** in red.
5. **Check Diagnostics before every park.** Any restart or redeploy puts
   the policy back to the image's (dry run on, caps $45/$60). That's the
   safe direction for dry run, but it would quietly turn your paid test
   into a dry one — and if you then flip the policy again, re-check the
   caps and the default stay first.

### The stops

| # | Stop | Expect |
|---|---|---|
| 1 | A known block, short stay (the 15-minute default stay) | Pay → a real ParkBoston session; "Meter paid" push; Activity shows meter + fee |
| 2 | Same block or another; stay past the end, walk away | one auto-extension (a real second charge) and a "Session extended" push |
| 3 | Any known block | Stop in the app. ParkBoston has no early stop: the session stays until it runs out, with no refund. That's expected. |

Boston sells time in each zone's own increments (zone 456: 12 minutes), so
a 15-minute request can come back as 12. ParkAgent records the receipt's
amounts, not the quote.

After each paid stop, open the ParkBoston app's parking history and
screenshot the transaction (it has the transaction number).

### Switch real money off, the same day

    fly secrets set DRY_RUN=true -a parkagent-api

That alone restores dry run (effective dry run is `DRY_RUN` OR the
policy's). Also put the policy back, for tidiness:

    curl -s -H "x-api-key: $KEY" https://parkagent-api.fly.dev/policy \
      | jq '.policy | .dry_run = true' \
      | curl -s -X PUT -H "x-api-key: $KEY" -H 'content-type: application/json' \
          --data @- https://parkagent-api.fly.dev/policy | jq '.dryRun'

Confirm: `/health` says `"dryRun": true`, and Diagnostics says **On**.

### Send me after day 2

1. **Receipts**: ParkBoston history screenshots, one per charge, with the
   transaction numbers.
2. **ParkAgent's side**: screenshots of Activity and each session's detail
   (meter, fee, total, timeline).
3. `admin/summary` and `fly logs` for the day, as on day 1.
4. The signal log, your notes, and anything odd.
5. Your card statement lines for the day once they post, to check the
   totals.

---

## Go / no-go for inviting friends

All must hold:

1. **Money matches to the cent.** Every ParkBoston charge appears in
   Activity with the same meter, fee, and total, and there is no charge
   ParkAgent didn't record, and no recorded charge ParkBoston didn't make.
2. **Caps held.** Nothing went over $10 per stop or $20 for the day.
3. **Every paid zone was the zone on the sign.**
4. **Extension worked once for real**, and no extension happened while
   you were walking back to the car.
5. **Dry run is back on**, confirmed on `/health` and in Diagnostics.
6. **No crash, no executor failure** you can't explain, and no
   out-of-memory kill on Fly.
7. **The friend path works on TestFlight.** Install the TestFlight build
   with a *second* Apple ID (not the admin) and go through onboarding: Sign
   in with Apple, permissions, plate, city, **How do you want to pay** (your
   card on the provider, preselected), connect the provider, and the
   **read-only** spending limits step (Continue, no Save). Tapping the
   version number five times must do nothing.
8. Detection and zones are as good as on day 1.

Then invite friends **in dry run**: add them as TestFlight testers and send
them the tester notes in `docs/testflight.md`. They need their own ParkNYC
or ParkBoston account. Keep the server in dry run while anyone but you is
on it. Turning real money on for everyone is a separate decision, after a
dry-run week with friends (`docs/parkagent-nyc-build-plan.md`).

## Tracking

Each day has a GitHub issue in the **Field test** milestone: #67 (Apple
developer setup), #71 (the night before and day 1), and #135 (day 2).
Inviting friends is #139, in the **TestFlight 1.0** milestone. NYC gets
its own dry-run day afterwards (#72).
