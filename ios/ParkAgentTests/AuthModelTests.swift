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

    /// Whatever the server reports is what the screen offers.
    func testTakesTheServersAnswer() async {
        UserDefaults.standard.set("apple,email", forKey: MockAPI.authMethodsKey)
        defer { UserDefaults.standard.removeObject(forKey: MockAPI.authMethodsKey) }
        let auth = model(MockAPI())
        await auth.loadMethods()
        XCTAssertEqual(auth.methods, AuthMethods(apple: true, email: true, google: false))
    }
}
