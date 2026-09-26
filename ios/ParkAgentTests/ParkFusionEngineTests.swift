import CoreLocation
import Testing

@testable import ParkAgent

/// Drives `ParkFusionEngine` with injected signals and a manual clock — no
/// CoreMotion, no AVAudioSession, no real CLLocationManager.
@MainActor
struct ParkFusionEngineTests {
    @MainActor
    final class Harness {
        // The engine reads `now` through this box so the harness can move
        // time after init.
        @MainActor
        final class ClockBox {
            var now = Date(timeIntervalSince1970: 1_800_000_000)
        }

        let clock = ClockBox()
        let engine: ParkFusionEngine
        var parks: [(fix: ParkFix, signals: [String])] = []
        var unlocated = 0
        var burstStarts = 0
        var burstStops = 0
        var raw: [RawDetectorSignal] = []

        var now: Date { clock.now }

        init(config: ParkFusionEngine.Config = .init()) {
            let clock = clock
            engine = ParkFusionEngine(config: config, now: { clock.now })
            engine.onPark = { [self] fix, signals in parks.append((fix, signals)) }
            engine.onUnlocatedPark = { [self] _ in unlocated += 1 }
            engine.onStartBurst = { [self] in burstStarts += 1 }
            engine.onStopBurst = { [self] in burstStops += 1 }
            engine.onRawSignal = { [self] signal, _, _ in raw.append(signal) }
        }

        /// Move time, firing the engine's own deadlines on the way, as the
        /// detector's timer does.
        func advance(_ seconds: TimeInterval) {
            let target = clock.now.addingTimeInterval(seconds)
            while let deadline = engine.nextDeadline, deadline <= target {
                clock.now = max(clock.now, deadline)
                engine.tick()
                if engine.nextDeadline == deadline { break }
            }
            clock.now = target
        }

        static let base = CLLocationCoordinate2D(latitude: 42.35038, longitude: -71.0763)

        /// ~1e-5° latitude ≈ 1.1 m, so offsets are meters north of `base`.
        func fix(accuracy: Double = 8, offsetM: Double = 0, ageS: TimeInterval = 0, speed: Double? = nil) {
            engine.fixReceived(ParkFix(
                latitude: Self.base.latitude + offsetM / 111_320,
                longitude: Self.base.longitude,
                accuracy: accuracy,
                at: now.addingTimeInterval(-ageS),
                speed: speed
            ))
        }

        /// Three tight fixes a second apart — the settled burst.
        func settle(accuracy: Double = 8) {
            for _ in 0..<3 {
                advance(1)
                fix(accuracy: accuracy)
            }
        }

        func driving() { engine.motion(MotionSample(at: now, automotive: true)) }
        func still() { engine.motion(MotionSample(at: now, stationary: true)) }
        func walking() { engine.motion(MotionSample(at: now, walking: true)) }
        /// CoreMotion at a red light: still moving as far as it's
        /// concerned — automotive AND stationary.
        func stoppedInTraffic() { engine.motion(MotionSample(at: now, automotive: true, stationary: true)) }

        func driveThenStop() {
            driving()
            advance(1)
            still()
        }
    }

    // MARK: - What fires

