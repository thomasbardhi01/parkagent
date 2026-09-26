import CoreLocation
import CoreMotion
import Foundation
import Observation
import UIKit
import UserNotifications

/// The one live answer to "what can park detection use right now?"
/// (`capabilities`), and the one place that asks iOS for more.
///
/// The snapshot is re-read whenever it can have changed: the location
/// delegate's authorization callback, the app coming back to the
/// foreground (the user may have flipped anything in Settings), Background
/// App Refresh and Low Power Mode notifications. Home's banner, onboarding,
/// Account → Privacy, Diagnostics, and the detector all read it, so none of
/// them can disagree.
@MainActor
@Observable
final class PermissionsManager: NSObject, CLLocationManagerDelegate {
    private(set) var capabilities = DetectionCapabilities()
    /// Called after every change, for the detector and the reporter.
    @ObservationIgnored var onChange: ((DetectionCapabilities) -> Void)?

    /// iOS shows its "Change to Always Allow" prompt once per install. Once
    /// it has been asked, the only road to Always is Settings.
    private(set) var alwaysUpgradeAvailable: Bool

    /// The purpose key for the one-time full-accuracy prompt (Info.plist
    /// NSLocationTemporaryUsageDescriptionDictionary, see project.yml).
    static let precisePurposeKey = "ParkLocation"
    static let alwaysPromptUsedKey = "locationAlwaysPromptUsed"

    private let locationManager = CLLocationManager()
    private let motionManager = CMMotionActivityManager()
    @ObservationIgnored private var observers: [any NSObjectProtocol] = []

    /// Waiters for an answer to a prompt in flight.
    @ObservationIgnored private var locationWaiter: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var alwaysWaiter: CheckedContinuation<AlwaysUpgradeOutcome, Never>?
    /// The Always prompt resigns the app active; seeing that is how a shown
    /// prompt is told apart from one iOS silently skipped.
    @ObservationIgnored private var alwaysPromptSeen = false

    #if DEBUG
    /// UI tests pin the snapshot with `-capabilities` instead of asking the
    /// simulator, whose grants they can't set. Requests then answer from
    /// the override's script.
    @ObservationIgnored private var override: CapabilityOverride?
    #endif

    override init() {
        alwaysUpgradeAvailable = !UserDefaults.standard.bool(forKey: Self.alwaysPromptUsedKey)
        super.init()
        #if DEBUG
        if let override = CapabilityOverride.fromLaunchArguments() {
            self.override = override
            capabilities = override.capabilities
            alwaysUpgradeAvailable = override.alwaysPrompt != .notShown
            return
        }
        #endif
        locationManager.delegate = self
        capabilities.location = Self.location(from: locationManager.authorizationStatus)
        capabilities.preciseLocation = locationManager.accuracyAuthorization == .fullAccuracy
        capabilities.motion = Self.motion()
        capabilities.backgroundRefresh = Self.backgroundRefresh(UIApplication.shared.backgroundRefreshStatus)
        capabilities.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        observe()
        Task { await refresh() }
    }

    // MARK: - Reading

    /// Re-read everything from iOS.
    func refresh() async {
        #if DEBUG
        if override != nil { return }
        #endif
        var next = capabilities
        // Apple: this can stall the main thread, so it runs off it.
        next.locationServicesEnabled = await Task.detached { CLLocationManager.locationServicesEnabled() }.value
        next.location = Self.location(from: locationManager.authorizationStatus)
        next.preciseLocation = locationManager.accuracyAuthorization == .fullAccuracy
        next.motion = Self.motion()
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        next.notifications = Self.notifications(from: settings.authorizationStatus)
        next.backgroundRefresh = Self.backgroundRefresh(UIApplication.shared.backgroundRefreshStatus)
        next.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        publish(next)
    }

    private func publish(_ next: DetectionCapabilities) {
        guard next != capabilities else { return }
        capabilities = next
        onChange?(next)
    }

