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

    /// The mock's ParkAgent card must mirror the live server: our Issuing
    /// cards are Mastercard, and the reveal PAN's last4 must agree with the
    /// card the Wallet shows.
    func testMockParkAgentCardIsMastercardAndConsistent() async throws {
        UserDefaults.standard.set(WalletMockScenario.parkagentSandbox.rawValue, forKey: WalletMockScenario.defaultsKey)
        defer { UserDefaults.standard.removeObject(forKey: WalletMockScenario.defaultsKey) }
        let api = MockAPI()
        let wallet = try await api.wallet()
        let card = try XCTUnwrap(wallet.parkagentCard.card)
        XCTAssertEqual(card.brand, "Mastercard")
        let revealed = try await api.revealCardDetails()
        XCTAssertEqual(String(revealed.number.suffix(4)), card.last4)
    }
}
