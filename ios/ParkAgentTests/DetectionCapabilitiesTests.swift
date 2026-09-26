import Testing

@testable import ParkAgent

/// Every permission state the phone can be in, and what the app says and
/// does about each: the banner's issue, the Privacy row's word, the tap.
struct DetectionCapabilitiesTests {
    /// Everything granted.
    static let granted = DetectionCapabilities(
        locationServicesEnabled: true,
        location: .always,
        preciseLocation: true,
        motion: .authorized,
        notifications: .authorized,
        backgroundRefresh: .available,
        lowPowerMode: false
    )

    private func with(_ change: (inout DetectionCapabilities) -> Void) -> DetectionCapabilities {
        var caps = Self.granted
        change(&caps)
        return caps
    }

    @Test func everythingGrantedHasNoIssuesAndDetectsWithTheAppClosed() {
        #expect(Self.granted.issues.isEmpty)
        #expect(Self.granted.fullyGranted)
        #expect(Self.granted.detectionLevel == .full)
    }

    /// The state the field test found: Account said "Allowed" for this.
    @Test func whileUsingIsNamedAndOnlyDetectsWhileOpen() {
        let caps = with { $0.location = .whileUsing }
        #expect(caps.issues == [.locationWhileUsing])
        #expect(caps.detectionLevel == .whileOpen)
        #expect(!caps.fullyGranted)
        #expect(caps.value(of: .location) == "While Using")
        #expect(caps.action(for: .locationWhileUsing, alwaysUpgradeAvailable: true) == .requestAlways)
        // iOS shows the upgrade once; after that only Settings can do it.
        #expect(caps.action(for: .locationWhileUsing, alwaysUpgradeAvailable: false) == .openAppSettings)
        #expect(caps.action(for: .location, alwaysUpgradeAvailable: false) == .openAppSettings)
    }

    @Test(arguments: [
        (DetectionCapabilities.Location.notDetermined, CapabilityIssue.locationNotAsked, "Ask Next Time", CapabilityAction.requestLocation),
        (.denied, .locationDenied, "Never", .openAppSettings),
        (.restricted, .locationRestricted, "Restricted", .none),
    ])
    func locationStatesThatStopDetection(
        location: DetectionCapabilities.Location,
        issue: CapabilityIssue,
        word: String,
        fix: CapabilityAction
    ) {
        let caps = with { $0.location = location }
        #expect(caps.detectionLevel == .off)
        #expect(caps.issues.first == issue)
        #expect(issue.severity == .blocking)
        #expect(caps.value(of: .location) == word)
        #expect(caps.action(for: issue, alwaysUpgradeAvailable: true) == fix)
    }

    /// Off for the whole phone: iOS reports "denied" for every app then,
    /// so the phone-wide switch has to be named, not the app's grant.
    @Test func locationServicesOffIsNamedInsteadOfTheAppsGrant() {
        let caps = with {
            $0.locationServicesEnabled = false
            $0.location = .denied
        }
        #expect(caps.issues.first == .locationServicesOff)
        #expect(!caps.issues.contains(.locationDenied))
        #expect(caps.value(of: .location) == "Location Services off")
        #expect(caps.detectionLevel == .off)
    }

    @Test func preciseOffIsAnIssueOnlyWhenLocationIsOn() {
        #expect(with { $0.preciseLocation = false }.issues == [.preciseOff])
        #expect(with { $0.preciseLocation = false }.value(of: .precise) == "Off")
        #expect(!with { $0.preciseLocation = false; $0.location = .denied }.issues.contains(.preciseOff))
    }

    @Test func motionStates() {
        #expect(with { $0.motion = .denied }.issues == [.motionDenied])
        #expect(with { $0.motion = .restricted }.issues == [.motionRestricted])
        #expect(with { $0.motion = .notDetermined }.issues == [.motionNotAsked])
        // No hardware is not a problem to fix.
        #expect(with { $0.motion = .unavailable }.issues.isEmpty)
        #expect(with { $0.motion = .unavailable }.action(for: .motion, alwaysUpgradeAvailable: true) == .none)
        #expect(with { $0.motion = .notDetermined }.action(for: .motion, alwaysUpgradeAvailable: true) == .requestMotion)
        #expect(with { $0.motion = .denied }.action(for: .motion, alwaysUpgradeAvailable: true) == .openAppSettings)
    }

