import Foundation

/// Which APNs environment this build's device token belongs to, reported
/// with the token (POST /device) so the server pushes to the matching host
/// (server/src/services/apns.ts `apnsHost`). A token only works on the
/// host that minted it; the wrong one answers BadDeviceToken and the server
/// drops the token.
///
/// Not the compile flag: the signing decides. Any build Xcode installs is
/// development-signed and gets sandbox tokens — a Release configuration run
/// from Xcode included — and its embedded provisioning profile says so
/// (`aps-environment`). A TestFlight / App Store build is production-signed
/// and carries no embedded profile at all. The simulator's tokens are
/// sandbox tokens.
enum APNsEnvironment {
    static let current: String = resolve(
        profile: Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) },
        isSimulator: isSimulator
    )

    static func resolve(profile: Data?, isSimulator: Bool) -> String {
        if isSimulator { return "development" }
        // No embedded profile: App Store or TestFlight distribution.
        guard let profile else { return "production" }
        // A profile without the key can't have registered for pushes; it's
        // still a direct install, so sandbox is the honest guess.
        return apsEnvironment(inProfile: profile) ?? "development"
    }

    /// The profile is a CMS-signed property list; the XML sits inside it in
    /// the clear, between `<?xml` and `</plist>`.
    static func apsEnvironment(inProfile data: Data) -> String? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex)
        else { return nil }
        let xml = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any]
        else { return nil }
        return entitlements["aps-environment"] as? String
    }

    private static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }
}
