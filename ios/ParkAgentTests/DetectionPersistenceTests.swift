import CoreLocation
import XCTest

@testable import ParkAgent

/// What must survive iOS ending the app: the detector's pending stop, the
/// active session (so location reports resume), and nothing stale.
@MainActor
final class DetectionPersistenceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        ActiveSession.store(nil)
    }

    override func tearDown() {
        ActiveSession.store(nil)
        super.tearDown()
    }

    private func session(expiresIn: TimeInterval) -> ActiveSession {
        ActiveSession(
            sessionId: "s1", zoneNumber: "456", zoneLabel: "Zone 456",
            startedAt: AppClock.now.addingTimeInterval(-600),
            expiresAt: AppClock.now.addingTimeInterval(expiresIn),
            amountUsd: 2.5, extendCount: 0, maxExtendCount: 2, maxStayReached: false
        )
    }

    func testTheActiveSessionSurvivesARelaunch() {
        XCTAssertNil(ActiveSession.restore())
        let running = session(expiresIn: 1_800)
        ActiveSession.store(running)
        XCTAssertEqual(ActiveSession.restore(), running)
    }

    func testASessionLongExpiredIsNotRestored() {
        ActiveSession.store(session(expiresIn: -20 * 60))
        XCTAssertNil(ActiveSession.restore())
        // …and it's gone, not left to be found again.
        ActiveSession.store(nil)
        XCTAssertNil(UserDefaults.standard.data(forKey: "activeSession"))
    }

    /// The model restores it at launch, which is what restarts the reporter
    /// (AppModel.armDetection) after iOS ended the app mid-session.
    func testTheModelRestoresTheSessionAtLaunch() {
        let running = session(expiresIn: 1_800)
        ActiveSession.store(running)
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        XCTAssertEqual(model.activeSession, running)
    }

    /// A park the driver dismissed used to pin the map (and the city check)
    /// to its spot on every launch.
    func testAStaleCarPinIsDroppedAtLaunch() {
        let defaults = UserDefaults.standard
        defaults.set(42.35, forKey: "carLat")
        defaults.set(-71.07, forKey: "carLng")
        defaults.removeObject(forKey: "pendingParked")
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        XCTAssertNil(model.carCoordinate)
        XCTAssertNil(defaults.object(forKey: "carLat"))
    }

    func testTheCarPinStaysWhileASessionRuns() {
        ActiveSession.store(session(expiresIn: 1_800))
        let defaults = UserDefaults.standard
        defaults.set(42.35, forKey: "carLat")
        defaults.set(-71.07, forKey: "carLng")
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        XCTAssertEqual(model.carCoordinate?.latitude, 42.35)
        defaults.removeObject(forKey: "carLat")
        defaults.removeObject(forKey: "carLng")
    }

    func testTheDetectorStoreRoundTripsAPendingStop() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = DetectorStore(directory: dir)
        XCTAssertNil(store.load())
        var state = ParkFusionEngine.State()
        state.wasDriving = false
        state.stop = .init(startedAt: Date(timeIntervalSince1970: 1_800_000_000))
        state.stop?.settled = ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 6, at: Date(timeIntervalSince1970: 1_800_000_003))
        let snapshot = DetectorStore.Snapshot(engine: state, motionHistoryThrough: Date(timeIntervalSince1970: 1_800_000_010), savedAt: .now)
        store.save(snapshot)
        XCTAssertEqual(DetectorStore(directory: dir).load(), snapshot)
        store.clear()
        XCTAssertNil(store.load())
    }

    // MARK: - City detection

    /// No fix at all: retried with backoff, then said plainly (the map
    /// labels the fallback city instead of passing it off as "you").
    func testCityDetectionRetriesThenSaysThereWasNoLocation() async {
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        model.cityRetryDelays = [.zero, .zero, .zero]
        var attempts = 0
        await model.detectCityWithRetry {
            attempts += 1
            return nil
        }
        XCTAssertEqual(attempts, 4)
        XCTAssertEqual(model.cityDetection, .noLocation)
    }

    /// A fix, but the server never answers (unit tests point at
    /// localhost:1): retried, then "couldn't check", not a silent default.
    func testCityDetectionRetriesThenSaysTheServerDidNotAnswer() async {
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        model.cityRetryDelays = [.zero, .zero]
        var attempts = 0
        await model.detectCityWithRetry {
            attempts += 1
            return CLLocationCoordinate2D(latitude: 42.35, longitude: -71.07)
        }
        XCTAssertEqual(attempts, 3)
        XCTAssertEqual(model.cityDetection, .serverUnreachable)
    }
}
