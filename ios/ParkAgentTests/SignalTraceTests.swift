import CoreLocation
import Foundation
import Testing

@testable import ParkAgent

/// The traces in ios/Fixtures/Traces that carry a truth sidecar.
private let tracesWithTruth = ["garage-underground", "home-driveway", "sim-drive-park-walk"]

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

    // MARK: - Place evidence (FR-53)

    /// Barometer readings are inputs the replay feeds back; the entry fix
    /// and a GPS loss are the engine's own decisions, kept for comparison.
    @Test func altitudeEntryFixAndGpsLossLinesParse() throws {
        let log = """
        # parkagent signal log v2
        2026-09-15T14:30:00.000Z altitude 3.20m 101.2616kPa age=1s
        2026-09-15T14:30:01.000Z entry_fix 42.350380,-71.076300 ±8m 2.5m/s
        2026-09-15T14:30:02.000Z gps_lost accuracy ±300m
        2026-09-15T14:30:03.000Z altitude bogus
        """
        let trace = SignalTrace.parse(log)
        #expect(trace.skipped == 1)
        guard case .altitude(let sample, let handled) = trace.events[0] else {
            Issue.record("not an altitude reading")
            return
        }
        #expect(sample.relativeAltitudeM == 3.2)
        #expect(sample.pressureKPa == 101.2616)
        #expect(handled.timeIntervalSince(sample.at) == 1)
        let entry = try #require(trace.decisions(.entryFix).first)
        #expect(SignalTrace.parseFix(entry.detail ?? "", handledAt: entry.at)?.speed == 2.5)
        #expect(trace.decisions(.gpsLost).count == 1)
    }

    /// What the engine logs about a garage park — its fixes, the loss, the
    /// barometer — replays to the same evidence.
    @Test func placeEvidenceRoundTripsThroughTheLog() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let log = SignalLog(directory: dir)
        log.isEnabled = true
        log.clear()
        defer { log.clear(); log.isEnabled = false }

        let h = ParkFusionEngineTests.Harness()
        h.engine.onRawSignal = { signal, at, detail in log.append(signal, at: at, detail: detail) }
        h.driving()
        for i in 0..<12 {
            h.advance(3)
            h.fix(accuracy: 6, offsetM: -60 + Double(i) * 3, speed: 3)
        }
        h.advance(1)
        h.fix(accuracy: 400, offsetM: -20)
        for _ in 0..<3 {
            h.advance(10)
            h.driving()
        }
        h.still()
        for s in 0..<30 {
            h.altitude(relativeM: s < 10 ? 0 : min(4, Double(s - 10) * 0.4), pressureKPa: 101.3 - (s < 10 ? 0 : min(4, Double(s - 10) * 0.4)) * 0.012)
            h.advance(1)
            if s == 5 { h.engine.audioDisconnected(port: .bluetooth) }
            if s == 15 { h.walking() }
        }
        h.advance(200)
        let live = try #require(h.outcomes.last)
        #expect(live.fix == nil)

        let text = (try? String(contentsOf: log.fileURL, encoding: .utf8)) ?? ""
        let trace = SignalTrace.parse(text)
        #expect(trace.skipped == 0)
        let replay = TraceReplay.run(trace)
        let replayed = try #require(replay.outcomes.last, "Replay decided nothing:\n\(text)")
        #expect(replayed.fix == nil)
        let entry = try #require(replayed.entryFix)
        let liveEntry = try #require(live.entryFix)
        #expect(entry.distance(to: liveEntry) < 1)
        #expect(abs((replayed.gpsLossAt ?? .distantPast).timeIntervalSince(live.gpsLossAt ?? .distantFuture)) < 0.01)
        #expect(abs((replayed.baroDeltaM ?? 0) - (live.baroDeltaM ?? 99)) < 0.02)
        #expect(abs((live.baroDeltaM ?? 0) - 4) < 0.02)
        #expect(abs((replayed.crawlS ?? 0) - (live.crawlS ?? 99)) < 0.01)
        // The log says what it decided, for a field log read by eye.
        #expect(trace.decisions(.entryFix).count >= 1)
        #expect(trace.decisions(.gpsLost).count == 1)
    }

    // MARK: - Traces with a truth sidecar

    /// What a trace's `<name>.truth.json` says: the place it really was,
    /// what the phone knew then, and what the classifier must answer.
    struct TruthSidecar: Decodable {
        struct Remembered: Decodable {
            var name: String?
            var placeClass: String
            var lat: Double
            var lng: Double
            var visits: Int
            enum CodingKeys: String, CodingKey { case name, placeClass = "class", lat, lng, visits }
        }

        struct Context: Decodable {
            var footprints: String?
            var memory: [Remembered]
            var zones: String
        }

        struct Expect: Decodable {
            var placeClass: String
            var minConfidence: Double?
            var footprintId: String?
            var located: Bool
            var gpsLoss: Bool?
            var baroDeltaM: Double?
            var memoryHit: Bool?
            var withoutMemory: String?
            var never: [String]?
            enum CodingKeys: String, CodingKey {
                case placeClass = "class", minConfidence, footprintId, located, gpsLoss, baroDeltaM, memoryHit, withoutMemory, never
            }
        }

        var trace: String
        var context: Context
        var expect: Expect
    }

    /// Every sidecar in the bundle is replayed below — a new field trace
    /// can't be added and silently skipped.
    @Test func everyTruthSidecarIsReplayed() {
        let bundle = Bundle(for: BundleMarker.self)
        let names = (bundle.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [])
            .map(\.lastPathComponent)
            .filter { $0.hasSuffix(".truth.json") }
            .map { String($0.dropLast(".truth.json".count)) }
        #expect(Set(names) == Set(tracesWithTruth))
    }

    /// A recorded (or, until the field test, synthesized) park replays
    /// through the engine and the classifier to the place it really was.
    @Test(arguments: tracesWithTruth)
    func aTraceClassifiesAsItsTruth(_ name: String) throws {
        let bundle = Bundle(for: BundleMarker.self)
        let sidecarURL = try #require(bundle.url(forResource: "\(name).truth", withExtension: "json"))
        let sidecar = try JSONDecoder().decode(TruthSidecar.self, from: Data(contentsOf: sidecarURL))
        let logURL = try #require(bundle.url(forResource: (sidecar.trace as NSString).deletingPathExtension, withExtension: "log"))
        let trace = SignalTrace.parse(try String(contentsOf: logURL, encoding: .utf8))
        #expect(trace.skipped == 0)

        let replay = TraceReplay.run(trace)
        let outcome = try #require(replay.outcomes.last, "\(name): the replay never parked")
        #expect((outcome.fix != nil) == sidecar.expect.located)

        let footprints: [Footprint]
        if let file = sidecar.context.footprints {
            let url = try #require(bundle.url(forResource: (file as NSString).deletingPathExtension, withExtension: "json"))
            footprints = try LinearFootprintIndex(json: Data(contentsOf: url)).footprints
        } else {
            footprints = []
        }
        var memory = PlaceMemory()
        for place in sidecar.context.memory {
            let placeClass = try #require(PlaceClass(rawValue: place.placeClass))
            for visit in 0..<place.visits {
                memory.confirm(placeClass, at: CLLocationCoordinate2D(latitude: place.lat, longitude: place.lng),
                               name: place.name, now: outcome.stopAt.addingTimeInterval(-Double(place.visits - visit) * 86_400))
            }
        }
        let zones = try #require(ZoneHint(rawValue: sidecar.context.zones))
        let index = LinearFootprintIndex(footprints: footprints)
        let result = PlaceClassifier.classify(park: outcome, memory: memory, footprints: index, zones: zones)

        #expect(result.placeClass.rawValue == sidecar.expect.placeClass, "\(name): \(result)")
        if let minimum = sidecar.expect.minConfidence { #expect(result.confidence >= minimum, "\(name)") }
        if let id = sidecar.expect.footprintId { #expect(result.inputs.footprintId == id, "\(name)") }
        if let loss = sidecar.expect.gpsLoss { #expect(result.inputs.gpsLoss == loss, "\(name)") }
        if let hit = sidecar.expect.memoryHit { #expect(result.inputs.memoryHit == hit, "\(name)") }
        if let baro = sidecar.expect.baroDeltaM { #expect(abs((outcome.baroDeltaM ?? 0) - baro) < 0.1, "\(name): the door's spike leaked in?") }
        for never in sidecar.expect.never ?? [] {
            #expect(result.placeClass.rawValue != never, "\(name) must never be \(never)")
        }
        if let cold = sidecar.expect.withoutMemory {
            let withoutMemory = PlaceClassifier.classify(park: outcome, memory: PlaceMemory(), footprints: index, zones: zones)
            #expect(withoutMemory.placeClass.rawValue == cold, "\(name) without its saved places")
        }
    }
}
