import XCTest

/// Every missing or reduced permission shows up on Home, says what it costs,
/// and fixes in one tap; onboarding never lets anyone past silently. The
/// permission state is pinned with `-capabilities` (the simulator's own
/// grants can't be set from a test); DetectorUITests drives the real iOS
/// prompts.
final class PermissionUITests: ParkAgentUITestCase {
    func testWhileUsingShowsTheBannerAndItsExplainerLeadsToSettings() {
        let app = launchApp(capabilities: "location=whileUsing,alwaysPrompt=decline")
        let title = element(app, "home.detectionBanner.title")
        XCTAssertTrue(title.waitForExistence(timeout: 5), "No banner for While Using")
        XCTAssertEqual(title.label, "Location is \"While Using\" only")
        let action = element(app, "home.detectionBanner.action")
        XCTAssertEqual(action.label, "Allow Always")
        action.tap()
        // Kept While Using: the only road left is Settings, and the
        // explainer says how.
        let openSettings = element(app, "alwaysExplainer.openSettings")
        XCTAssertTrue(openSettings.waitForExistence(timeout: 5), "No explainer after the decline")
        openSettings.tap()
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 10), "Settings didn't open")
        settings.terminate()
    }

    /// Before/after: the banner is there, the upgrade is accepted, the
    /// banner is gone.
    func testTheBannerClearsWhenAlwaysIsGranted() {
        let app = launchApp(capabilities: "location=whileUsing,alwaysPrompt=accept")
        let banner = element(app, "home.detectionBanner.title")
        XCTAssertTrue(banner.waitForExistence(timeout: 5))
        element(app, "home.detectionBanner.action").tap()
        XCTAssertTrue(banner.waitForNonExistence(timeout: 5), "Banner stayed after Always was granted")
        XCTAssertTrue(element(app, "home.statusChip").exists)
    }

    func testTheBannerLeadsWithTheWorstAndCountsTheRest() {
        let app = launchApp(capabilities: "services=off,notifications=denied,backgroundRefresh=denied")
        let title = element(app, "home.detectionBanner.title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Location Services are off")
        let more = element(app, "home.detectionBanner.more")
        XCTAssertEqual(more.label, "+1 more")
        more.tap()
        XCTAssertTrue(element(app, "detectionStatus.view").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "detectionStatus.issue.notificationsDenied").waitForExistence(timeout: 5))
        XCTAssertEqual(scrollTo(app, "detectionStatus.location").label, "Location, Location Services off")
    }

    func testNoBannerWhenEverythingIsGranted() {
        let app = launchApp()
        XCTAssertTrue(element(app, "home.statusChip").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "home.detectionBanner.title").exists)
    }

    /// Onboarding: Continue with something missing shows what won't work
    /// first; only "Continue anyway" moves on.
    func testOnboardingShowsWhatWontWorkBeforeMovingOn() {
        let app = launchApp(skipOnboarding: false, capabilities: "location=whileUsing,alwaysPrompt=notShown,motion=denied")
        XCTAssertTrue(element(app, "onboarding.permissions").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "onboarding.permission.location.state").label, "While Using")
        let proceed = element(app, "onboarding.continueButton")
        XCTAssertEqual(proceed.label, "Continue with limited detection")
        proceed.tap()
        XCTAssertTrue(element(app, "onboarding.limited").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "onboarding.limited.issue.locationWhileUsing").exists)
        XCTAssertTrue(element(app, "onboarding.limited.issue.motionDenied").exists)
        XCTAssertFalse(element(app, "onboarding.vehicle").exists)
        element(app, "onboarding.limited.continueAnyway").tap()
        XCTAssertTrue(element(app, "onboarding.vehicle").waitForExistence(timeout: 5))
    }

    /// Enable asks While Using, then the Always upgrade straight away; a
    /// "Keep Only While Using" lands on the Settings explainer.
    func testOnboardingDeclinedAlwaysShowsTheExplainer() {
        let app = launchApp(skipOnboarding: false, capabilities: "location=notDetermined,alwaysPrompt=decline")
        XCTAssertTrue(element(app, "onboarding.permissions").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "onboarding.permission.location.state").label, "Ask Next Time")
        element(app, "onboarding.permission.location.action").tap()
        XCTAssertTrue(element(app, "alwaysExplainer.view").waitForExistence(timeout: 5), "No explainer after the decline")
        element(app, "alwaysExplainer.notNow").tap()
        waitForLabel(of: element(app, "onboarding.permission.location.state"), toBe: "While Using")
    }

    func testOnboardingAcceptedAlwaysContinuesStraightOn() {
        let app = launchApp(skipOnboarding: false, capabilities: "location=notDetermined,alwaysPrompt=accept")
        XCTAssertTrue(element(app, "onboarding.permissions").waitForExistence(timeout: 5))
        element(app, "onboarding.permission.location.action").tap()
        waitForLabelContaining(element(app, "onboarding.permission.location.state"), "Always")
        XCTAssertEqual(element(app, "onboarding.continueButton").label, "Continue")
    }

    /// The Privacy row does what the banner does: While Using → iOS's
    /// upgrade prompt; kept While Using → the Settings explainer.
    func testPrivacyLocationRowOffersAlwaysThenTheExplainer() {
        let app = launchApp(capabilities: "location=whileUsing,alwaysPrompt=decline")
        openAccountSheet(app)
        let location = scrollTo(app, "account.privacy.location")
        XCTAssertEqual(location.label, "Location, While Using")
        location.tap()
        XCTAssertTrue(element(app, "alwaysExplainer.view").waitForExistence(timeout: 5), "No explainer from the Privacy row")
        element(app, "alwaysExplainer.notNow").tap()
        XCTAssertTrue(element(app, "alwaysExplainer.view").waitForNonExistence(timeout: 5))
    }
}
