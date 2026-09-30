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
        /// Every park and unlocated park with its place evidence.
        var outcomes: [ParkOutcome] = []
        var burstStarts = 0
        var burstStops = 0
        var raw: [RawDetectorSignal] = []

        var now: Date { clock.now }

        init(config: ParkFusionEngine.Config = .init()) {
            let clock = clock
            engine = ParkFusionEngine(config: config, now: { clock.now })
            engine.onPark = { [self] fix, signals in parks.append((fix, signals)) }
            engine.onUnlocatedPark = { [self] _ in unlocated += 1 }
            engine.onOutcome = { [self] outcome in outcomes.append(outcome) }
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

        /// One barometer reading, now.
        func altitude(relativeM: Double, pressureKPa: Double) {
            engine.altitude(AltitudeSample(at: now, relativeAltitudeM: relativeM, pressureKPa: pressureKPa))
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

    // MARK: - Where it parked: the place classifier's evidence (FR-53)

    /// The entry fix is the last good fix of the car still moving — what
    /// says which garage it drove into — not the settled spot, and not a
    /// moving fix too coarse to trust.
    @Test func entryFixIsTheLastMovingGoodFixNotTheSettledOne() throws {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 8, offsetM: -200, speed: 10)
        h.advance(5)
        h.fix(accuracy: 8, offsetM: -40, speed: 3)
        h.advance(5)
        h.fix(accuracy: 9, offsetM: -25, speed: 2.5)
        h.advance(2)
        h.fix(accuracy: 45, offsetM: -18, speed: 3)
        h.advance(2)
        h.still()
        h.settle()
        h.walking()
        #expect(h.parks.count == 1)
        let outcome = try #require(h.outcomes.first)
        #expect(h.outcomes.count == 1)
        #expect(outcome.fix == h.parks[0].fix, "The outcome is the park's")
        #expect(outcome.signals == h.parks[0].signals)
        #expect(outcome.entryFix?.accuracy == 9)
        #expect(outcome.entryFix?.speed == 2.5)
        #expect(outcome.entryFix != outcome.fix)
        #expect(h.raw.contains(.entryFix))
    }

    /// A moving fix minutes before the stop says nothing about where the
    /// car went in.
    @Test func anEntryFixTooOldForTheStopIsDropped() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 8, offsetM: -300, speed: 9)
        // Two and a half minutes in stopped traffic, GPS fine.
        for _ in 0..<15 {
            h.advance(10)
            h.stoppedInTraffic()
            h.fix(accuracy: 8, offsetM: -290, speed: 0)
        }
        h.still()
        #expect(h.engine.state.stop != nil)
        #expect(h.engine.state.stop?.entryFix == nil)
        #expect(h.engine.state.stop?.gpsLossAt == nil)
    }

    /// GPS going bad on the way in (accuracy from meters to hundreds):
    /// the first bad fix is when it was lost.
    @Test func gpsLossIsSetWhenAccuracyBlowsUp() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -100, speed: 8)
        h.advance(3)
        let lostAt = h.now
        h.fix(accuracy: 300, offsetM: -80)
        h.advance(3)
        h.fix(accuracy: 1_400, offsetM: -70)
        h.advance(20)
        h.still()
        #expect(h.engine.state.stop?.gpsLossAt == lostAt, "The first bad fix, not a later one")
        #expect(h.raw.filter { $0 == .gpsLost }.count == 1)
    }

    /// Fixes simply stopping while the car is still driving (down a ramp)
    /// is a loss too, dated from the last fix.
    @Test func gpsLossIsSetOnSilenceWhileDriving() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -100, speed: 8)
        let lastFix = h.now
        for _ in 0..<5 {
            h.advance(10)
            h.driving()
        }
        h.still()
        #expect(h.engine.state.stop?.gpsLossAt == lastFix)
    }

    /// …and silence that begins just before the stop counts once 45 s
    /// have passed with nothing.
    @Test func gpsLossIsSetOnSilenceThatOutlastsTheStop() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -30, speed: 4)
        let lastFix = h.now
        h.advance(20)
        h.still()
        #expect(h.engine.state.stop?.gpsLossAt == nil, "20 s is not yet a loss")
        h.advance(30)
        h.walking()
        #expect(h.engine.state.stop?.gpsLossAt == lastFix)
    }

    /// A tunnel: GPS goes and comes back while still driving. The street
    /// park after it has no loss to report.
    @Test func gpsThatComesBackBeforeTheStopIsNoLoss() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -500, speed: 12)
        h.advance(2)
        h.fix(accuracy: 800, offsetM: -480)
        for _ in 0..<6 {
            h.advance(10)
            h.driving()
        }
        h.fix(accuracy: 7, offsetM: -60, speed: 9)
        h.advance(8)
        h.still()
        #expect(h.engine.state.stop != nil)
        #expect(h.engine.state.stop?.gpsLossAt == nil)
    }

    /// A settled street spot, then minutes of nothing (the burst rested):
    /// that silence is not a lost GPS.
    @Test func silenceAfterTheSpotSettledIsNoLoss() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -30, speed: 4)
        h.advance(3)
        h.still()
        h.settle()
        h.advance(150)
        #expect(h.parks.count == 1, "Fired on the sustained stop")
        #expect(h.outcomes.first?.gpsLossAt == nil)
    }

    /// Precise Location off: fixes were never good, so none were lost, and
    /// none can be an entry fix.
    @Test func blurredFixesAreNeitherALossNorAnEntry() {
        let h = Harness()
        h.driving()
        for i in 0..<5 {
            h.fix(accuracy: 3_000, offsetM: Double(i) * 50, speed: 10)
            h.advance(5)
        }
        h.still()
        for _ in 0..<3 {
            h.advance(1)
            h.fix(accuracy: 3_000)
        }
        h.advance(60)
        #expect(h.engine.state.stop != nil)
        #expect(h.engine.state.stop?.gpsLossAt == nil)
        #expect(h.engine.state.stop?.entryFix == nil)
    }

    /// Underground with no signal at all: the burst hears nothing. The
    /// entry fix says the car went where GPS can't follow, so the park is
    /// reported unlocated, with its evidence — it used to stay silent.
    @Test func anUndergroundParkWithNoFixesAtAllIsReportedUnlocated() throws {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -60, speed: 5)
        h.advance(4)
        h.fix(accuracy: 8, offsetM: -45, speed: 3)
        let entry = h.now
        for _ in 0..<3 {
            h.advance(10)
            h.driving()
        }
        h.still()
        h.advance(8)
        h.engine.audioDisconnected(port: .bluetooth)
        h.advance(20)
        h.walking()
        h.advance(120)
        #expect(h.parks.isEmpty)
        #expect(h.unlocated == 1)
        let outcome = try #require(h.outcomes.last)
        #expect(outcome.fix == nil)
        #expect(outcome.entryFix?.at == entry)
        #expect(outcome.gpsLossAt == entry)
    }

    /// A garage's ticket gate: CoreMotion calls the pause a stop, driving
    /// clears it, and the car goes down the ramp with no GPS. The entry
    /// fix from before the gate, and the silence after it, reach the
    /// real stop.
    @Test func aTicketGateOnTheWayInKeepsTheEntryFix() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 7, offsetM: -40, speed: 3)
        let entry = h.now
        h.advance(3)
        h.still()
        h.advance(1)
        h.fix(accuracy: 9, offsetM: -38, speed: 0)
        h.advance(12)
        h.driving()
        #expect(h.engine.state.stop == nil, "The gate lifted: driving cleared the stop")
        for _ in 0..<4 {
            h.advance(10)
            h.driving()
        }
        h.still()
        #expect(h.engine.state.stop?.entryFix?.at == entry)
        #expect(h.engine.state.stop?.gpsLossAt != nil, "Silence since the gate")
    }

    /// Stuck in traffic in a tunnel: GPS gone, the car still for minutes,
    /// nobody walks away and the audio stays on. That is not a park, and
    /// the no-fix report an underground garage now gets must not fire.
    @Test func aTunnelJamIsNotAnUnlocatedPark() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -100, speed: 12)
        h.advance(20)
        h.driving()
        h.advance(20)
        h.still()
        h.advance(240)
        #expect(h.unlocated == 0)
        #expect(h.parks.isEmpty)
        h.driving()
        #expect(h.engine.state.stop == nil)
    }

    /// A parking-lot crawl (2–4 m/s for half a minute) before the stop.
    @Test func aParkingLotCrawlIsMeasured() {
        let h = Harness()
        h.driving()
        h.fix(accuracy: 6, offsetM: -300, speed: 11)
        for i in 0..<9 {
            h.advance(5)
            h.fix(accuracy: 6, offsetM: -120 + Double(i) * 12, speed: 2.8)
        }
        h.advance(3)
        h.still()
        #expect((h.engine.state.stop?.crawlS ?? 0) >= 30)
    }

    @Test func aFastStretchEndsACrawl() {
        let h = Harness()
        h.driving()
        for i in 0..<5 {
            h.advance(5)
            h.fix(accuracy: 6, offsetM: -300 + Double(i) * 12, speed: 3)
        }
        h.advance(5)
        h.fix(accuracy: 6, offsetM: -200, speed: 9)
        for i in 0..<3 {
            h.advance(5)
            h.fix(accuracy: 6, offsetM: -100 + Double(i) * 12, speed: 3)
        }
        h.advance(3)
        h.still()
        #expect((h.engine.state.stop?.crawlS ?? 99) < 30)
    }

    /// A car door or window moves cabin pressure for a moment; the net
    /// change ignores a 0.6 hPa spike in 1 s — even one as the window
    /// closes. A real climb counts.
    @Test func baroDeltaIgnoresAPointSixHectopascalSpikeInOneSecond() {
        let h = Harness()
        h.driveThenStop()
        let base = 101.3
        for s in 0...20 {
            let spike = s == 10 || s == 20
            h.altitude(relativeM: spike ? -5 : 0, pressureKPa: spike ? base + 0.06 : base)
            h.advance(1)
        }
        #expect(abs(h.engine.state.stop?.baroDeltaM ?? 99) < 0.01)
        // Up a ramp: 3 m over 15 s.
        for s in 1...15 {
            let climbed = Double(s) * 0.2
            h.altitude(relativeM: climbed, pressureKPa: base - climbed * 0.012)
            h.advance(1)
        }
        #expect(abs((h.engine.state.stop?.baroDeltaM ?? 0) - 3) < 0.05)
    }

    /// Readings with no stop being judged count for nothing.
    @Test func altitudeOutsideTheStopWindowIsIgnored() {
        let h = Harness()
        h.driving()
        h.altitude(relativeM: 10, pressureKPa: 101.18)
        #expect(h.engine.state.stop == nil)
        h.advance(1)
        h.still()
        #expect(h.engine.state.stop?.baroDeltaM == nil, "Nothing measured yet")
        h.altitude(relativeM: 0, pressureKPa: 101.3)
        h.advance(1)
        h.altitude(relativeM: 4, pressureKPa: 101.252)
        #expect(abs((h.engine.state.stop?.baroDeltaM ?? 0) - 4) < 0.01)
        #expect(h.raw.filter { $0 == .altitude }.count == 3, "Every reading is logged for replay")
    }

    /// The burst restarting (Precise granted mid-stop) restarts the
    /// altimeter at zero: that is a new baseline, not a 2 m drop.
    @Test func aRestartedAltimeterStartsFromANewBaseline() {
        let h = Harness()
        h.driveThenStop()
        h.altitude(relativeM: 0, pressureKPa: 101.3)
        h.advance(1)
        h.altitude(relativeM: 2, pressureKPa: 101.276)
        h.engine.requestFixes()
        h.advance(1)
        h.altitude(relativeM: 0, pressureKPa: 101.276)
        h.advance(1)
        h.altitude(relativeM: 1, pressureKPa: 101.264)
        #expect(abs((h.engine.state.stop?.baroDeltaM ?? 0) - 3) < 0.01)
    }

    /// detector-state.json as the previous build wrote it — no entry fix,
    /// GPS loss, barometer, or crawl — still restores mid-park.
    @Test func aStateSavedByThePreviousBuildStillRestores() throws {
        let json = #"{"wasDriving":false,"burstActive":true,"burstStartedAt":780000000,"stop":{"startedAt":780000000,"stopAt":780000000,"burstFixes":[],"fixesSeen":2,"unlocatedReported":false}}"#
        let state = try JSONDecoder().decode(ParkFusionEngine.State.self, from: Data(json.utf8))
        #expect(state.stop?.fixesSeen == 2)
        #expect(state.stop?.entryFix == nil)
        #expect(state.stop?.gpsLossAt == nil)
        #expect(state.stop?.baroDeltaM == nil)
    }
}
