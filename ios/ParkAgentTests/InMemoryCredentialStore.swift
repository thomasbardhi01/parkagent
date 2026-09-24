import Foundation
@testable import ParkAgent

/// Stands in for the Keychain in unit tests. A test host built without
/// entitlements has no keychain to write to (SecItemAdd fails
/// errSecMissingEntitlement), so the storage is faked — the token logic
/// under test is not.
final class InMemoryCredentialStore: CredentialStoring, @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()

    func string(_ key: Keychain.Key) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key.rawValue]
    }

    func set(_ value: String?, for key: Keychain.Key) {
        lock.lock()
        defer { lock.unlock() }
        values[key.rawValue] = value
    }

    func clearAll() {
        lock.lock()
        defer { lock.unlock() }
        values.removeAll()
    }
}
