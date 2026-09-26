import XCTest
@testable import ParkAgent

/// The launch gate's rules: resume at the first missing step, and never
/// trap anyone in onboarding because the server was slow.
final class OnboardingGateTests: XCTestCase {
    /// Everything in place, a Boston user linked to ParkBoston.
    private let setUp = OnboardingGate.Facts(
        permissionsOK: true,
        serverHasVehicle: true,
        localVehicleOK: true,
        city: "bos",
        usableProviders: ["passport"]
    )

    private func step(_ change: (inout OnboardingGate.Facts) -> Void) -> OnboardingStep? {
        var facts = setUp
        change(&facts)
        return OnboardingGate.firstMissingStep(facts)
    }

    func testFullySetUpGoesHome() {
        XCTAssertNil(OnboardingGate.firstMissingStep(setUp))
    }

    /// Sign-in is the welcome: with nothing set up, the flow opens on
    /// permissions — never the retired onboarding welcome.
    func testNothingSetUpStartsAtPermissions() {
        let facts = OnboardingGate.Facts(
            permissionsOK: false,
            serverHasVehicle: false,
            localVehicleOK: false,
            city: nil,
            usableProviders: []
        )
        XCTAssertEqual(OnboardingGate.firstMissingStep(facts), .permissions)
    }

    func testStepsResolveInFlowOrder() {
        XCTAssertEqual(step { $0.permissionsOK = false }, .permissions)
        XCTAssertEqual(step { $0.serverHasVehicle = false; $0.localVehicleOK = false }, .vehicle)
        XCTAssertEqual(step { $0.city = nil }, .city)
        XCTAssertEqual(step { $0.city = "atlantis" }, .city)
        XCTAssertEqual(step { $0.usableProviders = [] }, .linkProvider)
        // The link is for THIS city's provider; another city's doesn't count.
        XCTAssertEqual(step { $0.usableProviders = ["parknyc"] }, .linkProvider)
    }

    /// The car belongs to the account now: a new phone of a returning
    /// driver has no local plate, and the server's answer is what counts.
    func testTheAccountsCarCountsOnANewPhone() {
        XCTAssertNil(step { $0.localVehicleOK = false; $0.serverHasVehicle = true })
    }

    /// A plate typed on this phone before accounts existed never reached
    /// the server, which is what pays — so the vehicle step runs (and
    /// prefills it from this phone).
    func testALocalOnlyPlateStillNeedsSaving() {
        XCTAssertEqual(step { $0.localVehicleOK = true; $0.serverHasVehicle = false }, .vehicle)
    }

    /// The server didn't answer in time: fall back to this phone's plate,
    /// and land on Home rather than re-asking for a provider link.
    func testAnUnreachableServerNeverTrapsAnyone() {
        XCTAssertNil(step { $0.serverHasVehicle = nil; $0.usableProviders = nil })
        XCTAssertEqual(
            step { $0.serverHasVehicle = nil; $0.localVehicleOK = false },
            .vehicle,
            "with no answer and no local plate, the car is genuinely unknown"
        )
    }

    func testSomewhereElseFinishesWithoutAProvider() {
        XCTAssertNil(step { $0.city = "other"; $0.usableProviders = [] })
    }

    /// The gate's two server calls share ONE bounded window: a server that
    /// never answers costs the timeout once, not once per call, and both
    /// halves come back unknown rather than as "missing".
    func testServerFactsGiveUpTogetherAfterTheTimeout() async {
        let started = ContinuousClock.now
        let facts = await OnboardingGate.serverFacts(api: HangingAPI(), timeout: .milliseconds(300))
        let elapsed = ContinuousClock.now - started

        XCTAssertNil(facts.hasVehicle)
        XCTAssertNil(facts.usableProviders)
        XCTAssertLessThan(elapsed, .milliseconds(1500), "the two calls must wait concurrently")
    }

    /// The facts are what the server says: the mock's garage holds a car,
    /// and its default provider scenario has both providers linked.
    func testServerFactsReadTheMock() async {
        let facts = await OnboardingGate.serverFacts(api: MockAPI(), timeout: .seconds(4))
        XCTAssertEqual(facts.hasVehicle, true)
        XCTAssertEqual(facts.usableProviders, ["parknyc", "passport"])
    }

    // MARK: - Permissions

    /// While Using used to fail the gate on every launch and send the user
    /// back through setup, where the row said "On". Now: fully granted, or
    /// the user saw the "what won't work" summary and chose to go on.
    func testPermissionsPassWhenGrantedOrWhenLimitsWereAcknowledged() {
        var caps = DetectionCapabilities(
            locationServicesEnabled: true, location: .always, preciseLocation: true,
            motion: .authorized, notifications: .authorized, backgroundRefresh: .available, lowPowerMode: false
        )
        XCTAssertTrue(OnboardingGate.permissionsOK(caps, acknowledgedLimited: false))
        caps.location = .whileUsing
        XCTAssertFalse(OnboardingGate.permissionsOK(caps, acknowledgedLimited: false))
        XCTAssertTrue(OnboardingGate.permissionsOK(caps, acknowledgedLimited: true))
        // Low Power Mode is not a permission to chase anyone over.
        caps.location = .always
        caps.lowPowerMode = true
        XCTAssertTrue(OnboardingGate.permissionsOK(caps, acknowledgedLimited: false))
    }
}
