import Foundation
import Testing

@testable import ParkAgent

/// Which fixes may say where a car is: the server widens its zone search to
/// the fix's accuracy, so a blurred, stale, or jumped fix prices the wrong
/// block.
struct FixGateTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func fix(_ northM: Double = 0, accuracy: Double = 8, at offset: TimeInterval = 0) -> ParkFix {
        ParkFix(latitude: 42.35038 + northM / 111_320, longitude: -71.0763, accuracy: accuracy, at: now.addingTimeInterval(offset))
    }

    @Test func aGoodFixPasses() {
        var gate = FixGate()
        #expect(gate.evaluate(fix(), receivedAt: now) == .accept)
    }

    @Test func invalidAndBlurredFixesAreRejected() {
        var gate = FixGate()
        #expect(gate.evaluate(fix(accuracy: -1), receivedAt: now) == .reject(.invalid))
        #expect(gate.evaluate(fix(accuracy: 0), receivedAt: now) == .reject(.invalid))
        #expect(gate.evaluate(fix(accuracy: 51), receivedAt: now) == .reject(.coarse))
        // What iOS hands out with Precise Location off.
        #expect(gate.evaluate(fix(accuracy: 3_000), receivedAt: now) == .reject(.coarse))
        #expect(gate.evaluate(fix(accuracy: 50), receivedAt: now) == .accept)
    }

    @Test func aCachedFixFromEarlierIsStale() {
        var gate = FixGate()
        #expect(gate.evaluate(fix(at: -16), receivedAt: now) == .reject(.stale))
        #expect(gate.evaluate(fix(at: -15), receivedAt: now) == .accept)
    }

    @Test func aJumpFasterThanACarIsAnOutlier() {
        var gate = FixGate()
        #expect(gate.evaluate(fix(0), receivedAt: now) == .accept)
        // 800 m in one second.
        #expect(gate.evaluate(fix(800, at: 1), receivedAt: now.addingTimeInterval(1)) == .reject(.outlier))
        // 25 m in one second is a car, not a glitch.
        #expect(gate.evaluate(fix(25, at: 2), receivedAt: now.addingTimeInterval(2)) == .accept)
    }

    @Test func jumpsWithinBothFixesErrorAreNotOutliers() {
        var gate = FixGate()
        #expect(gate.evaluate(fix(0, accuracy: 45), receivedAt: now) == .accept)
        // 150 m, but 90 of it is the two fixes' own error.
        #expect(gate.evaluate(fix(150, accuracy: 45, at: 1), receivedAt: now.addingTimeInterval(1)) == .accept)
    }

    /// A bad first fix must not lock out every good one after it.
    @Test func threeAgreeingFixesReplaceABadAnchor() {
        var gate = FixGate()
        #expect(gate.evaluate(fix(900), receivedAt: now) == .accept)   // the glitch, first
        #expect(gate.evaluate(fix(0, at: 1), receivedAt: now.addingTimeInterval(1)) == .reject(.outlier))
        #expect(gate.evaluate(fix(2, at: 2), receivedAt: now.addingTimeInterval(2)) == .reject(.outlier))
        #expect(gate.evaluate(fix(1, at: 3), receivedAt: now.addingTimeInterval(3)) == .accept)
        #expect(gate.evaluate(fix(0, at: 4), receivedAt: now.addingTimeInterval(4)) == .accept)
    }
}
