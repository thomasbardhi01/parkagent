import SwiftUI
import WebKit

/// The provider's own login (or sign-up) page in an in-app web view. We
/// never see the password; captcha and 2FA happen naturally in the page. A
/// background task polls the cookie store, and whenever cookies on the
/// provider's registered session domains change, they go up to the model —
/// which posts them to the server for headless verification and quietly
/// keeps the page open if they were not a signed-in session yet.
///
/// `prefillScript`, when present, types the user's own details into the
/// provider's empty text inputs so nobody enters them twice. It fills text
/// only — never a terms checkbox, a verification code, or a captcha, and
/// it never submits (see ProviderSignupPrefill.swift).
struct ProviderLoginWebView: UIViewRepresentable {
    let url: URL
    /// Suffix-matched, leading dot ignored — same rule as the server.
    let cookieDomains: [String]
    var prefillScript: String?
    let onCookies: ([ProviderCookie]) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        if let prefillScript {
            // At documentEnd on every frame load: these are SPAs, and the
            // script itself re-runs on a timer for late-rendered inputs.
            configuration.userContentController.addUserScript(
                WKUserScript(
                    source: prefillScript,
                    injectionTime: .atDocumentEnd,
                    forMainFrameOnly: true
                )
            )
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.load(URLRequest(url: url))
        context.coordinator.startWatching(store: configuration.websiteDataStore.httpCookieStore)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.stopWatching()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(cookieDomains: cookieDomains, onCookies: onCookies)
    }

    @MainActor
    final class Coordinator {
        private let cookieDomains: [String]
        private let onCookies: ([ProviderCookie]) -> Void
        private var watchTask: Task<Void, Never>?

        init(cookieDomains: [String], onCookies: @escaping ([ProviderCookie]) -> Void) {
            self.cookieDomains = cookieDomains
            self.onCookies = onCookies
        }

        func startWatching(store: WKHTTPCookieStore) {
            watchTask?.cancel()
            watchTask = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self else { return }
                    let cookies = await store.allCookies()
                    let matched = cookies.filter { self.matches($0.domain) }
                    if !matched.isEmpty {
                        self.onCookies(matched.map(Self.wireCookie))
                    }
                    try? await Task.sleep(for: .seconds(1.5))
                }
            }
        }

        func stopWatching() {
            watchTask?.cancel()
            watchTask = nil
        }

        private func matches(_ domain: String) -> Bool {
            let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            let lowered = bare.lowercased()
            return cookieDomains.contains { allowed in
                lowered == allowed.lowercased() || lowered.hasSuffix("." + allowed.lowercased())
            }
        }

        private static func wireCookie(_ cookie: HTTPCookie) -> ProviderCookie {
            ProviderCookie(
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                expires: cookie.expiresDate?.timeIntervalSince1970,
                httpOnly: cookie.isHTTPOnly,
                secure: cookie.isSecure,
                sameSite: sameSite(cookie)
            )
        }

        private static func sameSite(_ cookie: HTTPCookie) -> String? {
            switch cookie.sameSitePolicy {
            case .some(.sameSiteLax): "Lax"
            case .some(.sameSiteStrict): "Strict"
            default: nil
            }
        }
    }
}