    @Test func motionPlusCarAudioFiresOnTheFirstGoodFix() {
        let h = Harness()
        h.driveThenStop()
        h.advance(10)
        h.engine.audioDisconnected(port: .bluetooth)
        // No coordinate yet: /parked needs one.
        #expect(h.parks.isEmpty)
        h.advance(2)
        h.fix()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].signals.contains("motion_stop"))
        #expect(h.parks[0].signals.contains("audio_disconnect"))
        #expect(h.burstStarts == 1)
    }

    @Test func stopAndSettledSpotWaitForTheWalkAway() {
        let h = Harness()
        h.driveThenStop()
        h.settle()
        // Stopped with the spot known — but a red light looks like this
        // too, so nothing yet.
        #expect(h.parks.isEmpty)
        // The burst rests once the spot is known.
        #expect(h.burstStops == 1)
        h.advance(20)
        h.walking()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].signals == ["motion_stop", "motion_walking", "location_settled"])
    }

    @Test func standingStillLongEnoughFiresWithoutAWalk() {
        let h = Harness()
        h.driveThenStop()
        h.settle()
        h.advance(100)
        #expect(h.parks.isEmpty, "Fired before the sustained-stop time")
        h.advance(60)
        #expect(h.parks.count == 1)
    }

    @Test func carPlayWithoutMotionDataFiresOnAudioAndSettling() {
        // Motion denied: no motion samples at all. CarPlay is only ever a car.
        let h = Harness()
        h.engine.audioDisconnected(port: .carPlay)
        h.settle()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].signals.sorted() == ["audio_disconnect", "location_settled"])
    }

    @Test func bluetoothAfterADriveCounts() {
        let h = Harness()
        // Driving five minutes ago (motion history, or a fast fix).
        h.driving()
        h.advance(5 * 60)
        h.engine.motion(MotionSample(at: h.now, confidence: .low))
        h.engine.audioDisconnected(port: .bluetooth)
        h.settle()
        #expect(h.parks.count == 1)
    }

    @Test func settledCoordinateIsTheMostAccurateOfTheWindow() {
        let h = Harness()
        h.driveThenStop()
        h.advance(1); h.fix(accuracy: 30)
        h.advance(1); h.fix(accuracy: 5, offsetM: 3)
        h.advance(1); h.fix(accuracy: 12)
        h.walking()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].fix.accuracy == 5)
    }

    // MARK: - What must not fire

    @Test func aRedLightIsNotAStop() {
        let h = Harness()
        h.driving()
        h.advance(30)
        h.stoppedInTraffic()
        h.advance(45)
        h.fix(); h.advance(1); h.fix(); h.advance(1); h.fix()
        #expect(h.parks.isEmpty)
        #expect(h.burstStarts == 0, "A red light started the high-accuracy burst")
    }

    /// CoreMotion sometimes drops `automotive` at a long light. The old
    /// engine fired on motion stop + settled location in seconds, at the
    /// light. Now that pair waits for a walk, audio, a visit, or 150 s.
    @Test func aLongRedLightThatLooksLikeAStopStillDoesNotFire() {
        let h = Harness()
        h.driveThenStop()
        h.settle()
        h.advance(80)
        h.driving()
        h.advance(200)
        #expect(h.parks.isEmpty)
        #expect(h.raw.contains(.drivingResumedCleared))
        #expect(!h.engine.hasPendingStop)
    }

    /// Bluetooth dropping mid-drive (a phone handoff, a flaky link) must
    /// not linger: driving on clears it, so the next red light's settled
    /// spot has nothing to pair with.
    @Test func carAudioDroppingMidDriveIsClearedByDrivingOn() {
        let h = Harness()
        h.driving()
        h.advance(60)
        h.engine.audioDisconnected(port: .bluetooth)
        h.advance(10)
        // Still driving: CoreMotion reports a fresh automotive reading.
        h.driving()
        h.advance(40)
        // A long light: automotive AND stationary, and the spot settles.
        h.stoppedInTraffic()
        h.settle()
        h.advance(60)
        #expect(h.parks.isEmpty, "Fired at a red light on a stale audio drop")
        #expect(h.raw.contains(.drivingResumedCleared))
    }

    @Test func headphonesComingOffAtADeskAreNotACar() {
        let h = Harness()
        h.engine.audioDisconnected(port: .bluetooth)
        h.settle()
        h.advance(300)
        #expect(h.parks.isEmpty)
        #expect(h.burstStarts == 0)
        #expect(h.raw.contains(.audioIgnored))
    }

    @Test func audioLongAfterTheStopDoesNotPair() {
        let h = Harness()
        h.driveThenStop()
        h.advance(2); h.fix(offsetM: 0)
        h.advance(2); h.fix(offsetM: 60)  // never settles
        h.advance(120)
        h.engine.audioDisconnected(port: .bluetooth)
        #expect(h.parks.isEmpty)
    }

    @Test func drivingAgainClearsEverythingPending() {
        let h = Harness()
        h.driveThenStop()
        h.advance(15)
        h.driving()
        // A later lone signal finds nothing stale to pair with.
        h.advance(20)
        h.engine.audioDisconnected(port: .bluetooth)
        h.advance(1)
        h.fix()
        #expect(h.parks.isEmpty)
    }

    @Test func aSecondParkWithinTheDebounceIsSwallowed() {
        let h = Harness()
        h.driveThenStop(); h.settle(); h.walking()
        #expect(h.parks.count == 1)
        // Drive off and re-park a minute later (a drive-through pickup).
        h.advance(30); h.driving(); h.advance(30)
        h.driveThenStop(); h.settle(); h.walking()
        #expect(h.parks.count == 1)
        #expect(h.raw.contains(.debounced))
        // Past the debounce it's live again.
        h.advance(200); h.driving(); h.advance(10)
        h.driveThenStop(); h.settle(); h.walking()
        #expect(h.parks.count == 2)
    }

    // MARK: - Fix quality

    @Test func blurredFixesNeverLocateAParkAndSaySoOnce() {
        // Precise Location off: iOS hands out fixes kilometers wide.
        let h = Harness()
        h.driveThenStop()
        for _ in 0..<5 {
            h.advance(1)
            h.fix(accuracy: 1_500)
        }
        h.walking()
        #expect(h.parks.isEmpty)
        h.advance(120)
        #expect(h.parks.isEmpty)
        #expect(h.unlocated == 1)
        h.advance(120)
        #expect(h.unlocated == 1, "Said twice")
    }

    @Test func staleCachedFixesAreRejected() {
        let h = Harness()
        h.driveThenStop()
        for _ in 0..<3 {
            h.advance(1)
            h.fix(ageS: 40)
        }
        h.walking()
        #expect(h.parks.isEmpty)
        #expect(h.raw.filter { $0 == .fixRejected }.count == 3)
    }

    @Test func aJumpAcrossTownIsDroppedAndTheSpotStillSettles() {
        let h = Harness()
        h.driveThenStop()
        h.advance(1); h.fix()
        h.advance(1); h.fix(accuracy: 10, offsetM: 900)  // multipath
        h.advance(1); h.fix()
        h.advance(1); h.fix()
        h.walking()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].fix.distance(to: ParkFix(coordinate: Harness.base, accuracy: 0, at: h.now)) < 5)
        #expect(h.raw.contains(.fixRejected))
    }

    // MARK: - Visits and history

    @Test func aVisitLocatesAStopTheAppSleptThrough() {
        let h = Harness()
        // Motion history replayed on a late wake: the drive, the stop, the
        // walk — all minutes ago, no burst fixes from then.
        let stopAt = h.now
        h.engine.motion(MotionSample(at: stopAt.addingTimeInterval(-60), automotive: true))
        h.engine.motion(MotionSample(at: stopAt, stationary: true))
        h.engine.motion(MotionSample(at: stopAt.addingTimeInterval(30), walking: true))
        h.advance(6 * 60)
        // The burst ran now, on where the driver walked to: those fixes
        // describe the walk, not the car.
        h.fix(offsetM: 300)
        #expect(h.parks.isEmpty)
        #expect(h.unlocated == 0, "A stop rebuilt from history isn't 'no GPS'")
        // iOS's visit arrives, placed at its own arrival time.
        h.engine.visitArrived(ParkFix(
            latitude: Harness.base.latitude, longitude: Harness.base.longitude,
            accuracy: 25, at: stopAt.addingTimeInterval(20)
        ))
        #expect(h.parks.count == 1)
        #expect(h.parks[0].fix.accuracy == 25)
        #expect(h.parks[0].signals.contains("visit_arrival"))
    }

    @Test func aVisitTooVagueToPickABlockLocatesNothing() {
        let h = Harness()
        h.driveThenStop()
        h.engine.visitArrived(ParkFix(
            latitude: Harness.base.latitude, longitude: Harness.base.longitude,
            accuracy: 200, at: h.now
        ))
        h.advance(5)
        #expect(h.parks.isEmpty)
    }

    // MARK: - Surviving a relaunch

    @Test func aStopRestoredAfterARelaunchFiresOnTheWalk() {
        let first = Harness()
        first.driveThenStop()
        first.settle()
        let saved = first.engine.state
        #expect(saved.stop?.settled != nil)

        // iOS ended the app; a new process restores from disk.
        let second = Harness()
        second.clock.now = first.now.addingTimeInterval(40)
        second.engine.restore(saved)
        second.walking()
        #expect(second.parks.count == 1)
        #expect(second.parks[0].fix == saved.stop?.settled)
    }

    @Test func aRestoredStopPastItsLifetimeIsDropped() {
        let first = Harness()
        first.driveThenStop()
        let saved = first.engine.state
        let second = Harness()
        second.clock.now = first.now.addingTimeInterval(16 * 60)
        second.engine.restore(saved)
        #expect(!second.engine.hasPendingStop)
    }

    @Test func stateRoundTripsThroughJSON() throws {
        let h = Harness()
        h.driveThenStop()
        h.settle()
        let data = try JSONEncoder().encode(h.engine.state)
        let decoded = try JSONDecoder().decode(ParkFusionEngine.State.self, from: data)
        #expect(decoded == h.engine.state)
    }

    // MARK: - A whole drive

    /// Drive, stop at a long light (CoreMotion drops automotive, the spot
    /// settles), drive on, park, turn the car off, walk 300 m away and
    /// back: exactly one park, at the parking spot, not at the light.
    @Test func aWholeDriveFiresExactlyOnceAtTheParkingSpot() {
        let h = Harness()
        // Drive north for a minute.
        for i in 0..<12 {
            h.driving()
            h.fix(accuracy: 10, offsetM: Double(i) * 50 - 1_000, speed: 10)
            h.advance(5)
        }
        // Red light 400 m short of the spot: automotive drops, spot settles.
        h.still()
        for _ in 0..<5 { h.advance(1); h.fix(offsetM: -400) }
        h.advance(40)
        // Green.
        for i in 0..<8 {
            h.driving()
            h.fix(accuracy: 10, offsetM: -400 + Double(i) * 50, speed: 10)
            h.advance(5)
        }
        // Park at the spot; engine off (Bluetooth drops); get out.
        h.still()
        for _ in 0..<4 { h.advance(1); h.fix() }
        h.engine.audioDisconnected(port: .bluetooth)
        h.advance(15)
        h.walking()
        // Walk 300 m away and back at 1.4 m/s.
        for step in 0..<43 { h.advance(5); h.fix(offsetM: Double(step) * 7) }
        for step in 0..<43 { h.advance(5); h.fix(offsetM: 300 - Double(step) * 7) }
        h.still()
        h.advance(600)

        #expect(h.parks.count == 1)
        let spot = ParkFix(coordinate: Harness.base, accuracy: 0, at: h.now)
        #expect(h.parks[0].fix.distance(to: spot) < 10, "Parked somewhere other than the spot")
    }
}
