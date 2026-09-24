import Foundation
import Observation

/// State machine for linking a parking provider account (server/API.md
/// "Provider accounts"). Used by onboarding step 5, Settings re-link, and
/// the parked sheet's "Link <provider>" routing — the entry points differ,
/// the flow is one.
///
/// intro → signIn (web view) → verifying (POST link) → addingCard
/// (poll link-status) → done | failed(retry).
@MainActor
@Observable
final class ProviderLinkModel {
    enum Stage: Equatable {
        /// Fetching the provider's registry entry from /providers/status.
        case loading
        /// Unknown provider id or the status fetch failed.
        case unavailable
        /// Explains the flow; consent checkbox lives here.
        case intro
        /// The provider's own login page (or the mock stand-in).
        case signIn
        /// POST /providers/:provider/link in flight.
        case verifying
        /// Polling GET link-status while the card goes on the account.
        case addingCard
        case done(dryRun: Bool)
        /// `canRetrySetup`: retry re-runs setup-card; otherwise it reopens
        /// sign-in (the session itself was the problem).
        case failed(reason: String, canRetrySetup: Bool)
    }

    let providerId: String
    private(set) var stage: Stage = .loading
    private(set) var provider: ProviderAccountStatus?
    /// What the app will type into the provider's own page so the user
    /// doesn't enter their details twice. Text inputs only — see
    /// ProviderSignupPrefill.swift for the hard limits.
    private(set) var prefill = ProviderPrefillValues()
    /// The card the PROVIDER account already has on file, learned at link
    /// time (provider_card users) — "Visa •••• 4242" on the done screen.
    private(set) var providerCard: String?
    /// Whether the user pays with the ParkAgent card at all. provider_card
    /// users (the default) link without touching the account's payment
    /// method, so no consent question arises and no card is prepared.
    let usesParkAgentCard = PaymentSource.stored == .issuingCard
    /// "Use my ParkAgent card for parking" — default checked for
    /// issuing_card users; unchecking links the account without touching
    /// its payment method. Always false for provider_card users.
    var consentCardSetup = PaymentSource.stored == .issuingCard

    /// The web view resubmits whenever the cookie set changes; this stops
    /// the same cookies from hammering the server after a failed verify.
    private var lastSubmittedFingerprint: String?

    init(providerId: String) {
        self.providerId = providerId
    }

    func load(api: any APIClient) async {
        guard stage == .loading else { return }
        do {
            let status = try await api.providersStatus()
            guard let match = status.providers.first(where: { $0.id == providerId }) else {
                stage = .unavailable
                return
            }
            provider = match
            // Everything the provider's own page may ask for that we
            // already know. A failure here just means less prefill.
            let vehicle = try? await api.vehicles().first
            let me = try? await api.me()
            prefill = ProviderPrefillValues.from(
                user: me?.user,
                vehicle: vehicle,
                zip: UserDefaults.standard.string(forKey: "profile.zip")
            )
            stage = .intro
        } catch {
            stage = .unavailable
        }
    }

    /// The script the web view injects, or nil when we know nothing worth
    /// typing (or the server sent no signup metadata).
    func prefillScript() -> String? {
        guard let provider, let fields = provider.signup?.prefill, !prefill.isEmpty else { return nil }
        return ProviderPrefillScript.javaScript(
            fields: fields,
            values: prefill,
            allowedDomains: provider.cookieDomains
        )
    }

    /// Sign-in and sign-up start at the same place for Passport; ParkNYC
    /// has a separate registration panel.
    func startURL(creatingAccount: Bool) -> URL? {
        let raw = creatingAccount
            ? (provider?.signup?.url ?? provider?.loginUrl)
            : provider?.loginUrl
        return raw.flatMap(URL.init(string:))
    }

    /// Whether the user said they have no account yet — the web view then
    /// starts on the provider's sign-up page instead of its sign-in one.
    /// For Passport the two are the same screen, so it changes nothing but
    /// the wording.
    private(set) var creatingAccount = false

