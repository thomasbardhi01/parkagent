# ios

SwiftUI app (iOS 17+): park detection, location reporting, session UI,
onboarding, and the Card tab. The Xcode project is **generated** — see
"iOS project" in [CLAUDE.md](../CLAUDE.md): edit `project.yml`, then

    cd ios && xcodegen generate

First checkout: `cp Config.example.xcconfig Config.xcconfig` and fill in
`DEVELOPMENT_TEAM` (plus `API_BASE_URL`/`API_KEY` to talk to a real
server; without them the app runs on its mock API).

## Layout

- `ParkAgent/Detection/` — the park detector. `ParkFusionEngine` is the
  pure two-of-three fusion (motion stop, car-audio disconnect, location
  settling; 60 s agreement, 3-min debounce, driving-resume clearing);
  `ParkDetector` wires CoreMotion / AVAudioSession / CoreLocation into it
  and re-arms via significant-change relaunches. `SignalLog` is the
  on-device raw-signal log behind the Debug-menu switch (exported from
  there for field-test forensics — see docs/field-test-checklist.md).
- `ParkAgent/State/` — `AppModel` (single source of app state),
  `PermissionsManager`, `LocationReporter` (60 s /location feed while a
  session is active), `PushManager`.
- `ParkAgent/Networking/` — `APIClient` protocol, `LiveAPI`, and a full
  `MockAPI` with launch-argument scenarios (see
  `Support/LaunchOverrides.swift`) that the UI tests drive.
- `ParkAgent/Views/` — Home (map + status), Sessions, Card, Settings
  (with the Debug menu), Onboarding, Providers (link flow web view).
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