    @Test func notificationsGoToTheirOwnSettingsPage() {
        let denied = with { $0.notifications = .denied }
        #expect(denied.issues == [.notificationsDenied])
        #expect(denied.value(of: .notifications) == "Off")
        #expect(denied.action(for: .notifications, alwaysUpgradeAvailable: true) == .openNotificationSettings)
        #expect(denied.action(for: .notificationsDenied, alwaysUpgradeAvailable: true) == .openNotificationSettings)
        let notAsked = with { $0.notifications = .notDetermined }
        #expect(notAsked.action(for: .notifications, alwaysUpgradeAvailable: true) == .requestNotifications)
        // Granted: tapping still goes to the page where it can be changed.
        #expect(Self.granted.action(for: .notifications, alwaysUpgradeAvailable: true) == .openNotificationSettings)
    }

    @Test func backgroundRefreshMattersOnlyWhenBackgroundDetectionCould() {
        #expect(with { $0.backgroundRefresh = .denied }.issues == [.backgroundRefreshOff])
        #expect(with { $0.backgroundRefresh = .restricted }.issues == [.backgroundRefreshRestricted])
        // While Using can't relaunch anyway; saying so twice is noise.
        #expect(!with { $0.backgroundRefresh = .denied; $0.location = .whileUsing }.issues.contains(.backgroundRefreshOff))
    }

    @Test func lowPowerModeIsANoticeNotAGrant() {
        let caps = with { $0.lowPowerMode = true }
        #expect(caps.issues == [.lowPowerMode])
        #expect(CapabilityIssue.lowPowerMode.severity == .notice)
        #expect(caps.fullyGranted, "Low Power Mode is not a permission")
    }

    @Test func theBannerLeadsWithTheWorstProblem() {
        let caps = with {
            $0.lowPowerMode = true
            $0.notifications = .denied
            $0.locationServicesEnabled = false
            $0.motion = .denied
        }
        #expect(caps.issues.first == .locationServicesOff)
        // With no location at all, Low Power Mode changes nothing worth saying.
        #expect(!caps.issues.contains(.lowPowerMode))
        let reduced = with {
            $0.lowPowerMode = true
            $0.notifications = .denied
            $0.location = .whileUsing
        }
        #expect(reduced.issues.first == .locationWhileUsing)
        #expect(reduced.issues.last == .lowPowerMode)
        let severities = caps.issues.map(\.severity)
        #expect(severities == severities.sorted(by: >))
    }

    @Test func everyIssueSaysWhatBreaks() {
        for issue in CapabilityIssue.allCases {
            #expect(!issue.title.isEmpty)
            #expect(issue.consequence.count > 20, "\(issue) has no consequence")
        }
    }

    @Test func theUITestOverrideParsesEveryKey() {
        #if DEBUG
        let override = CapabilityOverride.parse(
            "location=whileUsing,precise=off,motion=denied,notifications=denied,backgroundRefresh=denied,lowPower=on,services=off,alwaysPrompt=decline,whenAsked=denied"
        )
        #expect(override.capabilities.location == .whileUsing)
        #expect(!override.capabilities.preciseLocation)
        #expect(override.capabilities.motion == .denied)
        #expect(override.capabilities.notifications == .denied)
        #expect(override.capabilities.backgroundRefresh == .denied)
        #expect(override.capabilities.lowPowerMode)
        #expect(!override.capabilities.locationServicesEnabled)
        #expect(override.alwaysPrompt == .decline)
        #expect(override.whenAsked == .denied)
        #expect(CapabilityOverride.parse("granted").capabilities == Self.granted)
        #endif
    }
}
