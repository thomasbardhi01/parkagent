import XCTest
@testable import ParkAgent

/// The session store: single-flight refresh, what a network blip must NOT
/// do, and that sign-out leaves nothing behind.
@MainActor
final class AuthStoreTests: XCTestCase {
    private var credentials = InMemoryCredentialStore()

    override func setUp() async throws {
        credentials = InMemoryCredentialStore()
        AuthUser.clearCache()
    }

    override func tearDown() async throws {
        AuthUser.clearCache()
    }

    private func makeStore() -> AuthStore {
        AuthStore(credentials: credentials)
    }

    private func makeSession(access: String, refresh: String) -> AuthSession {
        AuthSession(
            accessToken: access,
            accessExpiresAt: Date().addingTimeInterval(900),
            refreshToken: refresh,
            user: AuthUser(
                id: "u1",
                name: "Thomas",
                email: "thomas@example.com",
                emailVerified: true,
                phone: nil,
                phoneVerified: false,
                appleLinked: true,
                googleLinked: false
            ),
            created: false
        )
    }

    func testDeviceIdIsStableAcrossStores() {
        let first = makeStore()
        let second = makeStore()
        XCTAssertFalse(first.deviceId.isEmpty)
        XCTAssertEqual(first.deviceId, second.deviceId, "Device id must persist across launches")
    }

    func testAdoptStoresTokensAndProfile() {
        let store = makeStore()
        store.adopt(makeSession(access: "a1", refresh: "r1"))

        XCTAssertEqual(credentials.string(.accessToken), "a1")
        XCTAssertEqual(credentials.string(.refreshToken), "r1")
        XCTAssertTrue(store.isSignedIn)
        XCTAssertEqual(store.user?.email, "thomas@example.com")
        // The cached profile keeps the Account sheet populated at launch.
        XCTAssertEqual(AuthUser.cached?.name, "Thomas")
    }

    /// The whole point of single-flight: the server rotates on every use,
    /// so two concurrent refreshes would make the second look like token
    /// reuse and revoke the family.
    func testConcurrentRefreshesMakeOneCall() async {
        let store = makeStore()
        store.adopt(makeSession(access: "a1", refresh: "r1"))
        credentials.set(nil, for: .accessToken)

        let counter = CallCounter()
        store.restore { _, _ in
            await counter.bump()
            try? await Task.sleep(for: .milliseconds(50))
            return .refreshed(
                AuthSession(
                    accessToken: "a2",
                    accessExpiresAt: Date().addingTimeInterval(900),
                    refreshToken: "r2",
                    user: AuthUser(
                        id: "u1", name: "Thomas", email: nil, emailVerified: false,
                        phone: nil, phoneVerified: false, appleLinked: true, googleLinked: false
                    ),
                    created: false
                )
            )
        }

        async let first = store.accessToken()
        async let second = store.accessToken()
        async let third = store.accessToken()
        let tokens = await [first, second, third]

        let refreshCalls = await counter.count
        XCTAssertEqual(refreshCalls, 1, "Concurrent refreshes must collapse into one")
        XCTAssertEqual(tokens, ["a2", "a2", "a2"])
        XCTAssertEqual(credentials.string(.refreshToken), "r2", "Rotation must persist the new token")
    }

    /// A rejected refresh token is a real sign-out.
    func testRejectedRefreshSignsOut() async {
        let store = makeStore()
        store.adopt(makeSession(access: "a1", refresh: "r1"))
        credentials.set(nil, for: .accessToken)
        store.restore { _, _ in .rejected }

        let token = await store.accessToken()

        XCTAssertNil(token)
        XCTAssertFalse(store.isSignedIn)
        XCTAssertNil(credentials.string(.refreshToken), "A dead session must leave no credentials")
        XCTAssertNotNil(store.signedOutReason, "The welcome screen should say why")
    }

    /// A flaky network is NOT a sign-out — otherwise a subway ride would
    /// log people out.
    func testUnreachableServerKeepsTheSession() async {
        let store = makeStore()
        store.adopt(makeSession(access: "a1", refresh: "r1"))
        credentials.set(nil, for: .accessToken)
        store.restore { _, _ in .unreachable }

        let token = await store.accessToken()

        XCTAssertNil(token, "No token to offer right now")
        XCTAssertTrue(store.isSignedIn, "The session must survive a network blip")
        XCTAssertEqual(credentials.string(.refreshToken), "r1", "Refresh token must be kept")
    }

