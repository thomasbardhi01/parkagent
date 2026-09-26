import Foundation
import Observation

/// State machine for linking a parking provider account (server/API.md
/// "Provider accounts"). Used by onboarding step 5, Settings re-link, and
/// the parked sheet's "Link <provider>" routing — the entry points differ,
/// the flow is one.
///
/// intro → signIn (web view) → working (POST link answers at once with a
/// job; the app polls its real steps: queued, checking the sign-in,
/// reading the card, adding the ParkAgent card) → done | failed(retry).
/// After 20 seconds the user may move on; the server pushes the outcome.
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
        /// The link job is running (see `progress` for its step).
        case verifying
        /// The ParkAgent card is going on the account (the chained setup).
        case addingCard
        /// The user moved on while it ran; the server will push the outcome.
        case continuingInBackground
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
    /// time (provider_card users) — "Visa ••4242" on the done screen.
    private(set) var providerCard: String?
    /// Whether the user pays with the ParkAgent card at all. provider_card
    /// users (the default) link without touching the account's payment
    /// method, so no consent question arises and no card is prepared.
    let usesParkAgentCard = PaymentSource.stored == .parkagentCard
    /// "Use my ParkAgent card for parking" — default checked for
    /// parkagent_card users; unchecking links the account without touching
    /// its payment method. Always false for provider_card users.
    var consentCardSetup = PaymentSource.stored == .parkagentCard

    /// The web view resubmits whenever the cookie set changes; this stops
    /// the same cookies from hammering the server after a failed verify.
    private var lastSubmittedFingerprint: String?
    /// The cookies of the last submission, for a retry of a link that
    /// failed for a reason of the provider's, not the sign-in's.
    private var lastCookies: [ProviderCookie] = []

    /// The job's latest answer while it runs: which step, its place in
    /// line, the attempt. nil before the first poll.
    private(set) var progress: LinkStatusResponse?
    /// When this link attempt started, for the elapsed-time line.
    private(set) var startedAt: Date?
    private(set) var jobId: String?
    /// After this long the user may move on (and hear the outcome by push).
    static let continueAfter: TimeInterval = 20
    /// Between link-status polls (the unit tests shorten it).
    var pollInterval: Duration = .seconds(1)

    /// The step in plain words, e.g. "Checking your ParkBoston sign-in…".
    func stepText(providerName: String) -> String {
        LinkProgressCopy.step(progress, providerName: providerName, addingCard: stage == .addingCard)
    }

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
        lastCookies = cookies
        await submit(cookies, api: api)
    }

    private func submit(_ cookies: [ProviderCookie], api: any APIClient) async {
        stage = .verifying
        progress = nil
        // A duration on the real clock, like the TimelineView that shows
        // it — not AppClock, the business "now" the UI tests freeze.
        startedAt = Date()
        do {
            let response = try await api.linkProvider(
                providerId,
                cookies: cookies,
                setUpCard: consentCardSetup,
                consent: consentCardSetup
            )
            // An older server answered the whole link synchronously.
            if let card = WalletCopy.masked(brand: response.cardBrand, last4: response.cardLast4) {
                providerCard = card
            }
            guard let jobId = response.jobId else {
                stage = .done(dryRun: false)
                return
            }
            self.jobId = jobId
            await poll(jobId: jobId, api: api)
        } catch APIError.refused(let code) where code == "verification_failed" || code == "no_session_cookies" {
            // Not actually signed in yet (or the cookies were pre-login
            // noise) — keep the login page up and wait for fresher cookies.
            stage = .signIn
        } catch {
            let message = (error as? APIError)?.errorDescription ?? "The link attempt did not reach the server."
            stage = .failed(reason: message, canRetrySetup: false)
        }
    }

    /// Follow the job to its end, showing each real step. A few dropped
    /// polls are shrugged off (a tunnel, a lift); the job itself is safe on
    /// the server either way.
    private func poll(jobId: String, api: any APIClient) async {
        var misses = 0
        while !Task.isCancelled {
            if stage == .continuingInBackground { return }
            do {
                let status = try await api.linkStatus(providerId: providerId, jobId: jobId)
                misses = 0
                progress = status
                if let card = WalletCopy.masked(brand: status.cardBrand, last4: status.cardLast4) {
                    providerCard = card
                }
                switch status.phase {
                case "done":
                    stage = .done(dryRun: status.dryRun ?? false)
                    return
                case "failed":
                    finish(failed: status)
                    return
                case "adding_card":
                    stage = .addingCard
                default:
                    if stage != .continuingInBackground { stage = .verifying }
                }
            } catch {
                misses += 1
                if misses >= 5 {
                    // The job runs on regardless; ask for the outcome by push.
                    await continueInBackground(api: api)
                    return
                }
            }
            try? await Task.sleep(for: pollInterval)
        }
    }

    private func finish(failed status: LinkStatusResponse) {
        let reason = status.reason ?? "unknown"
        if reason == "auth_expired", status.linked != true {
            // The captured cookies weren't a session yet: stay on the
            // provider's page; fresher cookies resubmit on their own.
            stage = .signIn
            return
        }
        if status.linked == true {
            // Linked, but the chained ParkAgent-card setup failed.
            stage = .failed(reason: Self.plainReason(reason), canRetrySetup: status.retrySafe ?? false)
        } else {
            stage = .failed(reason: Self.plainLinkReason(reason, providerName: provider?.displayName), canRetrySetup: false)
            retryResubmits = true
        }
    }

    /// Set when a link (not a card setup) failed for the provider's own
    /// reasons: Retry sends the same sign-in again rather than reopening it.
    private var retryResubmits = false

    /// "Continue — we'll let you know": the server pushes the outcome.
    func continueInBackground(api: any APIClient) async {
        stage = .continuingInBackground
        guard let jobId else { return }
        _ = try? await api.notifyLinkJob(providerId: providerId, jobId: jobId)
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
        } else if retryResubmits, !lastCookies.isEmpty {
            // The provider was slow or down, not the sign-in: try the same
            // one again.
            retryResubmits = false
            await submit(lastCookies, api: api)
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

    /// Why a LINK (not a card setup) didn't finish, in plain words.
    static func plainLinkReason(_ code: String, providerName: String?) -> String {
        let name = providerName ?? "The provider"
        return switch code {
        case "timeout": "\(name) took too long to answer. Try again in a minute."
        case "busy": "ParkAgent was busy with other parking accounts. Try again in a minute."
        case "provider_unavailable": "\(name) isn't responding right now. Try again in a few minutes."
        case "network": "\(name) couldn't be reached. Try again in a minute."
        case "state_unreadable", "provider_linking_not_configured": "The server can't link accounts right now."
        default: "The link didn't finish. Try again."
        }
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
