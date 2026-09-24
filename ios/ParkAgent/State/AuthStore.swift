import Foundation
import Observation

/// Who is signed in, and the tokens that prove it. One instance owns the
/// Keychain credentials; `LiveAPI` asks it for the current access token and
/// hands 401s back for a silent refresh.
///
/// Refresh is single-flight: a burst of 401s (the park report, the session
/// poll, and a push registration all racing) must produce ONE
/// `/auth/refresh` call — the server rotates on every use, so two
/// concurrent refreshes would make the second look like token reuse and
/// revoke the whole family.
@MainActor
@Observable
final class AuthStore {
    enum State: Equatable {
        /// Reading the Keychain — the very first frame only.
        case loading
        case signedOut
        case signedIn(AuthUser)
    }

    private(set) var state: State = .loading
    /// Set when a refresh failed for real (not a network blip): the app
    /// returns to the welcome screen and says why.
    private(set) var signedOutReason: String?

    /// Stable per install; the refresh family is bound to it.
    let deviceId: String

    /// Keychain in the app, in-memory in tests.
    private let credentials: any CredentialStoring

    private var refreshInFlight: Task<String?, Never>?
    /// Set by the app at launch; the store needs a transport of its own
    /// because it refreshes outside any particular request.
    private var tokenRefresher: (@Sendable (String, String) async -> LiveAPI.RefreshOutcome)?

    var user: AuthUser? {
        if case .signedIn(let user) = state { return user }
        return nil
    }

    var isSignedIn: Bool { user != nil }

    init(credentials: any CredentialStoring = KeychainStore(), deviceId: String? = nil) {
        self.credentials = credentials
        if let deviceId {
            self.deviceId = deviceId
        } else if let stored = credentials.string(.deviceId) {
            self.deviceId = stored
        } else {
            let minted = UUID().uuidString
            credentials.set(minted, for: .deviceId)
            self.deviceId = minted
        }
    }

    /// The stored refresh token — sign-out sends it to the server so the
    /// whole family dies there too, not just on this phone.
    var refreshToken: String? { credentials.string(.refreshToken) }

    /// Wire the refresh transport and restore any stored session. Called
    /// once at launch, before the first protected request.
    func restore(refresher: @escaping @Sendable (String, String) async -> LiveAPI.RefreshOutcome) {
        tokenRefresher = refresher
        guard credentials.string(.refreshToken) != nil else {
            state = .signedOut
            return
        }
        // The cached profile keeps the app off the welcome screen while the
        // first refresh runs; a failure below corrects it.
        state = .signedIn(AuthUser.cached ?? AuthUser.placeholder)
    }

    /// The token to put on the next request, refreshing first when there
    /// is no access token at all.
    func accessToken() async -> String? {
        if let token = credentials.string(.accessToken) { return token }
        return await refresh()
    }

    /// A request came back 401: refresh once and report the new token (nil
    /// means the caller should give up — the retry would 401 too).
    func refreshAfterUnauthorized(usedToken: String?) async -> String? {
        // Another request already refreshed while this one was in flight:
        // the stored token differs from the one that failed, so just use it.
        if let current = credentials.string(.accessToken), current != usedToken {
            return current
        }
        return await refresh()
    }

    /// Single-flight rotation.
    private func refresh() async -> String? {
        if let existing = refreshInFlight { return await existing.value }
        guard let refreshToken = credentials.string(.refreshToken), let tokenRefresher else {
            return nil
        }
        let deviceId = self.deviceId
        let task = Task<String?, Never> { [weak self] in
            let outcome = await tokenRefresher(refreshToken, deviceId)
            guard let self else { return nil }
            switch outcome {
            case .refreshed(let session):
                self.adopt(session)
                return session.accessToken
            case .rejected:
                // The refresh token is dead (rotated away, revoked, or 60
                // days stale). Everything local is worthless now.
                self.signOutLocally(reason: "Your session expired. Sign in again.")
                return nil
            case .unreachable:
                // A flaky network is not a signed-out user: keep the
                // session and let the next request try again.
                return nil
            }
        }
        refreshInFlight = task
        let token = await task.value
        refreshInFlight = nil
        return token
    }

    /// A fresh sign-in or rotation: persist the pair and the profile.
    func adopt(_ session: AuthSession) {
        credentials.set(session.accessToken, for: .accessToken)
        credentials.set(session.refreshToken, for: .refreshToken)
        session.user.cache()
        signedOutReason = nil
        state = .signedIn(session.user)
    }

    func update(user: AuthUser) {
        user.cache()
        if case .signedIn = state { state = .signedIn(user) }
    }

    /// Sign-out clears EVERYTHING: tokens, cached profile, and the local
    /// app state that only made sense for that account.
    func signOutLocally(reason: String? = nil) {
        credentials.clearAll()
        AuthUser.clearCache()
        refreshInFlight?.cancel()
        refreshInFlight = nil
        signedOutReason = reason
        state = .signedOut
    }

    func clearSignedOutReason() {
        signedOutReason = nil
    }
}

/// The signed-in person, as the app shows them.
struct AuthUser: Codable, Sendable, Equatable {
    var id: String
    var name: String
    var email: String?
    var emailVerified: Bool
    var phone: String?
    var phoneVerified: Bool
    var appleLinked: Bool
    var googleLinked: Bool

    /// Shown for the split second between launch and the first refresh.
    static let placeholder = AuthUser(
        id: "",
        name: "",
        email: nil,
        emailVerified: false,
        phone: nil,
        phoneVerified: false,
        appleLinked: false,
        googleLinked: false
    )

    // The profile is not a credential — UserDefaults is the right home for
    // it, and it keeps the Account sheet populated offline.
    private static let cacheKey = "auth.user"

    static var cached: AuthUser? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(AuthUser.self, from: data)
    }

    func cache() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.cacheKey)
    }

    static func clearCache() {
        UserDefaults.standard.removeObject(forKey: cacheKey)
    }
}

/// What every sign-in and refresh returns (server/API.md "/auth").
struct AuthSession: Codable, Sendable {
    var accessToken: String
    var accessExpiresAt: Date
    var refreshToken: String
    var user: AuthUser
    /// True when this sign-in created the account (the app then runs
    /// onboarding instead of going straight Home).
    var created: Bool
}
