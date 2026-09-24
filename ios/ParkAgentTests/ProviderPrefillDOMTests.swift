import WebKit
import XCTest
@testable import ParkAgent

/// The link-or-create prefill run against a real DOM. The non-negotiable is
/// behavioural — type into EMPTY TEXT inputs on the provider's own page and
/// nothing else — so it is checked on what the page looks like after the
/// actual script has run, not by reading the script's source.
@MainActor
final class ProviderPrefillDOMTests: XCTestCase {
    /// Every trap a selector could land on, one per field key, plus a form
    /// whose submit would be recorded.
    private static let page = """
    <!doctype html><html><body>
    <form id="f" onsubmit="window.__submitted = true; return false;">
      <input name="first" type="text">
      <input name="pw" type="password">
      <input name="agree" type="checkbox" value="off">
      <input name="secret" type="hidden" value="">
      <input name="typed" type="text" value="mine">
      <input name="cleared" type="text">
      <input name="ro" type="text" readonly>
      <div style="display:none"><input name="invisible" type="text"></div>
      <select name="menu"><option value="">-</option><option value="x">x</option></select>
    </form>
    <script>
      window.__submitted = false;
      document.getElementById('f').addEventListener('submit', function () { window.__submitted = true; });
      setTimeout(function () {
        var late = document.createElement('input');
        late.name = 'later'; late.type = 'email';
        document.getElementById('f').appendChild(late);
      }, 600);
    </script>
    </body></html>
    """

    private static let fields = [
        SignupPrefillField(field: "firstName", selector: "input[name='first']"),
        SignupPrefillField(field: "email", selector: "input[name='pw']"),
        SignupPrefillField(field: "phone", selector: "input[name='agree']"),
        SignupPrefillField(field: "lastName", selector: "input[name='secret']"),
        SignupPrefillField(field: "zip", selector: "input[name='typed']"),
        SignupPrefillField(field: "plate", selector: "input[name='cleared']"),
        SignupPrefillField(field: "emailOrPhone", selector: "input[name='later']"),
        SignupPrefillField(field: "firstName", selector: "input[name='ro']"),
        SignupPrefillField(field: "lastName", selector: "input[name='invisible']"),
        SignupPrefillField(field: "email", selector: "select[name='menu']"),
    ]

    private static let values = ProviderPrefillValues(
        email: "pat@example.com",
        phone: "+16175550100",
        firstName: "Pat",
        lastName: "Driver",
        zip: "02116",
        plate: "ABC1234"
    )

    private func load(_ html: String, at base: String) async throws -> WKWebView {
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let loaded = NavigationWaiter()
        webView.navigationDelegate = loaded
        webView.loadHTMLString(html, baseURL: URL(string: base)!)
        try await loaded.wait()
        return webView
    }

    private func state(_ webView: WKWebView) async throws -> [String: String] {
        let json = try await webView.evaluateJavaScript("""
        JSON.stringify({
          first: document.querySelector("[name=first]").value,
          pw: document.querySelector("[name=pw]").value,
          agreeChecked: String(document.querySelector("[name=agree]").checked),
          agreeValue: document.querySelector("[name=agree]").value,
          secret: document.querySelector("[name=secret]").value,
          typed: document.querySelector("[name=typed]").value,
          cleared: document.querySelector("[name=cleared]").value,
          later: (document.querySelector("[name=later]") || {}).value || "",
          ro: document.querySelector("[name=ro]").value,
          invisible: document.querySelector("[name=invisible]").value,
          menu: document.querySelector("[name=menu]").value,
          submitted: String(window.__submitted),
          focused: document.activeElement ? (document.activeElement.name || document.activeElement.tagName) : ""
        })
        """) as? String
        let data = try XCTUnwrap(json).data(using: .utf8)!
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
    }

    private func script() throws -> String {
        try XCTUnwrap(ProviderPrefillScript.javaScript(
            fields: Self.fields,
            values: Self.values,
            allowedDomains: ["flowbirdapp.com"]
        ))
    }

    /// On the provider's own page: only the empty, visible, editable text
    /// inputs get a value; every trap is untouched; nothing submits or
    /// steals focus; a late-rendered input is filled; and a value the user
    /// deletes is never put back.
    func testFillsOnlyEmptyTextInputsOnTheProvidersPage() async throws {
        let webView = try await load(Self.page, at: "https://my.nyc.flowbirdapp.com/register")
        _ = try await webView.evaluateJavaScript(try script() + "\ntrue;")

        var dom = try await state(webView)
        XCTAssertEqual(dom["first"], "Pat")
        XCTAssertEqual(dom["cleared"], "ABC1234")
        XCTAssertEqual(dom["pw"], "", "a password field must never be filled")
        XCTAssertEqual(dom["agreeChecked"], "false", "a checkbox must never be ticked")
        XCTAssertEqual(dom["agreeValue"], "off")
        XCTAssertEqual(dom["secret"], "", "a hidden input must never be filled")
        XCTAssertEqual(dom["typed"], "mine", "what the user typed must survive")
        XCTAssertEqual(dom["ro"], "", "a read-only field must never be filled")
        XCTAssertEqual(dom["invisible"], "", "an unrendered field must never be filled")
        XCTAssertEqual(dom["menu"], "", "only <input>s are typed into")

        // The user clears a prefilled field; the timer keeps running for
        // late inputs but must not put it back.
        _ = try await webView.evaluateJavaScript(
            "document.querySelector('[name=cleared]').value = ''; true;"
        )
        try await Task.sleep(for: .milliseconds(1600))
        dom = try await state(webView)
        XCTAssertEqual(dom["cleared"], "", "a value the user deleted came back")
        XCTAssertEqual(dom["later"], "+16175550100", "a late-rendered input should still be filled")
        XCTAssertEqual(dom["submitted"], "false", "prefill must never submit")
        XCTAssertNotEqual(dom["focused"], "first", "prefill must not move focus")
    }

    /// The same script on any other site — a terms page, an SSO button, an
    /// ad — types nothing, even where the selectors match.
    func testTypesNothingOffTheProvidersSite() async throws {
        for base in [
            "https://accounts.example-sso.com/login",
            // Suffix tricks: neither is under flowbirdapp.com.
            "https://flowbirdapp.com.evil.example/",
            "https://notflowbirdapp.com/",
        ] {
            let webView = try await load(Self.page, at: base)
            _ = try await webView.evaluateJavaScript(try script() + "\ntrue;")
            try await Task.sleep(for: .milliseconds(700))
            let dom = try await state(webView)
            XCTAssertEqual(dom["first"], "", "typed into \(base)")
            XCTAssertEqual(dom["later"], "", "typed into \(base)")
        }
    }
}

/// Resumes once the web view finishes (or fails) its navigation.
@MainActor
private final class NavigationWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?
    private var finished: Result<Void, Error>?

    func wait() async throws {
        if let finished { return try finished.get() }
        try await withCheckedThrowingContinuation { continuation = $0 }
    }

    private func settle(_ result: Result<Void, Error>) {
        guard finished == nil else { return }
        finished = result
        continuation?.resume(with: result)
        continuation = nil
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated { settle(.success(())) }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { settle(.failure(error)) }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        MainActor.assumeIsolated { settle(.failure(error)) }
    }
}
