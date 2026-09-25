# ios

SwiftUI app (iOS 17+): park detection, location reporting, session UI,
onboarding, Activity, and the Wallet. The Xcode project is **generated** — see
"iOS project" in [CLAUDE.md](../CLAUDE.md): edit `project.yml`, then

    cd ios && xcodegen generate

First checkout: `cp Config.example.xcconfig Config.xcconfig` and fill in
`DEVELOPMENT_TEAM` and `API_BASE_URL`. Both are required: the app talks to
the live server on every build, and without the URL sign-in fails with a
"not configured" message (and Home shows its "not connected" banner). There
is no `API_KEY` — the app authenticates as the signed-in user, with tokens
in the Keychain. The mock API activates only for a launch carrying
`-useMockAPI YES` (the UI tests) or inside a SwiftUI preview — never on a
phone.

## Layout

- `ParkAgent/Detection/` — the park detector. `ParkFusionEngine` is the
  pure two-of-three fusion (motion stop, car-audio disconnect, location
  settling; 60 s agreement, 3-min debounce, driving-resume clearing);
  `ParkDetector` wires CoreMotion / AVAudioSession / CoreLocation into it
  and re-arms via significant-change relaunches. `SignalLog` is the
  on-device raw-signal log behind the Diagnostics switch (exported from
  there for field-test forensics — see docs/field-test-checklist.md).
- `ParkAgent/State/` — `AppModel` (single source of app state),
  `PermissionsManager`, `LocationReporter` (60 s /location feed while a
  session is active), `PushManager`.
- `ParkAgent/Networking/` — `APIClient` protocol, `LiveAPI`, and a full
  `MockAPI` with launch-argument scenarios (see
  `Support/LaunchOverrides.swift`) that the UI tests drive.
- `ParkAgent/Views/` — Auth (the welcome / sign-in screen), Home (the
  Park tab: map + curb layer + status, and the avatar that opens the
  Account sheet), Activity (every session, garage, and Link payment from
  the server's ledger, with map, timeline, and receipt), Wallet (how you
  pay — three ways, one active — parking accounts, spending, activity;
  `WalletCopy.swift` is the one source of payment wording), Account
  (profile, cars, cities and connected accounts, limits, how you pay,
  privacy, sign out, delete), Onboarding, Providers (link flow web view). `Settings/DiagnosticsView.swift` is the hidden developer screen:
  five taps on the version number in the Account sheet's About section,
  DEBUG builds only.
- `Tools/make_app_icon.py` regenerates the app icon from the design-system
  colors (`uv run --with pillow ios/Tools/make_app_icon.py`).
- `Support/StripeWallet.swift` — the ONLY file importing the Stripe iOS
  SDK: saves the ParkAgent card's funding card (Apple Pay / PaymentSheet
  SetupIntent); the mock never reaches it.

## Tests

- `ParkAgentTests` — unit tests (swift-testing). The detector fusion runs
  under injected fake signals and a manual clock; no CoreMotion or GPS.
- `ParkAgentUITests` — XCUITest against the mock API
  (`-uiTesting YES` suppresses real detector/push side effects).

Run both:

    xcodebuild test -project ParkAgent.xcodeproj -scheme ParkAgent \
      -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

(`-only-testing:ParkAgentTests` for the fast unit-only loop.)
