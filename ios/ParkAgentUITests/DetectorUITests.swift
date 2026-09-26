import CoreLocation
import XCTest

/// The real detector, end to end, in the simulator: real iOS permission
/// prompts, real CoreLocation fed from the test route
/// (Fixtures/drive-park-walk.gpx) through XCUIDevice.location, and the mock
/// server counting what arrives (root.detectorProbe). The simulator has no
/// motion coprocessor, so `-detectorSimulation` derives motion from the
/// route's own speed; everything downstream of that is the shipping code.
final class DetectorUITests: ParkAgentUITestCase {
    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    /// Onboarding asks While Using, and the moment it's granted asks for
    /// Always, so iOS shows "Change to Always Allow" right then.
    func testOnboardingAsksWhileUsingThenAlwaysWithTheRealPrompts() {
        let app = grantLocationAlwaysThroughOnboarding()
        waitForLabelContaining(element(app, "onboarding.permission.location.state"), "Always")
        app.terminate()
    }

    /// Drive, stop at a red light, drive on, park, walk 300 m away and back:
    /// one park (not at the light), and the session's location reports
    /// show the walk away and the return.
    func testTheDetectorFiresOnceAlongTheRouteAndReportsTheWalkAway() throws {
        grantLocationAlwaysThroughOnboarding().terminate()
        let route = try RouteFixture.load(from: Bundle(for: DetectorUITests.self))

        // Start at the route's first point before the app arms.
        setLocation(route.points[0])
        let app = launchApp(
            scenario: "singleQuote",
            capabilities: nil,
            // The signal log is on so a run can be kept as a replay fixture
            // (see Fixtures/Traces).
            extraArguments: ["-detectorSimulation", "YES", "-detectorSignalLogEnabled", "YES"]
        )
        let probe = element(app, "root.detectorProbe")
        XCTAssertTrue(probe.waitForExistence(timeout: 10), "Detector probe missing")
        XCTAssertTrue(probe.label.hasPrefix("parked=0 "), probe.label)

        var index = 0
        // The drive and the long red light.
        let lightEnd = try XCTUnwrap(route.points.lastIndex { $0.phase == "light" })
        index = play(route, from: index, through: lightEnd)
        // Moving again after the light: nothing fired there.
        index = play(route, from: index, through: index + 5)
        XCTAssertTrue(probe.label.hasPrefix("parked=0 "), "Fired at the red light: \(probe.label)")

        // The rest of the drive, parking, and the start of the walk.
        let walkStart = try XCTUnwrap(route.firstIndex(of: "walk_away"))
        index = play(route, from: index, through: walkStart + 3)

        // The park is noticed on the walk away: pay from the sheet, and
        // keep walking while the sheet is handled.
        let pay = element(app, "parkedSheet.payButton")
        var paid = false
        let farEnd = try XCTUnwrap(route.points.lastIndex { $0.phase == "far" })
        while index <= farEnd {
            index = play(route, from: index, through: index)
            if !paid, pay.exists, pay.isHittable {
                pay.tap()
                paid = true
            }
        }
        XCTAssertTrue(paid, "No park sheet appeared on the walk away (\(probe.label))")
        XCTAssertTrue(probe.label.hasPrefix("parked=1 "), probe.label)
        let away = Self.values(probe.label)
        XCTAssertGreaterThanOrEqual(away["farthest"] ?? 0, 200, "The walk away never reached the server: \(probe.label)")

        // Walk back to the car and stand there.
        index = play(route, from: index, through: route.points.count - 1)
        let back = Self.values(probe.label)
        XCTAssertEqual(back["parked"], 1, "Fired again on the way back: \(probe.label)")
        XCTAssertLessThanOrEqual(back["last"] ?? .max, 60, "The return never reached the server: \(probe.label)")
        XCTAssertGreaterThan(back["reports"] ?? 0, away["reports"] ?? 0)
        app.terminate()
    }

    // MARK: - Helpers

    /// Onboarding's permissions step with the real prompts. Returns the app
    /// still on that step, location granted Always.
    @discardableResult
    private func grantLocationAlwaysThroughOnboarding() -> XCUIApplication {
        let app = XCUIApplication()
        app.resetAuthorizationStatus(for: .location)
        app.launchArguments = [
            "-resetState", "YES", "-useMockAPI", "YES", "-uiTesting", "YES",
            "-signedIn", "YES", "-onboardingStep", "1",
        ]
        app.launch()
        XCTAssertTrue(element(app, "onboarding.permissions").waitForExistence(timeout: 10))
        let action = element(app, "onboarding.permission.location.action")
        XCTAssertTrue(action.waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "onboarding.permission.location.state").label, "Ask Next Time")
        action.tap()
        let whileUsing = springboard.buttons["Allow While Using App"]
        XCTAssertTrue(whileUsing.waitForExistence(timeout: 10), "No location prompt")
        whileUsing.tap()
        // No second tap on Enable: the app asks for Always by itself.
        let always = springboard.buttons["Change to Always Allow"]
        XCTAssertTrue(always.waitForExistence(timeout: 10), "iOS never showed the Always upgrade")
        always.tap()
        return app
    }

    /// Feeds route points [from...through] to the simulator, one a second,
    /// and returns the next index.
    @discardableResult
    private func play(_ route: RouteFixture, from start: Int, through end: Int) -> Int {
        guard start <= end else { return start }
        for index in start...min(end, route.points.count - 1) {
            let began = Date()
            setLocation(route.points[index])
            let spent = Date().timeIntervalSince(began)
            if spent < 1 { Thread.sleep(forTimeInterval: 1 - spent) }
        }
        return min(end, route.points.count - 1) + 1
    }

    private func setLocation(_ point: RouteFixture.Point) {
        XCUIDevice.shared.location = XCUILocation(location: CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude),
            altitude: 10, horizontalAccuracy: 5, verticalAccuracy: 5, timestamp: Date()
        ))
    }

    /// "parked=1 reports=7 farthest=298 last=12" → ["parked": 1, …]
    private static func values(_ label: String) -> [String: Int] {
        Dictionary(uniqueKeysWithValues: label.split(separator: " ").compactMap { pair -> (String, Int)? in
            let parts = pair.split(separator: "=")
            guard parts.count == 2, let value = Int(parts[1]) else { return nil }
            return (String(parts[0]), value)
        })
    }
}
