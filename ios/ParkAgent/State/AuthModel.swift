import AuthenticationServices
import Foundation
import Observation

/// Sign-in actions for the welcome screen and the Account sheet's sign-out
/// and delete. Owns nothing persistent — the tokens live in `AuthStore`,
/// which this asks to adopt each new session.
@MainActor
@Observable
final class AuthModel {
    private let store: AuthStore
    /// Fixed for the process: the mock is a launch-time choice, and an
    /// unconfigured app stays on UnconfiguredAPI, whose sign-in failure is
    /// what the welcome screen shows.
    private let api: any APIClient

    /// Shown under the sign-in buttons when an attempt fails.
    private(set) var errorMessage: String?
    private(set) var isWorking = false

    /// True when the mock API is in play: the real Sign in with Apple sheet
    /// is system UI that can't be driven on the simulator or in UI tests.
    let usesMockSignIn: Bool

    var signedOutReason: String? { store.signedOutReason }
    var user: AuthUser? { store.user }

    init(api: any APIClient, store: AuthStore, usesMockSignIn: Bool = false) {
        self.api = api
        self.store = store
        self.usesMockSignIn = usesMockSignIn
    }

    // MARK: - Apple

    /// The native button's completion. Apple hands the full name to the APP
    /// exactly once, on the first sign-in, so it is forwarded to the server
    /// here or lost forever.
    func handleAppleCompletion(_ result: Result<ASAuthorization, any Error>) {
        switch result {
        case .success(let authorization):
            guard
                let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                let tokenData = credential.identityToken,
                let identityToken = String(data: tokenData, encoding: .utf8)
            else {
                errorMessage = "Apple didn't return a usable sign-in. Try again."
                return
            }
            let name = credential.fullName
            Task {
                await signIn {
                    try await self.api.signInWithApple(
                        identityToken: identityToken,
                        deviceId: self.store.deviceId,
                        fullName: name.map { (given: $0.givenName, family: $0.familyName) }
                    )
                }
            }
        case .failure(let error):
            // A cancelled sheet is not an error worth shouting about.
            if (error as? ASAuthorizationError)?.code == .canceled {
                errorMessage = nil
            } else {
                errorMessage = "Apple sign-in didn't finish. Try again."
            }
        }
    }

    /// Stand-in for the Apple sheet under the mock API.
    func signInWithAppleMock() async {
        await signIn {
            try await self.api.signInWithApple(
                identityToken: "mock-identity-token",
                deviceId: self.store.deviceId,
                fullName: (given: "Thomas", family: nil)
            )
        }
    }

    // MARK: - Google

    func signInWithGoogle() async {
        // The Google SDK is not a dependency: the flag ships off, and
        // turning it on means adding GoogleSignIn-iOS and handing its id
        // token here. The mock path exercises the server contract.
        await signIn {
            try await self.api.signInWithGoogle(
                idToken: "mock-google-id-token",
                deviceId: self.store.deviceId
            )
        }
    }

    // MARK: - Email

    func startEmailSignIn(email: String) async -> Result<Void, APIError> {
        do {
            try await api.startEmailSignIn(email: email)
            return .success(())
        } catch {
            return .failure(error as? APIError ?? .transport(error))
        }
    }

    func verifyEmailSignIn(email: String, code: String) async -> Result<Void, APIError> {
        do {
            let session = try await api.verifyEmailSignIn(
                email: email,
                code: code,
                deviceId: store.deviceId
            )
            adopt(session)
            return .success(())
        } catch {
            return .failure(error as? APIError ?? .transport(error))
        }
    }

    // MARK: - Session lifecycle

    /// Sign-out: tell the server to kill this refresh family, then drop
    /// every local credential and the state that belonged to the account.
    func signOut() async {
        let refreshToken = store.refreshToken
        if let refreshToken {
            // Best effort — a dead network must not trap anyone signed in.
            try? await api.logout(refreshToken: refreshToken)
        }
        store.signOutLocally()
    }

    /// Two-step confirmed in the Account sheet. The server tears the
    /// account down; locally this is a sign-out.
    func deleteAccount() async -> Result<Void, APIError> {
        do {
            try await api.deleteAccount()
            store.signOutLocally()
            return .success(())
        } catch {
            return .failure(error as? APIError ?? .transport(error))
        }
    }

    func clearError() {
        errorMessage = nil
    }

    // MARK: - Methods

    /// Which sign-in buttons to show. Apple only until the server says
    /// otherwise, and Apple only if it can't be asked: a button for a
    /// switched-off method would just fail.
    private(set) var methods: AuthMethods = .appleOnly

    func loadMethods() async {
        methods = (try? await api.authMethods()) ?? .appleOnly
    }

    // MARK: - Internals

    private func signIn(_ work: @escaping () async throws -> AuthSession) async {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        do {
            adopt(try await work())
        } catch {
            errorMessage = (error as? APIError)?.errorDescription
                ?? "That sign-in didn't finish. Try again."
        }
        isWorking = false
    }

    /// Adopting the session is all a sign-in does. Where the user lands
    /// next — Home, or the first missing onboarding step — is RootView's
    /// truth gate asking the server and the phone, not a guess from
    /// whether the account is new: a returning driver on a new phone still
    /// needs this phone's permissions, and a new account on a set-up phone
    /// still needs a car.
    private func adopt(_ session: AuthSession) {
        store.clearSignedOutReason()
        store.adopt(session)
    }

}
