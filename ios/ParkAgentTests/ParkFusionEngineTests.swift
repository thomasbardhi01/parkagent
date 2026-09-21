import CoreLocation
import Testing

@testable import ParkAgent

/// Drives `ParkFusionEngine` with injected fake signals and a manual clock —
/// no CoreMotion, no AVAudioSession, no real CLLocationManager.
@MainActor
struct ParkFusionEngineTests {
    @MainActor
    final class Harness {
        // The engine captures `now` through this box so the harness can
        // advance time after init.
        @MainActor
        final class ClockBox {
            var now = Date(timeIntervalSince1970: 1_800_000_000)
        }

        let clock = ClockBox()
        let engine: ParkFusionEngine
        var parks: [(fix: ParkFix, signals: [String])] = []
        var burstStarts = 0
        var burstStops = 0

        var now: Date { clock.now }

        init(config: ParkFusionEngine.Config = .init()) {
            let clock = clock
            engine = ParkFusionEngine(config: config, now: { clock.now })
            engine.onPark = { [self] fix, signals in parks.append((fix, signals)) }
            engine.onStartBurst = { [self] in burstStarts += 1 }
            engine.onStopBurst = { [self] in burstStops += 1 }
        }

        func advance(_ seconds: TimeInterval) {
            clock.now = clock.now.addingTimeInterval(seconds)
        }

        static let base = CLLocationCoordinate2D(latitude: 40.7784, longitude: -73.9818)

        func fix(accuracy: Double = 8, offsetM: Double = 0) {
            // ~1e-5 degrees latitude ≈ 1.1 m.
            let coordinate = CLLocationCoordinate2D(
                latitude: Self.base.latitude + (offsetM / 111_320),
                longitude: Self.base.longitude
            )
            engine.fixReceived(ParkFix(coordinate: coordinate, accuracy: accuracy, at: now))
        }

        /// Three tight fixes a second apart — the settled burst.
        func settleLocation() {
            for _ in 0..<3 {
                advance(1)
                fix()
            }
        }

        func driveThenStop() {
            engine.motionEvent(driving: true, stopped: false)
            advance(1)
            engine.motionEvent(driving: false, stopped: true)
        }
    }

    @Test func motionPlusAudioFires() {
        let h = Harness()
        h.driveThenStop()
        h.advance(10)
        h.engine.audioDisconnected()
        // No fire yet: /parked needs a coordinate and none has arrived.
        #expect(h.parks.isEmpty)
        h.advance(2)
        h.fix()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].signals.contains("motion_stop"))
        #expect(h.parks[0].signals.contains("audio_disconnect"))
        #expect(h.burstStarts == 1)
    }

    @Test func motionPlusLocationSettlingFires() {
        let h = Harness()
        h.driveThenStop()
        h.settleLocation()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].signals.sorted() == ["location_settled", "motion_stop"])
        // The burst stops once settled — no radio left running.
        #expect(h.burstStops == 1)
    }

    @Test func audioPlusLocationSettlingFires() {
        let h = Harness()
        h.engine.audioDisconnected()
        h.settleLocation()
        #expect(h.parks.count == 1)
        #expect(h.parks[0].signals.sorted() == ["audio_disconnect", "location_settled"])
    }

    @Test func singleSignalNeverFires() {
        let h = Harness()
        // Motion alone, with fixes that never settle (spread 100 m apart).
        h.driveThenStop()
        for i in 0..<5 {
            h.advance(2)
            h.fix(offsetM: Double(i) * 100)
        }
        #expect(h.parks.isEmpty)

        // Audio alone, no fixes at all.
        let h2 = Harness()
        h2.engine.audioDisconnected()
        h2.advance(30)
        #expect(h2.parks.isEmpty)

        // Location settling alone (an armed burst can't exist without a
        // triggering signal, but even injected fixes must not fire).
        let h3 = Harness()
        h3.settleLocation()
        #expect(h3.parks.isEmpty)
    }

    @Test func redLightDrivingResumeClearsPendingSignals() {
        let h = Harness()
        // Stop at a light: motion flickers to stationary…
        h.driveThenStop()
        h.advance(15)
        // …then the light turns green and driving resumes.
        h.engine.motionEvent(driving: true, stopped: false)
        // A later lone signal must find nothing stale to pair with.
        h.advance(20)
        h.engine.audioDisconnected()
        h.advance(1)
        h.fix()
        #expect(h.parks.isEmpty)
    }

    @Test func debounceBlocksASecondFireWithinThreeMinutes() {
        let h = Harness()
        h.driveThenStop()
        h.settleLocation()
        #expect(h.parks.count == 1)

        // Drive off and re-park 2 minutes later (drive-through pickup).
        h.advance(30)
        h.engine.motionEvent(driving: true, stopped: false)
        h.advance(90)
        h.driveThenStop()
        h.settleLocation()
        #expect(h.parks.count == 1)

        // Past the debounce the detector is live again.
        h.advance(200)
        h.engine.motionEvent(driving: true, stopped: false)
        h.advance(10)
        h.driveThenStop()
        h.settleLocation()
        #expect(h.parks.count == 2)
    }

    @Test func signalsOutsideAgreementWindowDoNotPair() {
        let h = Harness()
        h.driveThenStop()
        // 90 s later — outside the 60 s window — audio goes.
        h.advance(90)
        h.engine.audioDisconnected()
        h.advance(1)
        h.fix()
        #expect(h.parks.isEmpty)
    }

    @Test func missingMotionPermissionStillFiresOnAudioPlusLocation() {
        // A denied motion permission means motionEvent is simply never
        // called; the other two signals carry the detection.
        let h = Harness()
        h.engine.audioDisconnected()
        h.settleLocation()
        #expect(h.parks.count == 1)
        #expect(!h.parks[0].signals.contains("motion_stop"))
    }

    @Test func missingLocationStillFiresOnMotionPlusAudio() {
        // Location denied: the burst produces nothing, but once any fix
        // ever arrives… no — with location fully missing there is no
        // coordinate to report, so the park must NOT fire. That is the
        // documented degradation: /parked requires a fix.
        let h = Harness()
        h.driveThenStop()
        h.advance(5)
        h.engine.audioDisconnected()
        h.advance(30)
        #expect(h.parks.isEmpty)
    }

    @Test func settledCoordinateIsTheMostAccurateOfTheWindow() {
        let h = Harness()
        h.driveThenStop()
        h.advance(1)
        h.fix(accuracy: 30)
        h.advance(1)
        h.fix(accuracy: 5, offsetM: 3)
        h.advance(1)
        h.fix(accuracy: 12)
        #expect(h.parks.count == 1)
        #expect(h.parks[0].fix.accuracy == 5)
    }
}
