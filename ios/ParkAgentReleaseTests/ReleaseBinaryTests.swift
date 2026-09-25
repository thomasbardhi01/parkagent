import Foundation
import XCTest

/// Runs INSIDE the Release build (scheme ParkAgentRelease, test config
/// Release), so everything here is a claim about the binary TestFlight
/// ships. No `@testable import`: a Release build isn't testable, and the
/// checks read the host app's own executable, type metadata, and bundle.
final class ReleaseBinaryTests: XCTestCase {
    private func hostBinary() throws -> Data {
        let url = try XCTUnwrap(Bundle.main.executableURL, "No host executable")
        XCTAssertEqual(url.lastPathComponent, "ParkAgent", "Not hosted in the app")
        return try Data(contentsOf: url, options: .alwaysMapped)
    }

    /// This test only means something in a Release build: a Debug host
    /// carries every forbidden string on purpose.
    func testThisIsTheReleaseBuild() throws {
        #if DEBUG
        XCTFail("ParkAgentReleaseTests must run in the Release configuration (scheme ParkAgentRelease)")
        #endif
        // The host's own debug-dylib split only exists in Debug builds.
        let dir = try XCTUnwrap(Bundle.main.executableURL).deletingLastPathComponent()
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: dir.appendingPathComponent("ParkAgent.debug.dylib").path),
            "The host app is a Debug build"
        )
    }

    /// `strings`, in-process: none of the forbidden markers is in the
    /// executable, and the required ones are (so the scan read real code).
    func testNoDevStringsInTheBinary() throws {
        let list = try ReleaseDenylist.bundled(for: Self.self)
        XCTAssertGreaterThan(list.forbiddenStrings.count, 20, "Denylist looks truncated")
        XCTAssertFalse(list.requiredStrings.isEmpty, "Denylist has no required markers")
        let binary = try hostBinary()
        for marker in list.requiredStrings {
            XCTAssertNotNil(
                binary.range(of: Data(marker.utf8)),
                "Required marker \"\(marker)\" not found — is the scan reading the app?"
            )
        }
        let hits = list.forbiddenStrings.filter { binary.range(of: Data($0.utf8)) != nil }
        XCTAssertEqual(hits, [], "Dev strings in the Release binary")
    }

    /// Types: the mock server, the scenario enums, Diagnostics — compiled
    /// out entirely, not merely unreachable. (ParkAgentTests proves each
    /// entry resolves in a Debug build, so nil here means absent.)
    func testDebugOnlyTypesAreCompiledOut() throws {
        let list = try ReleaseDenylist.bundled(for: Self.self)
        XCTAssertFalse(list.requiredTypes.isEmpty)
        XCTAssertGreaterThan(list.forbiddenTypes.count, 10)
        for entry in list.requiredTypes {
            XCTAssertTrue(entry.resolves(), "\(entry) should be in the Release build")
        }
        for entry in list.forbiddenTypes {
            XCTAssertFalse(entry.resolves(), "\(entry) is compiled into the Release build")
        }
    }

    /// App Store readiness, from the bundle that actually ships.
    func testAppStoreInfoPlist() throws {
        let info = try XCTUnwrap(Bundle.main.infoDictionary)
        XCTAssertEqual(info["CFBundleShortVersionString"] as? String, "1.0.0")
        let build = try XCTUnwrap(info["CFBundleVersion"] as? String)
        XCTAssertNotNil(Int(build), "Build number \"\(build)\" must be a plain integer")
        XCTAssertEqual(info["ITSAppUsesNonExemptEncryption"] as? Bool, false)
        XCTAssertEqual(info["UIBackgroundModes"] as? [String], ["location"])
        XCTAssertNotNil(info["UILaunchScreen"] as? [String: Any], "No launch screen")
        let always = try XCTUnwrap(info["NSLocationAlwaysAndWhenInUseUsageDescription"] as? String)
        XCTAssertTrue(always.contains("in the background"), "Location Always must explain background detection")
        XCTAssertTrue(always.contains("parked"), "Location Always must say what it's for")
        for key in [
            "NSLocationWhenInUseUsageDescription",
            "NSMotionUsageDescription",
            "NSFaceIDUsageDescription",
            "NSSpeechRecognitionUsageDescription",
            "NSMicrophoneUsageDescription",
        ] {
            let text = try XCTUnwrap(info[key] as? String, "\(key) missing")
            XCTAssertFalse(text.contains("$("), "\(key) has an unexpanded build variable")
            XCTAssertFalse(text.contains("!"), "\(key) shouldn't shout")
        }
        XCTAssertNotNil(
            Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"),
            "PrivacyInfo.xcprivacy missing from the app bundle"
        )
        let icons = info["CFBundleIcons"] as? [String: Any]
        let primary = icons?["CFBundlePrimaryIcon"] as? [String: Any]
        XCTAssertEqual(primary?["CFBundleIconName"] as? String, "AppIcon", "App icon not compiled in")
    }
}
