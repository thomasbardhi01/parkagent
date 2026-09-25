import XCTest
@testable import ParkAgent

/// The environment a device token is registered with decides which APNs
/// host the server uses; a wrong one silently loses every push.
final class APNsEnvironmentTests: XCTestCase {
    /// A provisioning profile as Xcode embeds it: CMS bytes around a plist.
    private func profile(aps: String?) -> Data {
        let entitlement = aps.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
        <key>Name</key><string>iOS Team Provisioning Profile</string>
        <key>Entitlements</key><dict>\(entitlement)<key>get-task-allow</key><true/></dict>
        </dict></plist>
        """
        return Data([0x30, 0x82, 0x3A, 0x1F, 0x06, 0x09]) + Data(xml.utf8) + Data([0xA0, 0x82, 0x00, 0x00])
    }

    func testAnXcodeInstallReadsSandboxFromItsProfile() {
        XCTAssertEqual(APNsEnvironment.resolve(profile: profile(aps: "development"), isSimulator: false), "development")
    }

    /// The case the compile flag got wrong: a Release configuration run
    /// from Xcode is still development-signed.
    func testTheProfileWinsOverTheBuildConfiguration() {
        XCTAssertEqual(APNsEnvironment.apsEnvironment(inProfile: profile(aps: "development")), "development")
        XCTAssertEqual(APNsEnvironment.apsEnvironment(inProfile: profile(aps: "production")), "production")
    }

    /// TestFlight and App Store builds carry no embedded profile.
    func testNoProfileMeansProduction() {
        XCTAssertEqual(APNsEnvironment.resolve(profile: nil, isSimulator: false), "production")
    }

    func testTheSimulatorIsSandbox() {
        XCTAssertEqual(APNsEnvironment.resolve(profile: nil, isSimulator: true), "development")
    }

    func testAProfileWithoutTheKeyOrUnreadableIsSandbox() {
        XCTAssertEqual(APNsEnvironment.resolve(profile: profile(aps: nil), isSimulator: false), "development")
        XCTAssertEqual(APNsEnvironment.resolve(profile: Data("garbage".utf8), isSimulator: false), "development")
    }
}
