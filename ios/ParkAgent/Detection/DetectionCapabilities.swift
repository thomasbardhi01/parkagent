import Foundation

/// Everything park detection depends on that the user or iOS controls, as
/// one plain value. `PermissionsManager` reads it live from the system; the
/// rules below decide what works, what doesn't, and what to say about it.
/// Pure, so every combination is unit-tested without a phone.
struct DetectionCapabilities: Equatable, Sendable {
    enum Location: String, Sendable {
        /// iOS Settings says "Ask Next Time Or When I Share".
        case notDetermined
        case whileUsing
        case always
        /// iOS Settings says "Never".
        case denied
        /// Blocked by Screen Time or a device profile; the user can't change it here.
        case restricted
    }

    enum Motion: String, Sendable {
        case authorized, notDetermined, denied, restricted
        /// No motion coprocessor (the simulator, some iPads).
        case unavailable
    }

    enum Notifications: String, Sendable {
        case authorized, provisional, notDetermined, denied
    }

    enum BackgroundRefresh: String, Sendable {
        case available, denied, restricted
    }

    /// Location Services switched off for the whole phone. When it is off
    /// iOS reports every app as denied, so this is checked first.
    var locationServicesEnabled = true
    var location: Location = .notDetermined
    /// Precise Location. Off, iOS hands out fixes blurred to a few
    /// kilometers, which can't tell one block from the next.
    var preciseLocation = true
    var motion: Motion = .notDetermined
    var notifications: Notifications = .notDetermined
    var backgroundRefresh: BackgroundRefresh = .available
    var lowPowerMode = false

    // MARK: - What works

    enum DetectionLevel: Equatable, Sendable {
        /// Detects parks with the app closed, and iOS relaunches it.
        case full
        /// Detects parks only while ParkAgent is open or was opened during
        /// the drive (While Using).
        case whileOpen
        /// No location, so no parks at all.
        case off
    }

    var locationUsable: Bool {
        locationServicesEnabled && (location == .whileUsing || location == .always)
    }

    var detectionLevel: DetectionLevel {
        guard locationUsable else { return .off }
        return location == .always ? .full : .whileOpen
    }

    /// True when nothing is missing or reduced. Low Power Mode isn't a
    /// grant, so it doesn't count against this.
    var fullyGranted: Bool {
        detectionLevel == .full
            && preciseLocation
            && (motion == .authorized || motion == .unavailable)
            && (notifications == .authorized || notifications == .provisional)
            && backgroundRefresh == .available
    }

    // MARK: - Issues

    /// Each issue in the order Home shows them (most severe first).
    var issues: [CapabilityIssue] {
        var issues: [CapabilityIssue] = []
        if !locationServicesEnabled {
            issues.append(.locationServicesOff)
        } else {
            switch location {
            case .notDetermined: issues.append(.locationNotAsked)
            case .denied: issues.append(.locationDenied)
            case .restricted: issues.append(.locationRestricted)
            case .whileUsing: issues.append(.locationWhileUsing)
            case .always: break
            }
            if locationUsable && !preciseLocation { issues.append(.preciseOff) }
        }
        switch motion {
        case .denied: issues.append(.motionDenied)
        case .restricted: issues.append(.motionRestricted)
        case .notDetermined: issues.append(.motionNotAsked)
        case .authorized, .unavailable: break
        }
        switch notifications {
        case .denied: issues.append(.notificationsDenied)
        case .notDetermined: issues.append(.notificationsNotAsked)
        case .authorized, .provisional: break
        }
        // Relaunch-after-close only matters once background detection is
        // possible at all.
        if detectionLevel == .full {
            switch backgroundRefresh {
            case .denied: issues.append(.backgroundRefreshOff)
            case .restricted: issues.append(.backgroundRefreshRestricted)
            case .available: break
            }
        }
        if lowPowerMode && detectionLevel != .off { issues.append(.lowPowerMode) }
        return issues.sorted { $0.severity > $1.severity }
    }
}

