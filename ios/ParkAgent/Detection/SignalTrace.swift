import Foundation

/// A signal log read back as the engine's inputs, so a recorded drive can
/// be replayed through `ParkFusionEngine` exactly as the phone saw it (see
/// ParkAgentTests' trace fixtures). Input lines become events; decision
/// lines (park_fired, location_settled, …) are kept for comparison.
struct SignalTrace {
    enum Event {
        case motion(MotionSample, handledAt: Date)
        case audio(ParkFusionEngine.AudioPort, at: Date)
        case fix(ParkFix, handledAt: Date)
        case visit(ParkFix, handledAt: Date)
        /// What the recording engine decided (not fed back in).
        case decision(RawDetectorSignal, at: Date, detail: String?)

        var handledAt: Date {
            switch self {
            case .motion(_, let at), .audio(_, let at), .fix(_, let at), .visit(_, let at), .decision(_, let at, _): at
            }
        }
    }

    var version = 1
    var events: [Event] = []
    /// Lines that couldn't be read (v1 fixes carry no coordinates).
    var skipped = 0

    static func parse(_ text: String) -> SignalTrace {
        var trace = SignalTrace()
        var sawMotionLines = false
        var legacyMotion: [Event] = []
        for raw in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw)
            if line.hasPrefix("#") {
                if line.contains("v2") { trace.version = 2 }
                continue
            }
            let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
            guard parts.count >= 2, let at = parseDate(parts[0]),
                  let signal = RawDetectorSignal(rawValue: parts[1])
            else {
                trace.skipped += 1
                continue
            }
            let detail = parts.count > 2 ? parts[2] : nil
            switch signal {
            case .motionSample:
                guard let detail, let sample = parseMotion(detail, handledAt: at) else {
                    trace.skipped += 1
                    continue
                }
                sawMotionLines = true
                trace.events.append(.motion(sample, handledAt: at))
            case .audioDisconnect, .audioIgnored:
                let port = detail.flatMap { ParkFusionEngine.AudioPort(rawValue: $0) } ?? .bluetooth
                trace.events.append(.audio(port, at: at))
                // v1 logged audio only as a decision; it was an input too.
            case .fix, .fixRejected:
                var fixText = detail ?? ""
                if signal == .fixRejected, let space = fixText.firstIndex(of: " ") {
                    fixText = String(fixText[fixText.index(after: space)...])
                }
                guard let fix = parseFix(fixText, handledAt: at) else {
                    trace.skipped += 1
                    continue
                }
                trace.events.append(.fix(fix, handledAt: at))
            case .visitArrival:
                guard let detail, let fix = parseFix(detail, handledAt: at) else {
                    trace.skipped += 1
                    continue
                }
                trace.events.append(.visit(fix, handledAt: at))
            case .motionDriving:
                // v1 had no raw motion lines: its transitions stand in.
                legacyMotion.append(.motion(MotionSample(at: at, automotive: true), handledAt: at))
                trace.events.append(.decision(signal, at: at, detail: detail))
            case .motionStop:
                legacyMotion.append(.motion(MotionSample(at: at, stationary: true), handledAt: at))
                trace.events.append(.decision(signal, at: at, detail: detail))
            default:
                trace.events.append(.decision(signal, at: at, detail: detail))
            }
        }
        if !sawMotionLines, !legacyMotion.isEmpty {
            trace.events = (trace.events + legacyMotion).sorted { $0.handledAt < $1.handledAt }
        }
        return trace
    }

    /// The recording's own decisions of one kind, in order.
    func decisions(_ signal: RawDetectorSignal) -> [(at: Date, detail: String?)] {
        events.compactMap {
            if case .decision(signal, let at, let detail) = $0 { return (at, detail) }
            return nil
        }
    }

    // MARK: - Line parsing

    // ISO8601DateFormatter is documented thread-safe.
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) private static let whole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parseDate(_ text: String) -> Date? {
        fractional.date(from: text) ?? whole.date(from: text)
    }

    /// "age=12s" anywhere in the detail: the event happened that long
    /// before the line's time.
    private static func age(in detail: String) -> TimeInterval {
        guard let range = detail.range(of: #"age=(\d+(?:\.\d+)?)s"#, options: .regularExpression) else { return 0 }
        let text = detail[range].dropFirst(4).dropLast()
        return TimeInterval(text) ?? 0
    }

    /// "lat,lng ±accm [speed m/s] [age=Ns]"
    static func parseFix(_ detail: String, handledAt: Date) -> ParkFix? {
        let tokens = detail.split(separator: " ").map(String.init)
        guard let first = tokens.first else { return nil }
        let coords = first.split(separator: ",")
        guard coords.count == 2, let lat = Double(coords[0]), let lng = Double(coords[1]),
              let accText = tokens.first(where: { $0.hasPrefix("±") && $0.hasSuffix("m") }),
              let accuracy = Double(accText.dropFirst().dropLast())
        else { return nil }
        let speed = tokens.first(where: { $0.hasSuffix("m/s") }).flatMap { Double($0.dropLast(3)) }
        return ParkFix(
            latitude: lat,
            longitude: lng,
            accuracy: accuracy,
            at: handledAt.addingTimeInterval(-age(in: detail)),
            speed: speed
        )
    }

    /// "automotive,stationary high [age=Ns]"
    static func parseMotion(_ detail: String, handledAt: Date) -> MotionSample? {
        let tokens = detail.split(separator: " ").map(String.init)
        guard tokens.count >= 2 else { return nil }
        let kinds = Set(tokens[0].split(separator: ",").map(String.init))
        let confidence: MotionSample.Confidence
        switch tokens[1] {
        case "low": confidence = .low
        case "medium": confidence = .medium
        case "high": confidence = .high
        default: return nil
        }
        return MotionSample(
            at: handledAt.addingTimeInterval(-age(in: detail)),
            automotive: kinds.contains("automotive"),
            stationary: kinds.contains("stationary"),
            walking: kinds.contains("walking"),
            running: kinds.contains("running"),
            cycling: kinds.contains("cycling"),
            confidence: confidence
        )
    }
}

