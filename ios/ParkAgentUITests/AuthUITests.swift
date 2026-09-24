import XCTest

/// The welcome screen and the email code flow. Sign in with Apple is
/// mocked — ASAuthorizationController puts up system UI that XCUITest
/// can't drive — but everything after the token (the session landing in
/// the Keychain, the hand-off to the onboarding gate) is the real path.
///
/// Where a sign-in lands is the gate's call, not the account's age: under
/// -uiTesting the gate reads -skipOnboarding as "this phone is set up".
final class AuthUITests: ParkAgentUITestCase {
    /// Signed out, the app shows the welcome screen, not Home.
    func testWelcomeScreenGatesTheApp() {
        let app = launchApp(signedIn: false)

        XCTAssertTrue(
            element(app, "welcome.view").waitForExistence(timeout: 5),
            "Welcome screen missing when signed out"
        )
        XCTAssertTrue(element(app, "welcome.appleButton").exists, "Apple button missing")
        XCTAssertTrue(element(app, "welcome.emailButton").exists, "Email button missing")
        // Google is behind a flag and must not appear by default.
        XCTAssertFalse(element(app, "welcome.googleButton").exists, "Google button should be hidden")
        XCTAssertFalse(app.tabBars.buttons["Home"].exists, "Tab bar should not be reachable signed out")
    }

    /// The flag turns the Google button on — Apple still leads (App Store
    /// requires Sign in with Apple wherever Google is offered).
    func testGoogleButtonAppearsBehindTheFlag() {
        let app = launchApp(signedIn: false, googleSignIn: true)
        XCTAssertTrue(element(app, "welcome.view").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "welcome.googleButton").exists, "Google button missing with the flag on")
        XCTAssertTrue(element(app, "welcome.appleButton").exists, "Apple must still be offered")
    }

    /// Signing in on a set-up phone goes through the gate to Home.
    func testAppleSignInOnASetUpPhoneGoesHome() {
        let app = launchApp(authScenario: "returning", signedIn: false)
        XCTAssertTrue(element(app, "welcome.view").waitForExistence(timeout: 5))
        XCTAssertFalse(app.tabBars.buttons["Home"].exists, "Signed out must not reach the tabs")

        element(app, "welcome.appleButton").tap()

        XCTAssertTrue(
            app.tabBars.buttons["Home"].waitForExistence(timeout: 10),
            "A set-up phone should land on Home after sign-in"
        )
        XCTAssertFalse(element(app, "welcome.view").exists, "Welcome screen should be gone")
    }

    /// With nothing set up, the gate starts onboarding at its first real
    /// step — permissions. Sign-in was the welcome, so there's no second
    /// welcome page to click through.
    func testAppleSignInWithNothingSetUpStartsOnboardingAtPermissions() {
        let app = launchApp(authScenario: "newUser", skipOnboarding: false, signedIn: false)
        XCTAssertTrue(element(app, "welcome.view").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "onboarding.permissions").exists)

        element(app, "welcome.appleButton").tap()

        XCTAssertTrue(
            element(app, "onboarding.permissions").waitForExistence(timeout: 10),
            "Onboarding should start at permissions"
        )
        XCTAssertFalse(element(app, "onboarding.welcome").exists, "The old onboarding welcome is gone")
    }

    /// A rejected Apple token surfaces a plain message and keeps the user
    /// on the welcome screen.
    func testAppleSignInFailureShowsAReason() {
        let app = launchApp(authScenario: "appleFails", signedIn: false)

        element(app, "welcome.appleButton").tap()

        let error = element(app, "welcome.errorLabel")
        XCTAssertTrue(error.waitForExistence(timeout: 10), "No failure message shown")
        // The refusal's own copy (invalid_identity_token), not just any text.
        XCTAssertEqual(error.label, "That sign-in didn't verify. Try again.")
        XCTAssertTrue(element(app, "welcome.view").exists, "Should stay on the welcome screen")
    }

    /// The email code flow end to end: address → code → signed in.
    func testEmailCodeSignIn() {
        let app = launchApp(authScenario: "returning", signedIn: false)

        element(app, "welcome.emailButton").tap()
        let emailField = element(app, "emailSignIn.emailField")
        XCTAssertTrue(emailField.waitForExistence(timeout: 5), "Email field missing")
        emailField.tap()
        emailField.typeText("driver@example.com")

        element(app, "emailSignIn.continueButton").tap()

        let codeField = element(app, "emailSignIn.codeField")
        XCTAssertTrue(codeField.waitForExistence(timeout: 10), "Code field missing after send")
        // The resend button starts counting down so nobody taps into a
        // rate limit.
        let resend = element(app, "emailSignIn.resendButton")
        XCTAssertTrue(resend.exists, "Resend control missing")
        XCTAssertTrue(resend.label.contains("Resend in"), "Resend should be on a timer: \(resend.label)")

        codeField.tap()
        codeField.typeText("123456")

        XCTAssertTrue(
            app.tabBars.buttons["Home"].waitForExistence(timeout: 10),
            "Six digits should sign in without another tap"
        )
    }

    /// A wrong code says so and clears the field for another try.
    func testEmailCodeRejectsAWrongCode() {
        let app = launchApp(authScenario: "badCode", signedIn: false)

        element(app, "welcome.emailButton").tap()
        let emailField = element(app, "emailSignIn.emailField")
        XCTAssertTrue(emailField.waitForExistence(timeout: 5))
        emailField.tap()
        emailField.typeText("driver@example.com")
        element(app, "emailSignIn.continueButton").tap()

        let codeField = element(app, "emailSignIn.codeField")
        XCTAssertTrue(codeField.waitForExistence(timeout: 10))
        codeField.tap()
        codeField.typeText("000000")

        let message = element(app, "emailSignIn.messageLabel")
        XCTAssertTrue(message.waitForExistence(timeout: 10), "No message for a wrong code")
        XCTAssertEqual(message.label, "That code doesn't match. Check it and try again.")
        XCTAssertFalse(app.tabBars.buttons["Home"].exists, "A wrong code must not sign anyone in")
    }

    /// Sign-out from the Account sheet returns to the welcome screen.
    func testSignOutReturnsToWelcome() {
        let app = launchApp()
        openAccountSheet(app)

        let signOut = scrollTo(app, "account.signOutButton")
        XCTAssertTrue(signOut.waitForExistence(timeout: 5), "Sign-out button missing")
        signOut.tap()

        app.buttons["Sign out"].firstMatch.tap()

        XCTAssertTrue(
            element(app, "welcome.view").waitForExistence(timeout: 10),
            "Sign-out should land on the welcome screen"
        )
        XCTAssertFalse(app.tabBars.buttons["Home"].exists, "Tabs should be gone after sign-out")
    }
}
