import XCTest
@testable import ParkAgent

/// Which sign-in buttons the welcome screen offers.
@MainActor
final class AuthModelTests: XCTestCase {
    private func model(_ api: any APIClient) -> AuthModel {
        AuthModel(api: api, store: AuthStore(credentials: InMemoryCredentialStore()))
    }

    func testAppleOnlyBeforeTheServerAnswers() {
        XCTAssertEqual(model(UnconfiguredAPI()).methods, .appleOnly)
    }

    /// A server that can't be asked gets Apple only — never a button for a
    /// method that may be switched off.
    func testAppleOnlyWhenTheServerCantBeAsked() async {
        let auth = model(UnconfiguredAPI())
        await auth.loadMethods()
        XCTAssertEqual(auth.methods, .appleOnly)
    }

    private final class SignOutAPI: HangingAPI, @unchecked Sendable {
        var released: [String] = []
        override func unregisterDevice(token: String) async throws { released.append(token) }
    }

    /// Sign-out releases this phone's push token, so the account's pushes
    /// (payments, reconnects) stop reaching a phone nobody is signed in on.
    func testSignOutReleasesThePushToken() async {
        let api = SignOutAPI()
        let auth = model(api)
        auth.pushToken = { "abc123" }
        await auth.signOut()
        XCTAssertEqual(api.released, ["abc123"])
    }

    /// No token yet (notifications never allowed): nothing to release.
    func testSignOutWithNoPushTokenReleasesNothing() async {
        let api = SignOutAPI()
        let auth = model(api)
        auth.pushToken = { nil }
        await auth.signOut()
        XCTAssertTrue(api.released.isEmpty)
    }

    /// Whatever the server reports is what the screen offers.
    func testTakesTheServersAnswer() async {
        UserDefaults.standard.set("apple,email", forKey: MockAPI.authMethodsKey)
        defer { UserDefaults.standard.removeObject(forKey: MockAPI.authMethodsKey) }
        let auth = model(MockAPI())
        await auth.loadMethods()
        XCTAssertEqual(auth.methods, AuthMethods(apple: true, email: true, google: false))
    }
}
