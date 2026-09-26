import Foundation
import Testing

@testable import ParkAgent

/// The signal log read back and replayed through the engine: what the
/// phone recorded is exactly what a unit test can re-run.
@MainActor
struct SignalTraceTests {
    @Test func v2LinesBecomeTheEnginesInputs() throws {
        let log = """
        # parkagent signal log v2
        2026-09-15T14:30:00.000Z armed arm
        2026-09-15T14:30:01.000Z motion automotive high
        2026-09-15T14:30:02.500Z location_fix 42.352085,-71.070019 ±8m 10.0m/s age=1s
        2026-09-15T14:30:03.000Z fix_rejected coarse 42.350000,-71.070000 ±1500m
        2026-09-15T14:30:04.000Z audio_disconnect bluetooth
        2026-09-15T14:30:05.000Z audio_disconnect_ignored bluetooth
        2026-09-15T14:34:00.000Z visit_arrival 42.350380,-71.076300 ±25m age=200s
        2026-09-15T14:30:06.000Z park_fired motion_stop+audio_disconnect
        garbage line
        """
        let trace = SignalTrace.parse(log)
        #expect(trace.version == 2)
        #expect(trace.skipped == 1)
        let inputs = trace.events.filter { if case .decision = $0 { false } else { true } }
        #expect(inputs.count == 6)
        guard case .motion(let sample, _) = inputs[0] else { Issue.record("not motion"); return }
        #expect(sample.isDriving)
        guard case .fix(let fix, let handled) = inputs[1] else { Issue.record("not a fix"); return }
        #expect(fix.accuracy == 8)
        #expect(fix.speed == 10)
        #expect(handled.timeIntervalSince(fix.at) == 1, "age= must place the fix before its line")
        guard case .fix(let coarse, _) = inputs[2] else { Issue.record("rejected fix dropped"); return }
        #expect(coarse.accuracy == 1_500)
        guard case .visit(let visit, _) = inputs[5] else { Issue.record("not a visit"); return }
        #expect(visit.at == SignalTrace.parseDate("2026-09-15T14:30:40.000Z"))
        #expect(trace.decisions(.parkFired).count == 1)
    }

    /// A v1 log (before this PR) had transitions but no coordinates: its
    /// motion still replays, its fixes can't.
    @Test func v1LogsStillParse() {
        let log = """
        2026-09-10T10:00:00.000Z motion_driving
        2026-09-10T10:05:00.000Z motion_stop
        2026-09-10T10:05:01.000Z location_fix ±8m
        2026-09-10T10:05:10.000Z audio_disconnect
        """
        let trace = SignalTrace.parse(log)
        #expect(trace.version == 1)
        #expect(trace.skipped == 1)
        let motions = trace.events.filter { if case .motion = $0 { true } else { false } }
        #expect(motions.count == 2)
    }

    /// Round trip: what the engine logs, the parser reads back, and a
    /// replay of it decides exactly what the engine decided live.
    @Test func whatTheEngineLogsReplaysToTheSameDecisions() {
        final class Sink { var lines: [String] = [] }
        let sink = Sink()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let log = SignalLog(directory: dir)
        log.isEnabled = true
        log.clear()
        defer { log.clear(); log.isEnabled = false }

        let h = ParkFusionEngineTests.Harness()
        h.engine.onRawSignal = { signal, at, detail in log.append(signal, at: at, detail: detail) }
        h.driving()
        h.advance(30)
        h.still()
        for _ in 0..<3 { h.advance(1); h.fix() }
        h.advance(10)
        h.walking()
        #expect(h.parks.count == 1)

        let text = (try? String(contentsOf: log.fileURL, encoding: .utf8)) ?? ""
        sink.lines = text.split(separator: "\n").map(String.init)
        let replay = TraceReplay.run(SignalTrace.parse(text))
        #expect(replay.parks.count == 1, "Replay decided differently from the live engine:\n\(text)")
        #expect(replay.parks.first?.fix == h.parks.first?.fix)
    }

    // MARK: - A recorded drive

    /// The route recorded through the real detector (DetectorUITests, the
    /// simulator; see the file's header), replayed: the same single park,
    /// at the parking spot, and nothing at the red light 350 m before it.
    @Test func theRecordedRouteReplaysToOneParkAtTheSpot() throws {
        let bundle = Bundle(for: BundleMarker.self)
        let url = try #require(bundle.url(forResource: "sim-drive-park-walk", withExtension: "log"))
        let trace = SignalTrace.parse(try String(contentsOf: url, encoding: .utf8))
        #expect(trace.version == 2)
        #expect(trace.skipped == 0)

        // What the phone decided at the time…
        #expect(trace.decisions(.parkFired).count == 1)
        #expect(trace.decisions(.drivingResumedCleared).count == 1, "The red light should have been judged and cleared")

        // …is what the engine decides replaying it.
        let replay = TraceReplay.run(trace)
        #expect(replay.parks.count == 1)
        let park = try #require(replay.parks.first)
        let route = try RouteFixture.load(from: bundle)
        let spot = try #require(route.points(in: "park").first)
        let light = try #require(route.points(in: "light").first)
        let spotFix = ParkFix(latitude: spot.latitude, longitude: spot.longitude, accuracy: 0, at: park.at)
        let lightFix = ParkFix(latitude: light.latitude, longitude: light.longitude, accuracy: 0, at: park.at)
        #expect(park.fix.distance(to: spotFix) < 10, "Parked away from the spot")
        #expect(park.fix.distance(to: lightFix) > 300)
        let recorded = try #require(trace.decisions(.parkFired).first)
        #expect(abs(park.at.timeIntervalSince(recorded.at)) < 2, "Replay fired at a different moment")
        #expect(replay.raw.contains { $0.signal == .drivingResumedCleared })
    }
}
