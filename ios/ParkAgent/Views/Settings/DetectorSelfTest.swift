#if DEBUG
import AVFoundation
import CoreLocation
import CoreMotion
import Foundation
import Observation
import UserNotifications

/// Diagnostics' "Detector self-test": checks every capability and every
/// signal source live, on this phone, right now, and says pass or fail with
/// the evidence. Run it before a field-test drive; each failure names what
/// to fix.
@MainActor
@Observable
final class DetectorSelfTest {
    enum Outcome: String {
        case pass, warn, fail
    }

    struct Check: Identifiable, Equatable {
        let id: String
        let title: String
        let outcome: Outcome
        let detail: String
    }

    private(set) var checks: [Check] = []
    private(set) var isRunning = false

    var passed: Bool { !checks.isEmpty && !checks.contains { $0.outcome == .fail } }

    func run(model: AppModel, permissions: PermissionsManager) async {
        guard !isRunning else { return }
        isRunning = true
        checks = []
        defer { isRunning = false }

        await permissions.refresh()
        let caps = permissions.capabilities

        add("services", "Location Services",
            caps.locationServicesEnabled ? .pass : .fail,
            caps.locationServicesEnabled ? "On" : "Off for the whole phone")
        add("location", "Location permission",
            caps.location == .always ? .pass : (caps.location == .whileUsing ? .warn : .fail),
            caps.value(of: .location))
        add("precise", "Precise Location", caps.preciseLocation ? .pass : .fail, caps.value(of: .precise))

        // A real fix, now: the thing a park needs.
        if caps.locationUsable {
            let started = Date.now
            let fix = await currentFix()
            let took = Date.now.timeIntervalSince(started)
            if let fix {
                let good = fix.horizontalAccuracy <= FixGate.Config().maxAccuracyM
                add("fix", "Live location fix", good ? .pass : .warn,
                    String(format: "±%.0f m in %.1f s%@", fix.horizontalAccuracy, took, good ? "" : " — too coarse to pick a block"))
            } else {
                add("fix", "Live location fix", .fail, "No fix at all in 15 s")
            }
        } else {
            add("fix", "Live location fix", .fail, "Location not allowed")
        }

        // Motion: allowed, and the system's history answers.
        switch caps.motion {
        case .unavailable:
            add("motion", "Motion activity", .warn, "No motion hardware (simulator?)")
        case .authorized:
            let samples = await motionHistory()
            if let latest = samples.last {
                let ago = Int(Date.now.timeIntervalSince(latest.at) / 60)
                add("motion", "Motion activity", .pass,
                    "\(samples.count) readings in the last hour; latest \(ParkFusionEngine.describeKinds(latest)), \(ago) min ago")
            } else {
                add("motion", "Motion activity", .warn, "Allowed, but no readings in the last hour")
            }
        default:
            add("motion", "Motion activity", .fail, caps.value(of: .motion))
        }

        // Car audio: what the phone is playing through now (a car only
        // counts if it's connected — this is informational).
        let route = AVAudioSession.sharedInstance().currentRoute
        let outputs = route.outputs.map(\.portName).joined(separator: ", ")
        let port = CarAudioSource.port(of: route)
        add("audio", "Car audio route", .pass,
            port.map { "Connected: \($0 == .carPlay ? "CarPlay" : "Bluetooth") (\(outputs))" }
                ?? "No car connected now (\(outputs.isEmpty ? "none" : outputs)). Disconnecting one is a park signal.")

        // Background: what makes iOS wake or relaunch the app between drives.
        let detector = model.detector
        add("armed", "Detector armed", detector.isArmed ? .pass : .fail,
            detector.isArmed ? "Mode: \(detector.mode.rawValue)" : "Not armed — finish onboarding")
        add("wakes", "Background wake-ups",
            detector.monitoringSignificantChanges && detector.monitoringVisits ? .pass : .fail,
            "Significant-change \(detector.monitoringSignificantChanges ? "on" : "off"), visits \(detector.monitoringVisits ? "on" : "off")")
        add("refresh", "Background App Refresh",
            caps.backgroundRefresh == .available ? .pass : .warn, caps.value(of: .backgroundRefresh))
        add("power", "Low Power Mode", caps.lowPowerMode ? .warn : .pass, caps.lowPowerMode ? "On" : "Off")

        // Notifications: a park in the background is only heard about this way.
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = caps.notifications == .authorized || caps.notifications == .provisional
        let timeSensitive = settings.timeSensitiveSetting == .enabled
        add("notifications", "Notifications",
            allowed ? (timeSensitive ? .pass : .warn) : .fail,
            allowed ? (timeSensitive ? "Allowed, time-sensitive on" : "Allowed, but time-sensitive is off") : caps.value(of: .notifications))

        // The server that /parked goes to.
        await model.loadPolicy()
        add("server", "Server", model.policyLoadFailed ? .fail : .pass,
            model.policyLoadFailed ? "Couldn't reach it" : "Reachable")
    }

    private func add(_ id: String, _ title: String, _ outcome: Outcome, _ detail: String) {
        checks.append(Check(id: id, title: title, outcome: outcome, detail: detail))
    }

    private func currentFix() async -> CLLocation? {
        await OneShotLocation.requestLocation(goodEnoughM: 20, timeout: .seconds(15))
    }

    private func motionHistory() async -> [MotionSample] {
        let manager = CMMotionActivityManager()
        return await withCheckedContinuation { continuation in
            manager.queryActivityStarting(from: .now.addingTimeInterval(-3600), to: .now, to: .main) { activities, _ in
                continuation.resume(returning: (activities ?? []).map(MotionSample.init))
            }
        }
    }
}
#endif
