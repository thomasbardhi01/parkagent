import XCTest
@testable import ParkAgent

/// The link-or-create prefill: which value goes in which field, and the
/// hard limits on what the injected script is allowed to touch.
final class ProviderPrefillTests: XCTestCase {
    private let user = AuthUser(
        id: "u1",
        name: "Thomas Bardhi",
        email: "thomas@example.com",
        emailVerified: true,
        phone: "+16175550100",
        phoneVerified: false,
        appleLinked: true,
        googleLinked: false
    )
    private let vehicle = VehicleSummary(id: "v1", plate: "ABC1234", state: "NY", label: nil)

    func testValuesComeFromTheProfileAndVehicle() {
        let values = ProviderPrefillValues.from(user: user, vehicle: vehicle, zip: "10024")

        XCTAssertEqual(values.value(for: "email"), "thomas@example.com")
        XCTAssertEqual(values.value(for: "phone"), "+16175550100")
        XCTAssertEqual(values.value(for: "firstName"), "Thomas")
        XCTAssertEqual(values.value(for: "lastName"), "Bardhi")
        XCTAssertEqual(values.value(for: "zip"), "10024")
        XCTAssertEqual(values.value(for: "plate"), "ABC1234")
    }

    /// Passport's single field takes either; the phone wins because the
    /// code arrives by text faster than by mail.
    func testEmailOrPhonePrefersThePhone() {
        let withPhone = ProviderPrefillValues.from(user: user, vehicle: nil, zip: nil)
        XCTAssertEqual(withPhone.value(for: "emailOrPhone"), "+16175550100")

        var noPhone = user
        noPhone.phone = nil
        let emailOnly = ProviderPrefillValues.from(user: noPhone, vehicle: nil, zip: nil)
        XCTAssertEqual(emailOnly.value(for: "emailOrPhone"), "thomas@example.com")
    }

    func testEmptyWhenNothingIsKnown() {
        XCTAssertTrue(ProviderPrefillValues.from(user: nil, vehicle: nil, zip: nil).isEmpty)
        XCTAssertFalse(ProviderPrefillValues.from(user: user, vehicle: nil, zip: nil).isEmpty)
    }

    func testScriptFillsKnownFieldsOnly() {
        let values = ProviderPrefillValues(
            email: "thomas@example.com",
            phone: nil,
            firstName: "Thomas",
            lastName: nil,
            zip: nil,
            plate: nil
        )
        let fields = [
            SignupPrefillField(field: "firstName", selector: "input[name='firstName']"),
            SignupPrefillField(field: "lastName", selector: "input[name='lastName']"),
            SignupPrefillField(field: "email", selector: "input[name='email']"),
            SignupPrefillField(field: "zip", selector: "input[name='zipCode']"),
        ]
        let script = ProviderPrefillScript.javaScript(fields: fields, values: values)

        let js = try? XCTUnwrap(script)
        XCTAssertNotNil(js)
        XCTAssertTrue(js!.contains("input[name='firstName']"), "Known field missing")
        XCTAssertTrue(js!.contains("input[name='email']"), "Known field missing")
        // Unknown values produce no assignment at all.
        XCTAssertFalse(js!.contains("lastName"), "Unknown field should not be filled")
        XCTAssertFalse(js!.contains("zipCode"), "Unknown field should not be filled")
    }

    /// The whole contract of this feature: text in, nothing else. A script
    /// that submitted a form or ticked a box would be creating an account
    /// without the user, which we never do.
    func testScriptNeverSubmitsOrTicksAnything() {
        let values = ProviderPrefillValues.from(user: user, vehicle: vehicle, zip: "10024")
        let fields = [
            SignupPrefillField(field: "email", selector: "input[name='email']"),
            SignupPrefillField(field: "plate", selector: "input[name='licensePlate']"),
        ]
        let js = ProviderPrefillScript.javaScript(fields: fields, values: values) ?? ""

        for forbidden in [".submit(", ".click(", "checked", "form.submit"] {
            XCTAssertFalse(js.contains(forbidden), "Prefill must never \(forbidden)")
        }
        // And it only writes into inputs that are still empty, so it can
        // never overwrite what the user typed.
        XCTAssertTrue(js.contains("if (!el || el.value) return;"), "Must skip non-empty inputs")
    }

    func testScriptIsNilWithNothingToFill() {
        let fields = [SignupPrefillField(field: "email", selector: "input[name='email']")]
        XCTAssertNil(
            ProviderPrefillScript.javaScript(fields: fields, values: ProviderPrefillValues()),
            "No known values should mean no script at all"
        )
    }

    /// Values are JSON-quoted, so a quote or backslash in a name stays
    /// data instead of becoming code. Checked by decoding the literal the
    /// script actually emitted back to the original string — a substring
    /// search would pass on a value that merely looks escaped.
    func testValuesAreEscaped() throws {
        let hostile = "o'brien\"; alert(1); //@example.com"
        let values = ProviderPrefillValues(
            email: hostile,
            phone: nil,
            firstName: nil,
            lastName: nil,
            zip: nil,
            plate: nil
        )
        let fields = [SignupPrefillField(field: "email", selector: "input[name='email']")]
        let js = try XCTUnwrap(ProviderPrefillScript.javaScript(fields: fields, values: values))

        // fill("input[name='email']", "<literal>");
        // The closing quote has to be found by scanning, not searching: the
        // hostile value contains ");  and a quote of its own.
        let marker = "fill(\"input[name='email']\", "
        let start = try XCTUnwrap(js.range(of: marker)).upperBound
        let literal = try XCTUnwrap(Self.jsonStringLiteral(in: js, from: start))

        let decoded = try JSONSerialization.jsonObject(
            with: Data("[\(literal)]".utf8)
        ) as? [String]
        XCTAssertEqual(decoded?.first, hostile, "The emitted literal must decode back to the value")
        XCTAssertTrue(literal.hasPrefix("\"") && literal.hasSuffix("\""), "Value must be quoted")
    }

    /// Read one complete JSON string literal starting at `index`, honoring
    /// backslash escapes so an escaped quote doesn't end it early.
    private static func jsonStringLiteral(
        in text: String,
        from index: String.Index
    ) -> String? {
        guard index < text.endIndex, text[index] == "\"" else { return nil }
        var cursor = text.index(after: index)
        var escaped = false
        while cursor < text.endIndex {
            let character = text[cursor]
            if escaped {
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "\"" {
                return String(text[index...cursor])
            }
            cursor = text.index(after: cursor)
        }
        return nil
    }
}
