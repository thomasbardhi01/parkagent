import SwiftUI

/// "How you pay": the active way to pay, big and plain.
///
/// - Your card on <provider>: the provider's mark and the masked card saved
///   there.
/// - Link: the Link mark, the payment method in use, the approval rule,
///   any approvals waiting, and Manage in Link.
/// - ParkAgent card: the funding card ("Visa ••4242 · Apple Pay"), then the
///   virtual card art with Show details (Face ID, 30-second auto-hide),
///   Freeze, and Add to Apple Wallet (behind its flag).
struct WalletHeroView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let response: WalletResponse
    /// "ParkBoston" — whose card "Your card on …" means.
    let provider: String

    @State private var confirmingFreeze = false

    private var wallet: WalletModel { model.wallet }

    var body: some View {
        switch response.activeSource {
        case .providerCard: providerCardHero
        case .linkWallet: linkHero
        case .parkagentCard: parkAgentHero
        }
    }

    // MARK: - Your card on <provider>

    private var providerCardHero: some View {
        let card = providerCard
        return HStack(spacing: Spacing.unit) {
            ProviderMark(name: provider)
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(WalletCopy.title(.providerCard, provider: provider))
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Text(card.map { WalletCopy.masked(brand: $0.brand, last4: $0.last4) ?? "" }
                    ?? "The card saved there pays — connect it to start.")
                    .font(card == nil ? .captionText : .secondaryText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textSecondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("wallet.hero.providerCard")
            Spacer(minLength: 0)
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    /// The card on the account whose provider the hero names.
    private var providerCard: ProviderCardSource.Card? {
        response.providerCard.cards.first { $0.displayName == provider }
            ?? response.providerCard.cards.first
    }

    // MARK: - Link

    private var linkHero: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            HStack(spacing: Spacing.unit) {
                LinkMark()
                VStack(alignment: .leading, spacing: Spacing.quarter) {
                    Text(WalletCopy.linkLine(response.link.paymentMethod))
                        .font(.bodyTextSemibold)
                        .monospacedDigit()
                        .foregroundStyle(Color.textPrimary)
                    Text(WalletCopy.linkApprovalNote)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("wallet.hero.link")
                Spacer(minLength: 0)
            }
            Text("Street meters stay on your card on \(provider).")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("wallet.hero.linkScope")
            ForEach(response.link.pendingApprovals) { approval in
                pendingApprovalRow(approval)
            }
            Button {
                if let url = URL(string: response.link.manageUrl) { openURL(url) }
            } label: {
                Label("Manage in Link", systemImage: "arrow.up.right.square")
            }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("wallet.manageInLink")
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    private func pendingApprovalRow(_ approval: LinkPendingApproval) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Approve \(Format.money(approval.amountUsd)) in Link")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textPrimary)
                Text("\(approval.merchantName ?? "Garage") · until \(Format.clockTime(approval.expiresAt))")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("wallet.pendingApproval.\(approval.spendRequestId)")
            Spacer()
            if let link = approval.approvalUrl, let url = URL(string: link) {
                Button("Approve") { openURL(url) }
                    .font(.secondaryText)
                    .foregroundStyle(Color.actionCoralLink)
            }
        }
        .padding(Spacing.half)
        .background(Color.appBackground.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
    }

    // MARK: - ParkAgent card

    private var parkAgentHero: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            HStack(spacing: Spacing.half) {
                Image(systemName: "creditcard")
                    .foregroundStyle(Color.textSecondary)
                Text(response.parkagentCard.defaultFundingMethod.map(WalletCopy.fundingLine)
                    ?? "Add a card to fund the ParkAgent card")
                    .font(.secondaryText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if !response.parkagentCard.live {
                    TagPill(label: "Sandbox", color: .textSecondary)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("wallet.hero.funding")

            if let card = wallet.parkAgentCard {
                CardArtView(card: card, revealed: wallet.revealed)
                cardActions(card)
                Text("Each parking session holds the price on your card, then takes only what the meter cost.")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            } else {
                Text("Your ParkAgent card appears here once it's set up.")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .confirmationDialog("Freeze this card?", isPresented: $confirmingFreeze, titleVisibility: .visible) {
            Button("Freeze card", role: .destructive) {
                Task { await wallet.setFrozen(true, api: model.api) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every charge is declined until you unfreeze it. Meters already paid keep running.")
        }
    }

    private func cardActions(_ card: ParkAgentCard) -> some View {
        HStack(spacing: Spacing.half) {
            CardActionButton(
                icon: wallet.revealed == nil ? "eye" : "eye.slash",
                label: wallet.revealed == nil ? "Show details" : "Hide",
                identifier: "wallet.showDetailsButton"
            ) {
                if wallet.revealed != nil {
                    wallet.hideDetails()
                } else {
                    Task { await wallet.reveal(api: model.api) }
                }
            }
            .disabled(wallet.isRevealing || card.isFrozen)
            CardActionButton(
                icon: card.isFrozen ? "snowflake.slash" : "snowflake",
                label: card.isFrozen ? "Unfreeze" : "Freeze",
                identifier: "wallet.freezeButton"
            ) {
                if card.isFrozen {
                    Task { await wallet.setFrozen(false, api: model.api) }
                } else {
                    confirmingFreeze = true
                }
            }
            .disabled(wallet.isTogglingFreeze)
            AddToWalletButton(card: card)
        }
    }
}

/// The provider's mark: its initials in a rounded tile (we don't ship the
/// operators' logos).
struct ProviderMark: View {
    let name: String

    var body: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color.ink)
            .frame(width: 44, height: 44)
            .overlay {
                Image(systemName: "parkingsign")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.9))
            }
            .accessibilityHidden(true)
    }
}

/// Link's mark: a plain link glyph in Link's green.
struct LinkMark: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color(red: 0.0, green: 0.84, blue: 0.43))
            .frame(width: 44, height: 44)
            .overlay {
                Image(systemName: "link")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Color.white)
            }
            .accessibilityHidden(true)
    }
}
