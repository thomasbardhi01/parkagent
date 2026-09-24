# ios

SwiftUI app (iOS 17+): park detection, location reporting, session UI,
onboarding, and the Card tab. The Xcode project is **generated** — see
"iOS project" in [CLAUDE.md](../CLAUDE.md): edit `project.yml`, then

    cd ios && xcodegen generate

First checkout: `cp Config.example.xcconfig Config.xcconfig` and fill in
`DEVELOPMENT_TEAM`, `API_BASE_URL`, and `API_KEY`. All three are required:
the app talks to the live server on every build, and without the URL and
key every screen shows its "not connected" state. The mock API activates
only for a launch carrying `-useMockAPI YES` (the UI tests) or inside a
SwiftUI preview — never on a phone.

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
- `ParkAgent/Views/` — Home (map + curb layer + status), Sessions, Card,
  Settings, Onboarding, Providers (link flow web view).
  `Settings/DiagnosticsView.swift` is the hidden developer screen: five
  taps on the version number in About, DEBUG builds only.
- `Tools/make_app_icon.py` regenerates the app icon from the design-system
  colors (`uv run --with pillow ios/Tools/make_app_icon.py`).
- `Support/StripeTopup.swift` — the ONLY file importing the Stripe iOS
  SDK; dry run and the mock never reach it.

## Tests

- `ParkAgentTests` — unit tests (swift-testing). The detector fusion runs
  under injected fake signals and a manual clock; no CoreMotion or GPS.
- `ParkAgentUITests` — XCUITest against the mock API
  (`-uiTesting YES` suppresses real detector/push side effects).

Run both:

    xcodebuild test -project ParkAgent.xcodeproj -scheme ParkAgent \
      -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

(`-only-testing:ParkAgentTests` for the fast unit-only loop.)
