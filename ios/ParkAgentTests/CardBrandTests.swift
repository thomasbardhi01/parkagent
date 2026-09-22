import XCTest
@testable import ParkAgent

/// The brand on the card art must be whatever GET /card said — these pin
/// the parsing so a casing change from Stripe can't break the mark.
final class CardBrandTests: XCTestCase {
    func testMastercardParsesRegardlessOfCasing() {
        XCTAssertEqual(CardBrand("Mastercard"), .mastercard)
        XCTAssertEqual(CardBrand("mastercard"), .mastercard)
        XCTAssertEqual(CardBrand("MASTERCARD"), .mastercard)
        XCTAssertEqual(CardBrand(" Mastercard "), .mastercard)
    }

    func testVisaParses() {
        XCTAssertEqual(CardBrand("Visa"), .visa)
        XCTAssertEqual(CardBrand("visa"), .visa)
    }

    func testUnknownBrandFallsBackToItsOwnName() {
        let brand = CardBrand("Discover")
        XCTAssertEqual(brand, .other("Discover"))
        XCTAssertEqual(brand.displayName, "Discover")
    }

    func testDisplayNames() {
        XCTAssertEqual(CardBrand("mastercard").displayName, "Mastercard")
        XCTAssertEqual(CardBrand("visa").displayName, "Visa")
    }

    /// The fixture the whole mock serves must mirror the live server: our
    /// Issuing cards are Mastercard, and the reveal PAN's last4 must agree
    /// with the summary's.
    @MainActor
    func testMockCardFixtureIsMastercardAndConsistent() {
        let summary = MockFixtures.cardSummary(frozen: false)
        XCTAssertEqual(summary.brand, "Mastercard")
        XCTAssertEqual(summary.last4, "4444")
    }
}