/// One thing that is missing or reduced, with its plain-language cost and
/// the fix. The same wording feeds Home's banner, the onboarding summary,
/// and Diagnostics, so they never disagree.
enum CapabilityIssue: String, CaseIterable, Sendable, Identifiable {
    case locationServicesOff
    case locationNotAsked
    case locationDenied
    case locationRestricted
    case locationWhileUsing
    case preciseOff
    case motionNotAsked
    case motionDenied
    case motionRestricted
    case notificationsNotAsked
    case notificationsDenied
    case backgroundRefreshOff
    case backgroundRefreshRestricted
    case lowPowerMode

    var id: String { rawValue }

    enum Severity: Int, Comparable, Sendable {
        /// Low Power Mode: worth knowing, nothing to fix.
        case notice = 0
        /// Detection works, but misses parks or can't tell you about them.
        case reduced = 1
        /// No park detection at all.
        case blocking = 2

        static func < (a: Severity, b: Severity) -> Bool { a.rawValue < b.rawValue }
    }

    var severity: Severity {
        switch self {
        case .locationServicesOff, .locationNotAsked, .locationDenied, .locationRestricted:
            .blocking
        case .lowPowerMode:
            .notice
        default:
            .reduced
        }
    }

    var title: String {
        switch self {
        case .locationServicesOff: "Location Services are off"
        case .locationNotAsked: "Location isn't allowed yet"
        case .locationDenied: "Location is off for ParkAgent"
        case .locationRestricted: "Location is restricted"
        case .locationWhileUsing: "Location is \"While Using\" only"
        case .preciseOff: "Precise Location is off"
        case .motionNotAsked: "Motion & Fitness isn't allowed yet"
        case .motionDenied: "Motion & Fitness is off"
        case .motionRestricted: "Motion & Fitness is restricted"
        case .notificationsNotAsked: "Notifications aren't allowed yet"
        case .notificationsDenied: "Notifications are off"
        case .backgroundRefreshOff: "Background App Refresh is off"
        case .backgroundRefreshRestricted: "Background App Refresh is restricted"
        case .lowPowerMode: "Low Power Mode is on"
        }
    }

    /// What doesn't work because of it: the consequence, not the setting.
    var consequence: String {
        switch self {
        case .locationServicesOff:
            "ParkAgent can't notice when you park. Turn on Settings → Privacy & Security → Location Services."
        case .locationNotAsked, .locationDenied:
            "ParkAgent can't notice when you park or show where you are."
        case .locationRestricted:
            "A Screen Time or device setting blocks location, so ParkAgent can't notice when you park."
        case .locationWhileUsing:
            "Parks are only noticed while ParkAgent is open. Choose \"Always\" so it works with the app closed."
        case .preciseOff:
            "iOS blurs your location by a few kilometers, so ParkAgent can't tell which block you parked on."
        case .motionNotAsked, .motionDenied:
            "ParkAgent can't tell driving from walking, so it only notices parks when your car's Bluetooth or CarPlay disconnects."
        case .motionRestricted:
            "A Screen Time or device setting blocks motion, so parks are only noticed when your car's Bluetooth or CarPlay disconnects."
        case .notificationsNotAsked, .notificationsDenied:
            "A park is noticed, but you won't hear about it until you open ParkAgent."
        case .backgroundRefreshOff:
            "If iOS closes ParkAgent, it can't restart to notice your next park until you open it."
        case .backgroundRefreshRestricted:
            "A device setting stops ParkAgent restarting in the background, so parks can be missed after iOS closes it."
        case .lowPowerMode:
            "iOS checks your location less often, so a park can take longer to notice."
        }
    }
}

/// What tapping a capability does. Ask iOS while iOS will still show its
/// prompt; once it won't, go to this app's page in Settings (the
/// notification page for notifications).
enum CapabilityAction: Equatable, Sendable {
    /// While Using first; `PermissionsManager` asks for Always the moment it
    /// is granted.
    case requestLocation
    /// iOS shows the "Change to Always Allow" prompt once per install.
    case requestAlways
    case requestMotion
    case requestNotifications
    /// Full accuracy for this session only (iOS's own one-time prompt).
    case requestTemporaryPrecise
    case openAppSettings
    case openNotificationSettings
    /// Nothing the user can do from here (restricted, no hardware, Low Power Mode).
    case none

