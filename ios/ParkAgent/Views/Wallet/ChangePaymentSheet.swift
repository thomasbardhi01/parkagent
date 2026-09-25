import SwiftUI

/// Choosing a way to pay, from the Wallet. Walks through whatever the
/// choice needs first — connect Link, save a card (Apple Pay first, then
/// card entry), agree to the ParkAgent card replacing the card saved on the
/// parking accounts — and ends on one coral Confirm.
struct ChangePaymentSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let source: PaymentSource

    @State private var consented = false

    private var wallet: WalletModel { model.wallet }
    private var response: WalletResponse? { wallet.response }

    var body: some View {
        NavigationStack {
            // The walk-through scrolls (a medium sheet can't always fit the
            // consent); the one confirm stays pinned beneath it.
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.unit) {
                    Text(WalletCopy.title(source, provider: provider))
                        .font(.numeral)
                        .foregroundStyle(Color.textPrimary)
                        .minimumScaleFactor(0.6)
                        .lineLimit(2)
                    Text(WalletCopy.explanation(source, provider: provider))
                        .font(.bodyText)
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("changePayment.explanation")

                    if source == .linkWallet {
                        Text(WalletCopy.linkApprovalNote)
                            .font(.secondaryText)
                            .foregroundStyle(Color.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("changePayment.linkApprovalNote")
                    }

                    requirement

                    if let error = wallet.actionError {
                        Text(error.errorDescription ?? "")
                            .font(.captionTextSemibold)
                            .foregroundStyle(Color.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("changePayment.error")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.unitAndHalf)
            }
            .background(Color.appBackground)
            .safeAreaInset(edge: .bottom) {
                Button(wallet.isWorking ? "Working…" : confirmTitle) {
                    Task { await confirm() }
                }
                .buttonStyle(.primary)
                .disabled(!ready || wallet.isWorking)
                .accessibilityIdentifier("changePayment.confirmButton")
                .padding(.horizontal, Spacing.unitAndHalf)
                .padding(.vertical, Spacing.unit)
                .background(Color.appBackground)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("changePayment.cancelButton")
                }
            }
        }
        .onAppear { wallet.actionError = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("changePayment.view")
    }

    // MARK: - What the choice needs first

    @ViewBuilder
    private var requirement: some View {
        switch source {
        case .providerCard:
            EmptyView()
        case .linkWallet:
            if response?.link.connected != true {
                Button {
                    Task { await wallet.connectLink(api: model.api) { openURL($0) } }
                } label: {
                    Label("Connect Link", systemImage: "link")
                }
                .buttonStyle(.secondary)
                .disabled(wallet.isWorking)
                .accessibilityIdentifier("changePayment.connectLinkButton")
            } else {
                stepDone(WalletCopy.linkLine(response?.link.paymentMethod), identifier: "changePayment.linkConnected")
            }
        case .parkagentCard:
            if let method = response?.parkagentCard.defaultFundingMethod {
                stepDone(WalletCopy.fundingLine(method), identifier: "changePayment.cardSaved")
            } else {
                VStack(spacing: Spacing.half) {
                    Text("First, the card we hold each session's price on. Nothing is charged now.")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if StripeWallet.applePayAvailable || LaunchOverrides.useMockAPI {
                        Button {
                            Task { _ = await wallet.addCard(applePay: true, api: model.api) }
                        } label: {
                            Label("Add with Apple Pay", systemImage: "apple.logo")
                        }
                        .buttonStyle(.secondary)
                        .accessibilityIdentifier("changePayment.applePayButton")
                    }
                    Button("Enter a card") {
                        Task { _ = await wallet.addCard(applePay: false, api: model.api) }
                    }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("changePayment.enterCardButton")
                }
                .disabled(wallet.isWorking)
            }
            if needsConsent {
                consentRow
            }
        }
    }

    private func stepDone(_ text: String, identifier: String) -> some View {
        HStack(spacing: Spacing.half) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.success)
            Text(text)
                .font(.secondaryText)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    private var consentRow: some View {
        Button {
            consented.toggle()
        } label: {
            HStack(alignment: .top, spacing: Spacing.half) {
                Image(systemName: consented ? "checkmark.square.fill" : "square")
                    .foregroundStyle(consented ? Color.actionCoralLink : Color.textSecondary)
                Text(WalletCopy.parkAgentConsent(providers: linkedProviderNames))
                    .font(.captionText)
                    .foregroundStyle(Color.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("changePayment.consentToggle")
        .accessibilityValue(consented ? "checked" : "unchecked")
    }

    // MARK: - Confirm

    private var confirmTitle: String {
        "Pay with \(WalletCopy.title(source, provider: provider))"
    }

    private var ready: Bool {
        switch source {
        case .providerCard: true
        case .linkWallet: response?.link.connected == true
        case .parkagentCard:
            response?.parkagentCard.defaultFundingMethod != nil && (!needsConsent || consented)
        }
    }

    private func confirm() async {
        if await wallet.choose(source, consent: consented, api: model.api) {
            dismiss()
        }
    }

    // MARK: - Helpers

    /// Linked accounts that don't carry the ParkAgent card yet — switching
    /// puts it on them, which replaces the card saved there.
    private var needsConsent: Bool {
        source == .parkagentCard && !linkedProviderNames.isEmpty
    }

    private var linkedProviderNames: [String] {
        (response?.providers ?? [])
            .filter { $0.isLinked && $0.paysWith?.source != .parkagentCard }
            .map(\.displayName)
    }

    private var provider: String {
        let city = model.effectiveCity
        return response?.providers.first(where: { $0.city == city })?.displayName
            ?? response?.providers.first(where: \.isLinked)?.displayName
            ?? CityCatalog.providerDisplayName(for: city)
            ?? "your parking account"
    }
}
