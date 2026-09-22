import Foundation
import LocalAuthentication
import Observation

/// State for the Card tab. Owned by CardView; every method takes the
/// APIClient from AppModel so the mock/live switch keeps working.
@MainActor
@Observable
final class CardModel {
    private(set) var response: CardResponse?
    private(set) var loadFailed = false
    private(set) var isLoading = false

    private(set) var transactions: [CardTransaction] = []
    private(set) var nextCursor: String?
    private(set) var isLoadingTransactions = false

    /// Non-nil while the number and CVC are on screen; auto-cleared.
    private(set) var revealed: RevealedCardDetails?
    private(set) var isRevealing = false

    /// Freeze/funding/reveal failures, surfaced as an alert.
    var actionError: APIError?
    /// True while a freeze/unfreeze round-trip is in flight.
    private(set) var isTogglingFreeze = false

    private var hideTask: Task<Void, Never>?

    /// How long revealed details stay on screen.
    static let revealDuration: Duration = .seconds(30)

    var card: CardSummary? { response?.card }
    var funding: CardFunding? { response?.funding }
    var isDryRun: Bool { response?.dryRun ?? true }
    var isFrozen: Bool { card?.isFrozen ?? false }

    // MARK: - Loading

    func load(api: any APIClient) async {
        isLoading = response == nil
        loadFailed = false
        do {
            response = try await api.card()
        } catch {
            loadFailed = response == nil
        }
        isLoading = false
        if card != nil {
            await loadTransactions(api: api, reset: true)
        }
    }

    func loadTransactions(api: any APIClient, reset: Bool) async {
        guard !isLoadingTransactions else { return }
        if !reset && nextCursor == nil { return }
        isLoadingTransactions = true
        do {
            let page = try await api.cardTransactions(cursor: reset ? nil : nextCursor)
            transactions = reset ? page.items : transactions + page.items
            nextCursor = page.nextCursor
        } catch {
            // Leave whatever page we had; the list shows its own empty state.
        }
        isLoadingTransactions = false
    }

    // MARK: - Reveal

    /// Face ID (or device passcode fallback) first, then the two-hop fetch;
    /// details auto-hide after `revealDuration`.
    func reveal(api: any APIClient) async {
        guard !isRevealing, revealed == nil else { return }
        isRevealing = true
        defer { isRevealing = false }
        guard await authenticateDeviceOwner() else { return }
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

    /// Biometrics when enrolled, else the device passcode. A cancel is a
    /// silent no — only a real failure would surface an error, and LA
    /// treats those the same way, so this just answers yes/no.
    private func authenticateDeviceOwner() async -> Bool {
        // UI tests can't answer a Face ID prompt; the mock serves fixture
        // details, so nothing sensitive is behind this bypass.
        if LaunchOverrides.uiTesting { return true }
        let context = LAContext()
        let biometrics = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        let policy: LAPolicy = biometrics ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication
        do {
            return try await context.evaluatePolicy(policy, localizedReason: "Show your full card number")
        } catch {
            return false
        }
    }

    // MARK: - Freeze

    func setFrozen(_ frozen: Bool, api: any APIClient) async {
        guard !isTogglingFreeze else { return }
        isTogglingFreeze = true
        do {
            let result: CardStatusResponse
            if frozen {
                result = try await api.freezeCard()
            } else {
                result = try await api.unfreezeCard()
            }
            response?.card?.status = result.status
            if frozen { hideDetails() }
        } catch {
            actionError = error as? APIError ?? .transport(error)
        }
        isTogglingFreeze = false
    }

    // MARK: - Funding

    /// Runs the move and refreshes the balance; false means it failed and
    /// `actionError` says why (the sheet stays up so the user can adjust).
    func move(_ direction: FundingDirection, amountUsd: Double, api: any APIClient) async -> Bool {
        Haptics.light()
        do {
            let result: CardFundingResponse
            if direction == .topup {
                result = try await api.cardTopup(amountUsd: amountUsd)
            } else {
                result = try await api.cardWithdraw(amountUsd: amountUsd)
            }
            response?.funding = CardFunding(
                available: true,
                balanceUsd: result.balanceUsd,
                pendingUsd: result.pendingUsd
            )
            return true
        } catch {
            actionError = error as? APIError ?? .transport(error)
            return false
        }
    }
}

enum FundingDirection {
    case topup
    case withdraw

    var title: String {
        switch self {
        case .topup: "Add money"
        case .withdraw: "Withdraw"
        }
    }
}
