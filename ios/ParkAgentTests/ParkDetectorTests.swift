import Foundation
import Testing

@testable import ParkAgent

/// The detector around the engine: what it replays from CoreMotion's
/// history after a suspension, and what it keeps across a relaunch. A fake
/// motion source stands in for CoreMotion; no location is granted in the
/// test host, so no radio runs.
@MainActor
struct ParkDetectorTests {
    @MainActor
    final class FakeMotion: MotionSource {
        var isAvailable: Bool { true }
        var historyAnswer: [MotionSample] = []
        private(set) var handler: (@MainActor (MotionSample) -> Void)?
        func start(_ handler: @escaping @MainActor (MotionSample) -> Void) { self.handler = handler }
        func stop() { handler = nil }
        func history(from: Date, to: Date) async -> [MotionSample] {
            historyAnswer.filter { $0.at >= from && $0.at <= to }
        }
    }

    /// The barometer, switched on and off by the detector.
    @MainActor
    final class FakeAltimeter: AltimeterSource {
        var isAvailable = true
        private(set) var isRunning = false
        private(set) var starts = 0
        func start(_ handler: @escaping @MainActor (AltitudeSample) -> Void) {
            isRunning = true
            starts += 1
        }
        func stop() { isRunning = false }
    }

    func makeDetector(
        store: DetectorStore,
        motion: FakeMotion,
        engine: ParkFusionEngine = ParkFusionEngine(),
        altimeter: FakeAltimeter = FakeAltimeter(),
        places: PlaceMemoryStore? = nil,
        footprints: [Footprint] = []
    ) -> ParkDetector {
        let log = SignalLog(directory: FileManager.default.temporaryDirectory)
        return ParkDetector(
            engine: engine, signalLog: log, store: store, motion: motion, altimeter: altimeter,
            placeMemory: places ?? tempPlaces(), footprints: LinearFootprintIndex(footprints: footprints)
        )
    }

    func tempPlaces() -> PlaceMemoryStore {
        PlaceMemoryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    }

    func tempStore() -> DetectorStore {
        DetectorStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    }

