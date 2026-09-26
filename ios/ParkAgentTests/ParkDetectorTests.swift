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

    func makeDetector(store: DetectorStore, motion: FakeMotion) -> ParkDetector {
        let log = SignalLog(directory: FileManager.default.temporaryDirectory)
        return ParkDetector(engine: ParkFusionEngine(), signalLog: log, store: store, motion: motion)
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
        detector.onPark = { fix, _ in parks.append(fix) }
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
}