    /// Continue from the intro: for ParkAgent-card users, make sure the
    /// card exists (lazy creation, idempotent — a failure surfaces later as
    /// a typed no_card with retry), then open the provider's page.
    /// provider_card users never need a card prepared.
    func startSignIn(api: any APIClient, creatingAccount: Bool = false) {
        self.creatingAccount = creatingAccount
        stage = .signIn
        if consentCardSetup {
            Task { _ = try? await api.prepareCard() }
        }
    }

    /// The web view saw session cookies (or the mock sign-in button fired).
    func cookiesCaptured(_ cookies: [ProviderCookie], api: any APIClient) async {
        guard stage == .signIn, !cookies.isEmpty else { return }
        let fingerprint = cookies.map { "\($0.domain)|\($0.name)|\($0.value)" }.sorted().joined(separator: ";")
        guard fingerprint != lastSubmittedFingerprint else { return }
        lastSubmittedFingerprint = fingerprint

        stage = .verifying
        do {
            let response = try await api.linkProvider(
                providerId,
                cookies: cookies,
                setUpCard: consentCardSetup,
                consent: consentCardSetup
            )
            if let last4 = response.cardLast4 {
                providerCard = "\(response.cardBrand ?? "Card") •••• \(last4)"
            }
            if let jobId = response.jobId {
                stage = .addingCard
                await poll(jobId: jobId, api: api)
            } else {
                stage = .done(dryRun: false)
            }
        } catch APIError.refused(let code) where code == "verification_failed" {
            // Not actually signed in yet (or the cookies were pre-login
            // noise) — keep the login page up and wait for fresher cookies.
            stage = .signIn
        } catch APIError.refused(let code) where code == "no_session_cookies" {
            stage = .signIn
        } catch {
            let message = (error as? APIError)?.errorDescription ?? "The link attempt did not reach the server."
            stage = .failed(reason: message, canRetrySetup: false)
        }
    }

    private func poll(jobId: String, api: any APIClient) async {
        while true {
            do {
                let status = try await api.linkStatus(providerId: providerId, jobId: jobId)
                switch status.phase {
                case "done":
                    stage = .done(dryRun: status.dryRun ?? false)
                    return
                case "failed":
                    stage = .failed(
                        reason: Self.plainReason(status.reason ?? "unknown"),
                        canRetrySetup: status.retrySafe ?? false
                    )
                    return
                default:
                    stage = .addingCard
                }
            } catch {
                // The job store is in-memory server-side; a dropped poll is
                // retryable by re-running setup-card.
                stage = .failed(
                    reason: "Lost track of the card setup. It may have finished — retry is safe.",
                    canRetrySetup: true
                )
                return
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    func retry(api: any APIClient) async {
        guard case .failed(_, let canRetrySetup) = stage else { return }
        if canRetrySetup {
            stage = .addingCard
            do {
                let result = try await api.setupCard(providerId: providerId)
                stage = .done(dryRun: result.dryRun ?? false)
            } catch {
                let code = refusalCode(from: error)
                stage = .failed(
                    reason: Self.plainReason(code ?? "unknown"),
                    canRetrySetup: code != "no_card" && code != "auth_expired"
                )
            }
        } else {
            // The session was the problem: back to the login page.
            lastSubmittedFingerprint = nil
            stage = .signIn
        }
    }

    private func refusalCode(from error: any Error) -> String? {
        if case APIError.refused(let code) = error { return code }
        return nil
    }

    /// The typed reason, in plain words.
    static func plainReason(_ code: String) -> String {
        switch code {
        case "auth_expired": "The sign-in did not stick. Sign in once more and it should hold."
        case "unsupported_card_brand": "The provider did not accept this card type."
        case "no_card": "Your ParkAgent card was not ready yet."
        case "payment_declined": "The provider refused the card."
        case "ui_changed": "The provider changed their site and the setup could not finish."
        case "network": "The connection dropped while adding your card."
        default: "Something went wrong while adding your card."
        }
    }
}