    /// A second request whose 401 lost the race just uses the token the
    /// winner already stored, instead of refreshing again.
    func testRefreshAfterUnauthorizedUsesAFresherToken() async {
        let store = makeStore()
        store.adopt(makeSession(access: "new-token", refresh: "r1"))

        let counter = CallCounter()
        store.restore { _, _ in
            await counter.bump()
            return .rejected
        }

        let token = await store.refreshAfterUnauthorized(usedToken: "stale-token")

        XCTAssertEqual(token, "new-token")
        let refreshCalls = await counter.count
        XCTAssertEqual(refreshCalls, 0, "Should not refresh when a newer token exists")
    }

    func testSignOutClearsEverything() {
        let store = makeStore()
        store.adopt(makeSession(access: "a1", refresh: "r1"))

        store.signOutLocally()

        XCTAssertNil(credentials.string(.accessToken))
        XCTAssertNil(credentials.string(.refreshToken))
        XCTAssertNil(AuthUser.cached)
        XCTAssertFalse(store.isSignedIn)
    }

    /// The device id is replaced on sign-out — the next account isn't
    /// linkable to this one by it — and the replacement is PERSISTED, so a
    /// sign-in after sign-out and the refreshes after the next launch
    /// present the same id. The old code deleted it from the Keychain but
    /// kept using the in-memory copy: the sign-in bound its family to the
    /// dead id, the relaunch minted a new one, and the first refresh was
    /// refused device_mismatch — signing the user out.
    func testSignOutRotatesTheDeviceIdAndKeepsItConsistentAcrossALaunch() {
        let store = makeStore()
        let before = store.deviceId
        store.adopt(makeSession(access: "a1", refresh: "r1"))

        store.signOutLocally()

        XCTAssertNotEqual(store.deviceId, before, "sign-out should mint a new device id")
        XCTAssertEqual(credentials.string(.deviceId), store.deviceId, "the new id must be written through")
        // Signed in again in the same process, then relaunched: the next
        // process must present the id the sign-in used.
        let usedAtSignIn = store.deviceId
        store.adopt(makeSession(access: "a2", refresh: "r2"))
        XCTAssertEqual(makeStore().deviceId, usedAtSignIn)
    }

    /// A session the server killed (a rejected refresh) leaves nothing of
    /// the account behind either — not only an explicit sign-out does.
    func testARejectedRefreshClearsTheAccountsLocalState() async {
        let defaults = UserDefaults.standard
        defaults.set("ABC1234", forKey: "vehicle.plate")
        defaults.set(true, forKey: "hasOnboarded")
        defaults.set(42.35, forKey: "carLat")
        defaults.set("bos", forKey: "selectedCity")
        defer { defaults.removeObject(forKey: "selectedCity") }

        let store = makeStore()
        store.adopt(makeSession(access: "a1", refresh: "r1"))
        store.restore { _, _ in .rejected }
        _ = await store.refreshAfterUnauthorized(usedToken: "a1")

        XCTAssertFalse(store.isSignedIn)
        XCTAssertNil(defaults.string(forKey: "vehicle.plate"), "the last account's plate survived")
        XCTAssertFalse(defaults.bool(forKey: "hasOnboarded"))
        XCTAssertNil(defaults.object(forKey: "carLat"))
        // Where the phone is isn't the account's: the city stays.
        XCTAssertEqual(defaults.string(forKey: "selectedCity"), "bos")
    }

    /// Signing out while a rotation is on the wire must not be undone by
    /// its answer arriving afterwards.
    func testSignOutDuringARefreshStaysSignedOut() async {
        let store = makeStore()
        store.adopt(makeSession(access: "a1", refresh: "r1"))
        let gate = Gate()
        let session = makeSession(access: "late", refresh: "late-r")
        store.restore { _, _ in
            await gate.wait()
            return .refreshed(session)
        }

        let refresh = Task { await store.refreshAfterUnauthorized(usedToken: "a1") }
        // Let the refresh reach the network, then sign out under it.
        while await gate.waiting == 0 { await Task.yield() }
        store.signOutLocally()
        await gate.open()
        let token = await refresh.value

        XCTAssertNil(token)
        XCTAssertFalse(store.isSignedIn, "a late refresh answer signed the user back in")
        XCTAssertNil(credentials.string(.refreshToken))
    }
}

/// Holds a fake network call until the test opens it.
private actor Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    var waiting: Int { waiters.count }

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

/// Counts calls across concurrency domains.
private actor CallCounter {
    private(set) var count = 0
    func bump() { count += 1 }
}
