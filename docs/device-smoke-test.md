# Device smoke test — after every install from Xcode

Twelve checks, in order, on the phone itself. They go cheapest-first and
build on each other: each one assumes the ones above it passed. If a check
fails, stop there — the ones below it will mislead you.

Prerequisites: `ios/Config.xcconfig` has your `DEVELOPMENT_TEAM` and
`API_BASE_URL` (there is no `API_KEY` any more), and `cd ios && xcodegen
generate` has been run since the last `project.yml` change.

For a **fresh** run (onboarding from the top), delete the app from the
phone first — see "Reinstalling for a fresh onboarding" at the bottom.

---

### 1. The icon is the coral P

On the home screen, before opening anything. Ink square, coral P. A blank
white or grey tile means the asset catalog didn't compile into the build —
reinstall rather than continuing.

### 2. It opens on your city, not New York

Launch. A fresh install lands on the **welcome screen** with one button,
Sign in with Apple (email and Google stay hidden while the server has them
switched off). Never a "not connected" banner here: if sign-in says the
app isn't configured, `API_BASE_URL` is missing. After
sign-in you land on the first setup step you haven't done, or Home.

Home's map should settle on **where you are** within a second or
two, and the chip at the top should read your city (e.g. "Boston · No
active session"). If the map opens on Manhattan, the location fix failed
and it fell back to a city default — check Location permission (step 3).

### 3. Permissions are actually granted

Home → the avatar (top right) → Account → Privacy. Location should read
**Allowed**, Motion **Allowed**. Then iOS Settings → ParkAgent → Location must say **Always**,
not "While Using". While Using means no background detection: the whole
unattended-park loop is off, and Diagnostics (step 11) will list
`Location (Always)` as missing.

### 4. Real data, not fixtures

Activity tab. On a fresh account this must be **empty** ("No activity
yet"). If you see "Boylston St · Zone 456" at $4.10 or a "Deck on
Clarendon" garage, the app is running on mock fixtures — stop and report
it.

Wallet tab: on a fresh account expect "Your card on <your provider>" as
the way you pay, $0.00 spent, and no balance anywhere — there is no
stored balance to show.

### 5. The server is the one you think it is

Home → avatar → Account → scroll to About → tap the version number **five
times** → Diagnostics → Server. Check:

- **API base** matches the server you deployed to.
- **Commit** matches what you just deployed (not `dev`, not `mock`).
- **Client** says `Live`. If it says `MOCK`, the build was launched with a
  test argument.
- **Dry run** — read it out loud. `On` means nothing can move money. `OFF`
  is shown in red for a reason.

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

Card and Sessions tabs: scroll to the very bottom. The last row must be
fully visible and tappable above the floating tab bar. The Account sheet
covers the tab bar; its last row (Version) must scroll fully into view. Switch tabs a few
times quickly — you should never see two screens superimposed.

### 11. The detector is armed

Diagnostics → Detection. Expect **Detector: Running** and "Fully armed".
If it lists missing permissions, fix them before driving — detection needs
any two of motion stop, car-audio disconnect, and location settling, and
without Location Always you are down to one.

Turn on **Log raw detector signals** here before a field-test drive; it is
the only way to debug a missed or false park afterwards.

### 12. A park, end to end

Diagnostics → **Simulate park here**. The parked sheet should appear within
a second or two with a real quote for a zone near you — the zone number,
the rate, the total, and "Pays through <your provider>". In dry run it also
says "Dry run — no money moves".

If it says the provider isn't linked, that's correct behavior for an
unlinked account: tap through the link flow and try again.

Dismiss with "Not parked here" — nothing should be left behind on the
Sessions tab.

---

## Reinstalling for a fresh onboarding

Onboarding is gated on what is actually true (permissions, a stored
vehicle and city, and a linked provider), so simply reinstalling over the
top will skip straight to Home if the phone still satisfies all of that.
To walk it from the start:

1. **Delete the app from the phone** — long-press the icon → Remove App →
   Delete App. This is what clears the stored vehicle, city, and the
   permission grants; a plain Xcode reinstall does not.
2. In Xcode: Product → Run (⌘R) with your phone selected.
3. Accept the permission prompts as they come, or the first onboarding step
   will keep asking for them.

Two faster options that don't need a delete:

- **Diagnostics → Reset onboarding** clears the vehicle, city, and the
  completion flag on this phone. You land back on the welcome screen
  immediately. Permissions stay granted (iOS only asks once), so the
  permissions step will show them already on.
- **iOS Settings → ParkAgent** → set Location to "Never" or turn Motion
  off, then relaunch: the truth gate sends you to the permissions step.

Whichever you use, the provider link and everything else server-side is
untouched — resetting onboarding on the phone does not unlink your parking
account.