    /// Let the detector's queued tasks run.
    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(50))
    }

    /// Resuming from suspension, CoreMotion hands over the current activity
    /// (walking) at once. The drive and the stop before it are only in its
    /// history: they must go in first, in order, or the walk has no stop
    /// to confirm and the park is lost.
    @Test func aLiveSampleAfterASuspensionWaitsForTheHistoryOfTheGap() async {
        let store = tempStore()
        let motion = FakeMotion()
        let detector = makeDetector(store: store, motion: motion)
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        // Suspended for a while: a drive, then a stop, only in history.
        let t = Date.now
        motion.historyAnswer = [
            MotionSample(at: t.addingTimeInterval(100), automotive: true),
            MotionSample(at: t.addingTimeInterval(400), stationary: true),
        ]
        // Resumed: CoreMotion hands over the current activity first.
        motion.handler?(MotionSample(at: t.addingTimeInterval(460), walking: true))
        await settle()

        let stop = detector.engine.state.stop
        #expect(stop?.stopAt == t.addingTimeInterval(400), "The stop from history was never seen")
        #expect(stop?.walkAt == t.addingTimeInterval(460))
    }

    /// CoreMotion can deliver its newest activity live a moment before it
    /// lands in history. A wake that just replayed must not then drop it
    /// as "already seen": that lost the motion stop.
    @Test func aLiveSampleNewerThanTheLastReplayedOneIsHandled() async {
        let store = tempStore()
        let motion = FakeMotion()
        let t = Date.now
        motion.historyAnswer = [MotionSample(at: t.addingTimeInterval(-120), automotive: true)]
        let detector = makeDetector(store: store, motion: motion)
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        #expect(detector.engine.state.wasDriving)
        // Stationary since five seconds ago, not yet in history.
        motion.handler?(MotionSample(at: t.addingTimeInterval(-5), stationary: true))
        await settle()
        #expect(detector.engine.state.stop?.stopAt == t.addingTimeInterval(-5))
    }

    /// Each sample reaches the engine once: a replay after live handling
    /// doesn't feed the same drive twice (which would re-park an old stop).
    @Test func historyAlreadyHandledLiveIsNotFedAgain() async {
        let store = tempStore()
        let motion = FakeMotion()
        let detector = makeDetector(store: store, motion: motion)
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        let t = Date.now
        let drive = MotionSample(at: t.addingTimeInterval(10), automotive: true)
        let stop = MotionSample(at: t.addingTimeInterval(20), stationary: true)
        motion.handler?(drive)
        motion.handler?(stop)
        await settle()
        #expect(detector.engine.state.stop?.stopAt == stop.at)

        // Driving again clears the stop; then a wake replays history that
        // still contains the old drive and stop.
        motion.handler?(MotionSample(at: t.addingTimeInterval(25), automotive: true))
        await settle()
        #expect(!detector.engine.hasPendingStop)
        motion.historyAnswer = [drive, stop]
        await detector.wake(.foreground)
        #expect(!detector.engine.hasPendingStop, "An old stop was fed twice and came back")
    }

    /// Relaunched hours after the last save: whether the car was still
    /// being driven is unknown, so the first "stationary" must not become
    /// a stop (it used to fire a park the next morning).
    @Test func aRelaunchHoursLaterForgetsItWasDriving() async {
        let store = tempStore()
        var driving = ParkFusionEngine.State()
        driving.wasDriving = true
        driving.lastDrivingAt = Date.now.addingTimeInterval(-5 * 3600)
        store.save(.init(engine: driving, motionHistoryThrough: driving.lastDrivingAt, savedAt: Date.now.addingTimeInterval(-5 * 3600)))
        let motion = FakeMotion()
        let detector = makeDetector(store: store, motion: motion)
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        #expect(!detector.engine.state.wasDriving)
        motion.handler?(MotionSample(at: .now, stationary: true))
        await settle()
        #expect(!detector.engine.hasPendingStop)
    }

    /// …but a relaunch mid-park, minutes later, picks the stop back up.
    @Test func aRelaunchMidParkKeepsThePendingStop() async {
        let store = tempStore()
        var parked = ParkFusionEngine.State()
        parked.stop = .init(startedAt: Date.now.addingTimeInterval(-60))
        parked.stop?.stopAt = Date.now.addingTimeInterval(-60)
        parked.stop?.settled = ParkFix(latitude: 42.35038, longitude: -71.0763, accuracy: 5, at: Date.now.addingTimeInterval(-55))
        store.save(.init(engine: parked, motionHistoryThrough: Date.now.addingTimeInterval(-50), savedAt: Date.now.addingTimeInterval(-50)))
        let motion = FakeMotion()
        let detector = makeDetector(store: store, motion: motion)
        var parks: [ParkFix] = []
        detector.onPark = { fix, _, _ in parks.append(fix) }
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        #expect(detector.engine.hasPendingStop)
        motion.handler?(MotionSample(at: .now, walking: true))
        await settle()
        #expect(parks.count == 1)
        #expect(parks.first == parked.stop?.settled)
    }

    @Test func signingOutLeavesNothingOnDisk() async {
        let store = tempStore()
        let detector = makeDetector(store: store, motion: FakeMotion())
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        store.save(.init(engine: .init(), motionHistoryThrough: .now, savedAt: .now))
        detector.disarm()
        #expect(store.load() == nil)
        #expect(!detector.isArmed)
    }

    // MARK: - The barometer and the place (FR-53)

    /// The altimeter costs battery: it runs from the stop until the burst
    /// ends (the spot settles, the burst times out, driving resumes), and
    /// never while idle or driving.
    @Test func theAltimeterRunsOnlyInTheStopWindow() async {
        let motion = FakeMotion()
        let altimeter = FakeAltimeter()
        let detector = makeDetector(store: tempStore(), motion: motion, altimeter: altimeter)
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        #expect(!altimeter.isRunning, "Armed and idle")
        let t = Date.now
        motion.handler?(MotionSample(at: t, automotive: true))
        await settle()
        #expect(!altimeter.isRunning, "Driving")
        motion.handler?(MotionSample(at: t.addingTimeInterval(1), stationary: true))
        await settle()
        #expect(altimeter.isRunning, "The stop window")
        #expect(detector.altimeterWithinStopWindow)
        motion.handler?(MotionSample(at: t.addingTimeInterval(2), automotive: true))
        await settle()
        #expect(!altimeter.isRunning, "A light that turned green")
        motion.handler?(MotionSample(at: t.addingTimeInterval(3), stationary: true))
        await settle()
        #expect(altimeter.isRunning)
        // The spot settles: the burst rests, and the altimeter with it.
        for _ in 0..<3 {
            detector.engine.fixReceived(ParkFix(latitude: 42.35038, longitude: -71.0763, accuracy: 5, at: .now))
        }
        #expect(!altimeter.isRunning, "The spot is known")
        #expect(altimeter.starts == 2)
        #expect(detector.altimeterWithinStopWindow)
    }

    /// Signing out mid-stop: nothing keeps running, and the driver's saved
    /// places go with the account.
    @Test func signingOutStopsTheAltimeterAndForgetsSavedPlaces() async {
        let motion = FakeMotion()
        let altimeter = FakeAltimeter()
        let places = tempPlaces()
        let home = PlaceClassifierTests.Geo.at(n: 0, e: 0)
        places.update { $0.confirm(.nopay, at: home, name: "Home", now: .now) }
        places.update { $0.confirm(.nopay, at: home, now: .now) }
        let detector = makeDetector(store: tempStore(), motion: motion, altimeter: altimeter, places: places)
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        let t = Date.now
        motion.handler?(MotionSample(at: t, automotive: true))
        motion.handler?(MotionSample(at: t.addingTimeInterval(1), stationary: true))
        await settle()
        #expect(altimeter.isRunning)
        detector.disarm()
        #expect(!altimeter.isRunning)
        #expect(places.memory.places.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: places.fileURL.path))
        #expect(detector.lastPlace == nil)
    }

    /// A park goes out with its place classification, and parking alone
    /// never writes the driver's place memory — only their confirmation
    /// will (#179).
    @Test func aParkCarriesItsPlaceClassification() async throws {
        let motion = FakeMotion()
        let places = tempPlaces()
        let detector = makeDetector(store: tempStore(), motion: motion, places: places, footprints: [PlaceClassifierTests.garage])
        var parks: [(fix: ParkFix, place: PlaceClassification)] = []
        detector.onPark = { fix, _, place in parks.append((fix, place)) }
        detector.arm(capabilities: DetectionCapabilities())
        await settle()
        let t = Date.now
        motion.handler?(MotionSample(at: t, automotive: true))
        motion.handler?(MotionSample(at: t.addingTimeInterval(1), stationary: true))
        await settle()
        for _ in 0..<3 {
            detector.engine.fixReceived(ParkFix(coordinate: PlaceClassifierTests.Geo.origin, accuracy: 5, at: .now))
        }
        motion.handler?(MotionSample(at: t.addingTimeInterval(2), walking: true))
        await settle()
        #expect(parks.count == 1)
        let place = try #require(parks.first?.place)
        #expect(place.placeClass == .garage)
        #expect(place.inputs.footprintId == "test-garage")
        #expect(detector.lastPlace?.classification == place)
        #expect(places.memory.places.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: places.fileURL.path))
    }

    /// An unlocated park (GPS gone in a garage) is classified from where
    /// the car went in; there's no /parked call for it yet.
    @Test func anUnlocatedParkIsClassifiedFromItsEntryFix() {
        let clock = ParkFusionEngineTests.Harness.ClockBox()
        let engine = ParkFusionEngine(now: { clock.now })
        let detector = makeDetector(store: tempStore(), motion: FakeMotion(), engine: engine, footprints: [PlaceClassifierTests.garage])
        var unlocated = 0
        detector.onUnlocatedPark = { _ in unlocated += 1 }
        func advance(_ seconds: TimeInterval) { clock.now = clock.now.addingTimeInterval(seconds) }
        engine.motion(MotionSample(at: clock.now, automotive: true))
        engine.fixReceived(ParkFix(coordinate: PlaceClassifierTests.Geo.at(n: 20, e: 5), accuracy: 8, at: clock.now, speed: 3))
        advance(40)
        engine.motion(MotionSample(at: clock.now, automotive: true))
        advance(10)
        engine.motion(MotionSample(at: clock.now, stationary: true))
        engine.audioDisconnected(port: .bluetooth)
        advance(20)
        engine.motion(MotionSample(at: clock.now, walking: true))
        advance(100)
        engine.tick()
        #expect(unlocated == 1)
        #expect(detector.lastPlace?.classification.placeClass == .garage)
        #expect(detector.lastPlace?.classification.inputs.footprintId == "test-garage")
        #expect(detector.lastPlace?.classification.inputs.located == false)
    }
}