    private func observe() {
        let center = NotificationCenter.default
        let refreshOn: [Notification.Name] = [
            // Anything may have changed in Settings while we were away.
            UIApplication.didBecomeActiveNotification,
            UIApplication.backgroundRefreshStatusDidChangeNotification,
            Notification.Name.NSProcessInfoPowerStateDidChange,
        ]
        for name in refreshOn {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.refresh() }
            })
        }
        // The Always prompt, like every system alert, resigns the app
        // active while it's up, and hands it back when answered.
        observers.append(center.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.alwaysWaiter != nil else { return }
                self.alwaysPromptSeen = true
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.alwaysWaiter != nil, self.alwaysPromptSeen else { return }
                let location = Self.location(from: self.locationManager.authorizationStatus)
                self.finishAlways(location == .always ? .granted : .declined)
            }
        })
    }

    // MARK: - Acting

    /// What a tap on a banner, a Privacy row, or an onboarding row does.
    /// Returns the Always-upgrade outcome when the action asked for it.
    @discardableResult
    func perform(_ action: CapabilityAction) async -> AlwaysUpgradeOutcome? {
        switch action {
        case .requestLocation: return await requestLocation()
        case .requestAlways: return await requestAlwaysUpgrade()
        case .requestMotion: await requestMotion()
        case .requestNotifications: await requestNotifications()
        case .requestTemporaryPrecise: _ = await requestTemporaryPrecise()
        case .openAppSettings: open(UIApplication.openSettingsURLString)
        case .openNotificationSettings: open(UIApplication.openNotificationSettingsURLString)
        case .none: break
        }
        return nil
    }

    enum AlwaysUpgradeOutcome: Equatable, Sendable {
        case granted
        /// The user chose "Keep Only While Using".
        case declined
        /// iOS didn't show the prompt (already used, or Allow Once). Only
        /// Settings can grant Always now.
        case notShown
        /// Location itself was refused, so there was nothing to upgrade.
        case locationRefused
    }

    /// While Using first (the only prompt iOS shows from "not asked"), then
    /// the Always upgrade straight away, while the user is looking at it.
    func requestLocation() async -> AlwaysUpgradeOutcome {
        #if DEBUG
        if var override {
            override.capabilities.location = override.whenAsked
            apply(override)
            guard override.whenAsked == .whileUsing else {
                return override.whenAsked == .always ? .granted : .locationRefused
            }
            return await requestAlwaysUpgrade()
        }
        #endif
        // Nothing to ask with Location Services off: iOS shows no prompt,
        // and waiting for an answer would wait forever.
        guard capabilities.locationServicesEnabled else { return .locationRefused }
        if capabilities.location == .notDetermined {
            await withCheckedContinuation { continuation in
                locationWaiter = continuation
                locationManager.requestWhenInUseAuthorization()
            }
        }
        switch capabilities.location {
        case .always: return .granted
        case .whileUsing: return await requestAlwaysUpgrade()
        default: return .locationRefused
        }
    }

    /// iOS's "Change to Always Allow" prompt. It appears at most once per
    /// install and only in the foreground; when it doesn't appear, or the
    /// user keeps While Using, the caller explains the Settings route.
    func requestAlwaysUpgrade() async -> AlwaysUpgradeOutcome {
        if capabilities.location == .always { return .granted }
        guard capabilities.location == .whileUsing else { return .locationRefused }
        markAlwaysPromptUsed()
        #if DEBUG
        if var override {
            switch override.alwaysPrompt {
            case .accept:
                override.capabilities.location = .always
                override.alwaysPrompt = .notShown
                apply(override)
                return .granted
            case .decline:
                override.alwaysPrompt = .notShown
                apply(override)
                return .declined
            case .notShown:
                return .notShown
            }
        }
        #endif
        guard alwaysWaiter == nil else { return .notShown }
        alwaysPromptSeen = false
        return await withCheckedContinuation { continuation in
            alwaysWaiter = continuation
            locationManager.requestAlwaysAuthorization()
            // No resign-active within a beat means no prompt is coming.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.5))
                guard let self, !self.alwaysPromptSeen else { return }
                self.finishAlways(.notShown)
            }
        }
    }

    private func finishAlways(_ outcome: AlwaysUpgradeOutcome) {
        guard let waiter = alwaysWaiter else { return }
        alwaysWaiter = nil
        alwaysPromptSeen = false
        waiter.resume(returning: outcome)
        Task { await refresh() }
    }

    private func markAlwaysPromptUsed() {
        UserDefaults.standard.set(true, forKey: Self.alwaysPromptUsedKey)
        alwaysUpgradeAvailable = false
    }

    /// Full accuracy for this session, with the purpose string saying why.
    /// iOS only shows it while the app is in use, so a park detected in
    /// the background can't ask; the caller says so instead.
    func requestTemporaryPrecise() async -> Bool {
        #if DEBUG
        if var override {
            override.capabilities.preciseLocation = true
            apply(override)
            return true
        }
        #endif
        if capabilities.preciseLocation { return true }
        guard UIApplication.shared.applicationState == .active else { return false }
        _ = try? await locationManager.requestTemporaryFullAccuracyAuthorization(
            withPurposeKey: Self.precisePurposeKey
        )
        await refresh()
        return capabilities.preciseLocation
    }

    /// There is no request API for motion; a trivial history query prompts.
    func requestMotion() async {
        #if DEBUG
        if var override {
            if override.capabilities.motion == .notDetermined { override.capabilities.motion = .authorized }
            apply(override)
            return
        }
        #endif
        guard CMMotionActivityManager.isActivityAvailable() else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            motionManager.queryActivityStarting(from: .now.addingTimeInterval(-60), to: .now, to: .main) { _, _ in
                continuation.resume()
            }
        }
        await refresh()
    }

    func requestNotifications() async {
        #if DEBUG
        if var override {
            if override.capabilities.notifications == .notDetermined {
                override.capabilities.notifications = .authorized
            }
            apply(override)
            return
        }
        #endif
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])
        await refresh()
    }

    private func open(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
    }

    #if DEBUG
    private func apply(_ next: CapabilityOverride) {
        override = next
        alwaysUpgradeAvailable = next.alwaysPrompt != .notShown
        publish(next.capabilities)
    }
    #endif

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        let precise = manager.accuracyAuthorization == .fullAccuracy
        Task { @MainActor in
            var next = self.capabilities
            next.location = Self.location(from: status)
            next.preciseLocation = precise
            self.publish(next)
            if status != .notDetermined, let waiter = self.locationWaiter {
                self.locationWaiter = nil
                waiter.resume()
            }
            if status == .authorizedAlways { self.finishAlways(.granted) }
            // Services may have been switched off, which also lands here.
            await self.refresh()
        }
    }

    // MARK: - Mapping

    static func location(from status: CLAuthorizationStatus) -> DetectionCapabilities.Location {
        switch status {
        case .authorizedAlways: .always
        case .authorizedWhenInUse: .whileUsing
        case .denied: .denied
        case .restricted: .restricted
        default: .notDetermined
        }
    }

    static func motion() -> DetectionCapabilities.Motion {
        guard CMMotionActivityManager.isActivityAvailable() else { return .unavailable }
        switch CMMotionActivityManager.authorizationStatus() {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        default: return .notDetermined
        }
    }

    static func notifications(from status: UNAuthorizationStatus) -> DetectionCapabilities.Notifications {
        switch status {
        case .authorized, .ephemeral: .authorized
        case .provisional: .provisional
        case .denied: .denied
        default: .notDetermined
        }
    }

    static func backgroundRefresh(_ status: UIBackgroundRefreshStatus) -> DetectionCapabilities.BackgroundRefresh {
        switch status {
        case .available: .available
        case .denied: .denied
        case .restricted: .restricted
        @unknown default: .available
        }
    }
}
