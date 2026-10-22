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

    /// Records sign-out's two calls, in order. The release can be made to
    /// fail, the way it does offline.
    private final class SignOutAPI: HangingAPI, @unchecked Sendable {
        var calls: [String] = []
        var releaseFails = false
        override func unregisterDevice(token: String) async throws {
            calls.append("release \(token)")
            if releaseFails { throw APIError.transport(URLError(.notConnectedToInternet)) }
        }
        override func logout(refreshToken: String) async throws { calls.append("logout \(refreshToken)") }
    }

    /// A model signed in with refresh token `r1`.
    private func signedIn(_ api: SignOutAPI) -> AuthModel {
        let store = AuthStore(credentials: InMemoryCredentialStore())
        store.adopt(AuthSession(
            accessToken: "a1", accessExpiresAt: Date().addingTimeInterval(900), refreshToken: "r1",
            user: AuthUser(
                id: "u1", name: "Thomas", email: "thomas@example.com", emailVerified: true,
                phone: nil, phoneVerified: false, appleLinked: true, googleLinked: false
            ),
            created: false
        ))
        return AuthModel(api: api, store: store)
    }

    /// Sign-out releases this phone's push token, so the account's pushes
    /// (payments, reconnects) stop reaching a phone nobody is signed in on.
    /// It goes first, while the account can still make the call, then the
    /// refresh family is revoked, and the phone ends signed out.
    func testSignOutReleasesThePushTokenThenRevokesTheSession() async {
        let api = SignOutAPI()
        let auth = signedIn(api)
        XCTAssertNotNil(auth.user)
        auth.pushToken = { "abc123" }
        await auth.signOut()
        XCTAssertEqual(api.calls, ["release abc123", "logout r1"])
        XCTAssertNil(auth.user)
    }

    /// Offline, the release fails: sign-out carries on (revoke, then
    /// signed out) rather than trapping anyone signed in.
    func testAFailedReleaseStillSignsOut() async {
        let api = SignOutAPI()
        api.releaseFails = true
        let auth = signedIn(api)
        auth.pushToken = { "abc123" }
        await auth.signOut()
        XCTAssertEqual(api.calls, ["release abc123", "logout r1"])
        XCTAssertNil(auth.user)
    }

    /// No token yet (notifications never allowed): nothing to release, and
    /// the rest of sign-out happens as before.
    func testSignOutWithNoPushTokenReleasesNothing() async {
        let api = SignOutAPI()
        let auth = signedIn(api)
        auth.pushToken = { nil }
        await auth.signOut()
        XCTAssertEqual(api.calls, ["logout r1"])
        XCTAssertNil(auth.user)
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
