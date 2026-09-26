# Device smoke test — after every install from Xcode

Twelve checks, in order, on the phone itself. They go cheapest-first and
build on each other: each one assumes the ones above it passed. If a check
fails, stop there — the ones below it will mislead you.

Prerequisites: `ios/Config.xcconfig` has your `DEVELOPMENT_TEAM` and
`API_BASE_URL` (there is no `API_KEY` any more), and `cd ios && xcodegen
generate` has been run since the last `project.yml` change.

For a **fresh** run (onboarding from the top), sign out and delete the app
from the phone first. See "Reinstalling for a fresh onboarding" at the bottom.

---

### 1. The icon is the coral P

On the home screen, before opening anything. Ink square, coral P. A blank
white or grey tile means the asset catalog didn't compile into the build —
reinstall rather than continuing.

### 2. It opens where you are

Launch. Signed out, the app lands on the **welcome screen** with one button,
Sign in with Apple (email and Google stay hidden while the server has them
switched off). Never a "not connected" banner here: if sign-in says the
app isn't configured, `API_BASE_URL` is missing. After
sign-in you land on the first setup step you haven't done, or Home.

Home's map should settle on **where you are** within a second or
two and follow you, and the chip at the top should read your city (e.g.
"Boston · No active session"). While it looks for you it says "Finding
your location…". If it can't, it says so, e.g. "Showing Boston —
location is off" with a Retry. It never quietly shows a city center as
if it were you. Check Location permission (step 3).

### 3. Permissions are actually granted

Home → the avatar (top right) → Account → Privacy. Each row names the
state exactly as iOS Settings does. Expect **Location: Always**, **Precise
Location: On**, **Motion & Fitness: Allowed**, **Notifications: Allowed**,
and **Background App Refresh: On**. Tapping a row asks iOS right there if
it still will, otherwise it opens this app's page in Settings (the
notification page for Notifications).

"While Using" means parks are only noticed while the app is open. Home
shows a banner saying so, with **Allow Always** (iOS's own upgrade prompt,
once per install) or **Open Settings** once that prompt is spent.

### 4. Real data, not fixtures

Activity tab. On a fresh account this must be **empty** ("No activity
yet"). If you see "Boylston St · Zone 456" at $4.10 or a "Deck on
Clarendon" garage, the app is running on mock fixtures — stop and report
it.

Wallet tab: on a fresh account expect "Your card on <your provider>" as
the way you pay, $0.00 spent, and no balance anywhere — there is no
stored balance to show.

### 5. The server is the one you think it is

On your Mac: `curl -s https://parkagent-api.fly.dev/health` (or whatever
`API_BASE_URL` in `ios/Config.xcconfig` points at). The `commit` must be
what you just deployed, not an older one.

Then on the phone: Home → avatar → Account → scroll to About → tap the
version number **five times** → tap the **Diagnostics** row that appears.
Read **Dry run** out loud:
`On` means nothing can move money; `OFF` is shown in red for a reason.
It is the *effective* flag (the server's `DRY_RUN` or the policy's), so
it can say On while `/health` says the env half is off.

A Release (TestFlight) build has no Diagnostics: five taps do nothing.

### 6. Curb lines and their terms

Home, zoomed in to street level. Metered blocks draw as thin lines: coral
where you'd be paying right now, green where it's currently free. Tap one
— a card appears above the spend row with the rate, max stay, today's
hours, and the zone number. Tap the ✕ to dismiss.

No lines at all at street zoom, in a metered area, means `/zones/near`
isn't answering — check step 5.

### 7. The map follows you, and comes back

Walk (or drive) a block with Home open: the map should follow. Then drag
the map away — following stops and the locate-me button (right edge) goes
hollow. Tap it: the map returns to you and the button fills again. Tap the
city chip: the map pulls back to a city-wide view.

### 8. The mic doesn't crash the app

Home → "Ask ParkAgent" → tap the mic. On the **first** launch after a
fresh install iOS asks for Speech Recognition and Microphone; tap Allow to
both. The app must stay up. (A crash the instant you tap Allow is the
Swift 6 off-main-callback bug — it should be fixed, and this is the check
that proves it.)

Say a short sentence: words appear as you speak, a countdown starts when
you stop, and the transcript lands in the input field for editing. Nothing
is sent until you tap send.

### 9. The assistant answers about where you actually are

In that same sheet, ask for something near you ("park me near the Seaport
at 2 for two hours"). The reply must name plausible local streets and
zones. NYC zone numbers for a Boston question means the app sent a fixture
location — report it.

While the reply streams, tap the input field: the keyboard must not cover
the newest message, and the header must stay solid over the scrolled
transcript.

### 10. Nothing hides under the tab bar

Activity and Wallet tabs: scroll to the very bottom. The last row must be
fully visible and tappable above the floating tab bar. The Account sheet
covers the tab bar; its last row (Version) must scroll fully into view. Switch tabs a few
times quickly. The screen must swap at once, never showing two screens
superimposed. iOS 26's cross-dissolve is switched off for this app.

### 11. The detector is armed

Diagnostics → Detection. Expect **Detector: Running (idle)** (or
tracking, if you're moving), every capability row in its good state,
"Background wake-ups: Significant-change on, visits on", and "Fully
armed". Then tap **Run detector self-test**: every line should be green,
ending in **PASS — ready to drive**. A red line names what to fix. Without
Location Always, no park can fire with the app closed.

Turn on **Log raw detector signals** here before a field-test drive; it is
the only way to debug a missed or false park afterwards.

### 12. The sandbox switch is off

Diagnostics → ParkAgent card: **ParkAgent card sandbox** must be **off**
for a field test (it lets a Debug build choose the ParkAgent card against
a Stripe test key). Wallet → the ParkAgent card row then reads "Coming
soon", as it does for everyone on a Release build.

There is no simulated park any more: a real park is the test. Park at a
meter with the app in the background and a **"Parked in zone …"**
notification should arrive within a few minutes (see
`docs/field-test-plan.md`).

---

## Reinstalling for a fresh onboarding

Onboarding is gated on what is actually true: permissions, a car **on the
account** (the server), the city chosen on this phone, and a linked
provider. So reinstalling over the top skips straight to Home if all of
that still holds. To walk it from the start:

1. **Sign out first** (Account → Sign out). iOS can keep Keychain items
   across an app delete, and the session tokens live in the Keychain. If
   you skip this, a reinstall may come back signed in and skip Welcome.
2. **Delete the app from the phone**: long-press the icon → Remove App →
   Delete App. This clears the city and the permission grants on this
   phone. A plain Xcode reinstall does not.
3. In Xcode: Product → Run (⌘R) with your phone selected.
4. Accept the permission prompts as they come, or the first onboarding step
   will keep asking for them. Your car and provider link live on your
   account, so those steps show them already set.

Two faster options that don't need a delete:

- **Diagnostics → Reset onboarding** clears the city, the local copy of
  the car, and the completion flag on this phone. It doesn't sign you out.
  You land back in setup at the first missing step, normally **City**.
  Permissions are still granted, and the car is still on your account, so
  those steps are skipped.
- **iOS Settings → ParkAgent** → set Location to "Never" or turn Motion
  off, then relaunch: the truth gate sends you to the permissions step.

Whichever you use, the provider link and everything else server-side is
untouched — resetting onboarding on the phone does not unlink your parking
account.
