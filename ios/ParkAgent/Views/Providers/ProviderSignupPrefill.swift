import Foundation

/// What the app types into the provider's own sign-in / sign-up page so
/// nobody enters their details twice.
///
/// Hard limits, by design: this fills TEXT INPUTS ONLY. It never ticks a
/// terms checkbox, never answers a verification code, never touches a
/// captcha, never submits the form, and never invents a password. The user
/// is present on the provider's page and finishes it themselves — the app
/// just saves them the typing.
struct ProviderPrefillValues: Equatable {
    var email: String?
    var phone: String?
    var firstName: String?
    var lastName: String?
    var zip: String?
    var plate: String?

    /// The value for a registry field key, or nil when we don't know it.
    func value(for field: String) -> String? {
        switch field {
        // Passport's one field takes either; the phone is the better
        // choice when we have it (the code arrives by text, faster).
        case "emailOrPhone": phone ?? email
        case "email": email
        case "phone": phone
        case "firstName": firstName
        case "lastName": lastName
        case "zip": zip
        case "plate": plate
        default: nil
        }
    }

    var isEmpty: Bool {
        value(for: "email") == nil
            && value(for: "phone") == nil
            && value(for: "firstName") == nil
            && value(for: "plate") == nil
    }

    /// Build from the signed-in profile and the saved vehicle.
    static func from(user: AuthUser?, vehicle: VehicleSummary?, zip: String?) -> ProviderPrefillValues {
        let parts = (user?.name ?? "").split(separator: " ", maxSplits: 1).map(String.init)
        return ProviderPrefillValues(
            email: user?.email,
            phone: user?.phone,
            firstName: parts.first,
            lastName: parts.count > 1 ? parts[1] : nil,
            zip: zip,
            plate: vehicle?.plate
        )
    }
}

/// The JavaScript that fills the page. One assignment per known field,
/// with the events the provider's own framework listens for so the value
/// registers as typed rather than pasted-and-ignored.
enum ProviderPrefillScript {
    static func javaScript(
        fields: [SignupPrefillField],
        values: ProviderPrefillValues
    ) -> String? {
        let assignments = fields.compactMap { field -> String? in
            guard let value = values.value(for: field.field), !value.isEmpty else { return nil }
            return """
            fill(\(jsString(field.selector)), \(jsString(value)));
            """
        }
        guard !assignments.isEmpty else { return nil }
        // Re-runs on a timer: these are single-page apps, so the inputs
        // often do not exist yet when the page first loads. Filling only
        // EMPTY inputs means we never fight the user's own typing.
        return """
        (function () {
          function fill(selector, value) {
            var el = document.querySelector(selector);
            if (!el || el.value) return;
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          function run() { \(assignments.joined(separator: " ")) }
          run();
          var tries = 0;
          var timer = setInterval(function () {
            tries += 1;
            run();
            if (tries > 20) clearInterval(timer);
          }, 500);
        })();
        """
    }

    /// JSON-quote a string for safe embedding in the script.
    private static func jsString(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value])
        guard
            let data,
            let array = String(data: data, encoding: .utf8),
            array.count >= 2
        else { return "\"\"" }
        // ["…"] → "…"
        return String(array.dropFirst().dropLast())
    }
}