/// Feeds a trace through a fresh engine on a clock that follows the log,
/// firing the engine's deadlines in between, exactly as the detector's
/// timer would have.
@MainActor
enum TraceReplay {
    struct Park {
        var at: Date
        var fix: ParkFix
        var signals: [String]
    }

    struct Result {
        var parks: [Park] = []
        var unlocated: [Date] = []
        var raw: [(signal: RawDetectorSignal, at: Date)] = []
    }

    final class Clock {
        var now: Date
        init(_ now: Date) { self.now = now }
    }

    static func run(_ trace: SignalTrace, config: ParkFusionEngine.Config = .init()) -> Result {
        let inputs = trace.events.filter {
            if case .decision = $0 { return false }
            return true
        }
        guard let first = inputs.first else { return Result() }
        let clock = Clock(first.handledAt)
        let engine = ParkFusionEngine(config: config, now: { clock.now })
        var result = Result()
        engine.onPark = { fix, signals in result.parks.append(Park(at: clock.now, fix: fix, signals: signals)) }
        engine.onUnlocatedPark = { _ in result.unlocated.append(clock.now) }
        engine.onRawSignal = { signal, at, _ in result.raw.append((signal, at)) }

        func advance(to time: Date) {
            // Deadlines that fall before the next event fire first, the way
            // the detector's timer would; bounded so a stuck deadline can't
            // spin.
            var guardCount = 0
            while let deadline = engine.nextDeadline, deadline <= time, guardCount < 100 {
                clock.now = max(clock.now, deadline)
                engine.tick()
                guardCount += 1
            }
            clock.now = max(clock.now, time)
        }

        for event in inputs {
            advance(to: event.handledAt)
            switch event {
            case .motion(let sample, _): engine.motion(sample)
            case .audio(let port, let at): engine.audioDisconnected(port: port, at: at)
            case .fix(let fix, _): engine.fixReceived(fix)
            case .visit(let fix, _): engine.visitArrived(fix)
            case .decision: break
            }
        }
        // Let anything still pending play out (a sustained stop, a TTL).
        advance(to: clock.now.addingTimeInterval(config.stopTTL + 60))
        return result
    }
}
