import Foundation
import Security

/// Where the app's credentials live. One implementation in the app (the
/// Keychain), one in tests — a unit-test host built without entitlements
/// has no keychain to write to, and faking the storage is honest where
/// faking the token logic would not be.
protocol CredentialStoring: Sendable {
    func string(_ key: Keychain.Key) -> String?
    func set(_ value: String?, for key: Keychain.Key)
    func clearAll()
}

/// The real store, for the app.
struct KeychainStore: CredentialStoring {
    func string(_ key: Keychain.Key) -> String? { Keychain.string(key) }
    func set(_ value: String?, for key: Keychain.Key) { Keychain.set(value, for: key) }
    func clearAll() { Keychain.clearAll() }
}

/// The app's credential store. Tokens and the device id live here, not in
/// UserDefaults: background park detection has to refresh the session while
/// the phone is locked, so everything is written
/// `kSecAttrAccessibleAfterFirstUnlock` — readable after the first unlock
/// since boot, never before, and never synced to iCloud.
enum Keychain {
    enum Key: String, CaseIterable {
        case accessToken = "auth.accessToken"
        case refreshToken = "auth.refreshToken"
        /// Stable per install; binds the refresh-token family to this device.
        case deviceId = "auth.deviceId"
    }

    static func string(_ key: Key) -> String? {
        guard let data = read(key.rawValue) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String?, for key: Key) {
        guard let value else {
            delete(key.rawValue)
            return
        }
        write(Data(value.utf8), key.rawValue)
    }

    /// Sign-out: every credential goes, so nothing survives to authenticate.
    static func clearAll() {
        for key in Key.allCases { delete(key.rawValue) }
    }

    #if DEBUG
    /// UI tests (`-signedIn YES`): start the app already signed in, so a
    /// test about the Account sheet isn't a test about signing in. Mock
    /// tokens only — LiveAPI would reject them instantly.
    static func seedTestSession() {
        set("mock-access-token", for: .accessToken)
        set("mock-refresh-token", for: .refreshToken)
    }
    #endif

    // MARK: - SecItem plumbing

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.thomasbardhi.parkagent",
            kSecAttrAccount as String: account,
        ]
    }

    private static func read(_ account: String) -> Data? {
        #if DEBUG
        if !isAvailable { return Fallback.read(account) }
        #endif
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    private static func write(_ data: Data, _ account: String) {
        #if DEBUG
        if !isAvailable {
            Fallback.write(data, account)
            return
        }
        #endif
        let query = query(account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Background refresh runs with the phone locked; anything
            // stricter than AfterFirstUnlock would fail there.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { current, _ in current } as CFDictionary, nil)
        }
    }

    private static func delete(_ account: String) {
        #if DEBUG
        if !isAvailable {
            Fallback.delete(account)
            return
        }
        #endif
        SecItemDelete(query(account) as CFDictionary)
    }

    #if DEBUG
    /// An UNSIGNED simulator build (`CODE_SIGNING_ALLOWED=NO` — how the
    /// tests and headless builds run) has no `application-identifier`
    /// entitlement, so every SecItem call fails errSecMissingEntitlement
    /// (-34018) and nobody could stay signed in on the simulator.
    ///
    /// Probed once per process by attempting a real write, rather than
    /// matching on error codes: read and write don't fail with the same
    /// status, and guessing which is which is how this silently half-works.
    /// On any signed build — simulator or device — the probe succeeds and
    /// the fallback below is never touched. It is compiled out of release
    /// builds entirely.
    nonisolated(unsafe) private static let isAvailable: Bool = {
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.thomasbardhi.parkagent",
            kSecAttrAccount as String: "availability.probe",
            kSecValueData as String: Data([0]),
        ]
        SecItemDelete(probe as CFDictionary)
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(probe as CFDictionary)
        return status == errSecSuccess
    }()

    /// Process-lifetime stand-in used only when `isAvailable` is false.
    private enum Fallback {
        nonisolated(unsafe) private static var values: [String: Data] = [:]
        private static let lock = NSLock()

        static func read(_ account: String) -> Data? {
            lock.lock()
            defer { lock.unlock() }
            return values[account]
        }

        static func write(_ data: Data, _ account: String) {
            lock.lock()
            defer { lock.unlock() }
            values[account] = data
        }

        static func delete(_ account: String) {
            lock.lock()
            defer { lock.unlock() }
            values[account] = nil
        }
    }
    #endif
}
