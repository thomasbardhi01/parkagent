import Foundation
import LocalAuthentication
import Observation
import UIKit

/// The Wallet's state, owned once by AppModel so the Wallet tab, the
/// Account sheet's "How you pay" row, and onboarding's pay step all read
/// the same GET /wallet answer — they can't contradict each other.
@MainActor
@Observable
final class WalletModel {
    private(set) var response: WalletResponse?
    private(set) var isLoading = false
    private(set) var loadFailed = false

    /// The full Activity list (the Activity tab); the Wallet's own section
    /// shows `response.activity`.
    private(set) var activity: [ActivityItem] = []
    private(set) var activityCursor: String?
    private(set) var activityLoaded = false
    private(set) var activityFailed = false
    private(set) var isLoadingActivity = false

    /// Non-nil while the ParkAgent card's number and CVC are on screen.
    private(set) var revealed: RevealedCardDetails?
    private(set) var isRevealing = false
    private(set) var isTogglingFreeze = false
    /// In-flight source switch / card save / Link connect.
    private(set) var isWorking = false

    /// Failures surfaced as an alert.
    var actionError: APIError?

    private var hideTask: Task<Void, Never>?

    /// How long revealed details stay on screen.
    static let revealDuration: Duration = .seconds(30)

    var activeSource: PaymentSource { response?.activeSource ?? PaymentSource.stored }
    var parkAgentCard: ParkAgentCard? { response?.parkagentCard.card }

    // MARK: - Loading

    func load(api: any APIClient) async {
        isLoading = response == nil
        loadFailed = false
        do {
            let fresh = try await api.wallet()
            response = fresh
            // Onboarding routing and the link flow read the stored choice.
            UserDefaults.standard.set(fresh.activeSource.rawValue, forKey: PaymentSource.defaultsKey)
        } catch {
            // A cancelled task (the view went away) is not a failure.
            if !Task.isCancelled { loadFailed = response == nil }
        }
        isLoading = false
    }

    func loadActivity(api: any APIClient, reset: Bool) async {
        guard !isLoadingActivity else { return }
        if !reset && activityCursor == nil && activityLoaded { return }
        isLoadingActivity = true
        activityFailed = false
        do {
            let page = try await api.walletActivity(cursor: reset ? nil : activityCursor)
            activity = reset ? page.items : activity + page.items
            activityCursor = page.nextCursor
            activityLoaded = true
        } catch {
            if !Task.isCancelled { activityFailed = !activityLoaded }
        }
        isLoadingActivity = false
    }

    /// Everything signed-out: nothing of this account survives a sign-out.
    func reset() {
        hideDetails()
        response = nil
        activity = []
        activityCursor = nil
        activityLoaded = false
    }

    // MARK: - Choosing how to pay

    /// PUT /wallet/source, then a fresh summary. False means it was refused
    /// and `actionError` says why.
    @discardableResult
    func choose(_ source: PaymentSource, consent: Bool, api: any APIClient) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        let sandbox = source == .parkagentCard
            && FeatureFlags.parkAgentSandbox
            && response?.parkagentCard.live != true
        do {
            _ = try await api.setWalletSource(source, sandbox: sandbox, consent: consent)
            Haptics.success()
            await load(api: api)
            return true
        } catch {
            actionError = error as? APIError ?? .transport(error)
            return false
        }
    }

    /// Link's OAuth: the server's authorization URL opens in the browser;
    /// the callback page bounces back to the app (parkagent://link), which
    /// reloads the Wallet. The mock connects instantly.
    func connectLink(api: any APIClient, openURL: (URL) -> Void) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let response = try await api.linkWalletConnect()
            if let url = URL(string: response.url), !LaunchOverrides.useMockAPI {
                openURL(url)
            }
            await load(api: api)
        } catch {
            actionError = error as? APIError ?? .transport(error)
        }
    }

    /// Save a card for the ParkAgent card: a SetupIntent, confirmed with
    /// Apple Pay (or the card form), then recorded server-side. Nothing is
    /// charged. True when a card was saved.
    func addCard(applePay: Bool, api: any APIClient) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        let sandbox = FeatureFlags.parkAgentSandbox && response?.parkagentCard.live != true
        do {
            let intent = try await api.walletSetupIntent(sandbox: sandbox)
            let outcome = applePay
                ? await StripeWallet.saveWithApplePay(clientSecret: intent.clientSecret, merchantId: intent.merchantId)
                : await StripeWallet.saveWithCardForm(clientSecret: intent.clientSecret, merchantId: intent.merchantId)
            switch outcome {
            case .saved:
                _ = try await api.addFundingMethod(setupIntentId: intent.setupIntentId)
                Haptics.success()
                await load(api: api)
                return true
            case .canceled:
                return false
            case .failed(let message):
                actionError = .invalidRequest(message)
                return false
            }
        } catch {
            actionError = error as? APIError ?? .transport(error)
            return false
        }
    }

    // MARK: - The ParkAgent card

    /// Face ID (or the passcode) first, then the two-hop fetch; details
    /// auto-hide after `revealDuration`.
    func reveal(api: any APIClient) async {
        guard !isRevealing, revealed == nil else { return }
        isRevealing = true
        defer { isRevealing = false }
        guard await Self.authenticateDeviceOwner(reason: "Show your full card number") else { return }
        do {
            revealed = try await api.revealCardDetails()
            scheduleHide()
        } catch {
            actionError = error as? APIError ?? .transport(error)
        }
    }

    func hideDetails() {
        hideTask?.cancel()
        hideTask = nil
        revealed = nil
    }

    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: Self.revealDuration)
            guard !Task.isCancelled else { return }
            self?.revealed = nil
        }
    }

    func setFrozen(_ frozen: Bool, api: any APIClient) async {
        guard !isTogglingFreeze else { return }
        isTogglingFreeze = true
        defer { isTogglingFreeze = false }
        do {
            let result = frozen ? try await api.freezeCard() : try await api.unfreezeCard()
            response?.parkagentCard.card?.status = result.status
            if frozen { hideDetails() }
            Haptics.light()
        } catch {
            actionError = error as? APIError ?? .transport(error)
        }
    }

    // MARK: - Link one-time cards (garage checkout)

    /// An approved Link garage payment's card, behind Face ID.
    func revealLinkCard(spendRequestId: String, api: any APIClient) async -> LinkCardDetails? {
        guard await Self.authenticateDeviceOwner(reason: "Show your Link card for checkout") else {
            return nil
        }
        do {
            return try await api.revealLinkCard(spendRequestId: spendRequestId)
        } catch {
            actionError = error as? APIError ?? .transport(error)
            return nil
        }
    }

    /// Biometrics when enrolled, else the device passcode. A cancel is a
    /// silent no.
    static func authenticateDeviceOwner(reason: String) async -> Bool {
        // UI tests can't answer a Face ID prompt. Only on the mock, whose
        // details are fixtures, and never in Release: behind this gate are
        // real card numbers, the Link one-time card among them.
        #if DEBUG
        if LaunchOverrides.uiTesting && LaunchOverrides.useMockAPI { return true }
        #endif
        let context = LAContext()
        let biometrics = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        let policy: LAPolicy = biometrics ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication
        do {
            return try await context.evaluatePolicy(policy, localizedReason: reason)
        } catch {
            return false
        }
    }
}