    var title: String? {
        switch self {
        case .requestLocation, .requestMotion, .requestNotifications: "Allow"
        case .requestAlways: "Allow Always"
        case .requestTemporaryPrecise: "Use precise once"
        case .openAppSettings, .openNotificationSettings: "Open Settings"
        case .none: nil
        }
    }
}

/// The rows of Account → Privacy and Diagnostics, in order.
enum CapabilityRow: String, CaseIterable, Sendable {
    case location, precise, motion, notifications, backgroundRefresh

    var title: String {
        switch self {
        case .location: "Location"
        case .precise: "Precise Location"
        case .motion: "Motion & Fitness"
        case .notifications: "Notifications"
        case .backgroundRefresh: "Background App Refresh"
        }
    }
}

extension DetectionCapabilities {
    /// A row's state in iOS Settings' own words, so what the app says
    /// matches what the user finds there.
    func value(of row: CapabilityRow) -> String {
        switch row {
        case .location:
            guard locationServicesEnabled else { return "Location Services off" }
            switch location {
            case .always: return "Always"
            case .whileUsing: return "While Using"
            case .notDetermined: return "Ask Next Time"
            case .denied: return "Never"
            case .restricted: return "Restricted"
            }
        case .precise:
            return preciseLocation ? "On" : "Off"
        case .motion:
            switch motion {
            case .authorized: return "Allowed"
            case .notDetermined: return "Not asked yet"
            case .denied: return "Off"
            case .restricted: return "Restricted"
            case .unavailable: return "Unavailable"
            }
        case .notifications:
            switch notifications {
            case .authorized: return "Allowed"
            case .provisional: return "Delivered quietly"
            case .notDetermined: return "Not asked yet"
            case .denied: return "Off"
            }
        case .backgroundRefresh:
            switch backgroundRefresh {
            case .available: return "On"
            case .denied: return "Off"
            case .restricted: return "Restricted"
            }
        }
    }

    /// Whether the row is what detection needs (drives its checkmark or warning).
    func isSatisfied(_ row: CapabilityRow) -> Bool {
        switch row {
        case .location: detectionLevel == .full
        case .precise: preciseLocation
        case .motion: motion == .authorized || motion == .unavailable
        case .notifications: notifications == .authorized || notifications == .provisional
        case .backgroundRefresh: backgroundRefresh == .available
        }
    }

    /// Tapping a row: ask while iOS still will, else Settings.
    /// `alwaysUpgradeAvailable` is false once iOS has shown its one
    /// "Change to Always Allow" prompt for this install.
    func action(for row: CapabilityRow, alwaysUpgradeAvailable: Bool) -> CapabilityAction {
        switch row {
        case .location:
            guard locationServicesEnabled else { return .openAppSettings }
            switch location {
            case .notDetermined: return .requestLocation
            case .whileUsing: return alwaysUpgradeAvailable ? .requestAlways : .openAppSettings
            case .always, .denied, .restricted: return .openAppSettings
            }
        case .precise, .backgroundRefresh:
            return .openAppSettings
        case .motion:
            switch motion {
            case .notDetermined: return .requestMotion
            case .unavailable: return .none
            case .authorized, .denied, .restricted: return .openAppSettings
            }
        case .notifications:
            return notifications == .notDetermined ? .requestNotifications : .openNotificationSettings
        }
    }

    /// The fix a banner offers for one issue.
    func action(for issue: CapabilityIssue, alwaysUpgradeAvailable: Bool) -> CapabilityAction {
        switch issue {
        case .locationServicesOff, .locationDenied, .preciseOff, .motionDenied, .backgroundRefreshOff:
            .openAppSettings
        case .locationNotAsked: .requestLocation
        case .locationWhileUsing: alwaysUpgradeAvailable ? .requestAlways : .openAppSettings
        case .motionNotAsked: .requestMotion
        case .notificationsNotAsked: .requestNotifications
        case .notificationsDenied: .openNotificationSettings
        case .locationRestricted, .motionRestricted, .backgroundRefreshRestricted, .lowPowerMode: .none
        }
    }
}
