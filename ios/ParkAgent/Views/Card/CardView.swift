import SwiftUI

/// The Card tab: the Stripe-issued virtual card that pays ParkNYC meters.
/// Hero art, spend meter against the policy caps, funding and freeze
/// actions, and the transaction ledger. Coral is spent on Add money — the
/// screen's one primary action.
struct CardView: View {
    @Environment(AppModel.self) private var model
    @State private var card = CardModel()
    @State private var fundingDirection: FundingDirection?
    @State private var showingAddMoney = false
    @State private var confirmingFreeze = false

    var body: some View {
        NavigationStack {
            Group {
                if let summary = card.card {
                    content(summary)
                } else if card.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if card.loadFailed {
                    EmptyStateView(
                        icon: "wifi.exclamationmark",
                        title: "Couldn't load your card",
                        message: "Check the connection and pull to retry."
                    )
                    .accessibilityIdentifier("card.loadFailed")
                } else {
                    EmptyStateView(
                        icon: "creditcard",
                        title: "Set up your parking card",
                        message: "No virtual card yet. Run the issuing setup for this account and it appears here, with its details never stored on this phone."
                    )
                    .accessibilityIdentifier("card.emptyNoCard")
                }
            }
            .background(Color.appBackground)
            .navigationTitle("Card")
            .navigationDestination(for: CardTransaction.self) { transaction in
                CardTransactionDetailView(transaction: transaction)
            }
            .navigationDestination(for: SessionRecord.self) { record in
                SessionDetailView(record: record)
            }
            .refreshable { await card.load(api: model.api) }
        }
        .environment(card)
        .task { await card.load(api: model.api) }
        .sheet(item: $fundingDirection) { direction in
            FundingSheet(direction: direction)
                .environment(card)
                .presentationDetents([.medium, .large])
        }
        // Same Apple Pay sheet as onboarding's add-money step.
        .sheet(isPresented: $showingAddMoney) {
            AddMoneySheet {
                Task { await card.load(api: model.api) }
            }
            .presentationDetents([.medium, .large])
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { card.actionError != nil },
                set: { if !$0 { card.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(card.actionError?.errorDescription ?? "")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("card.view")
    }

    private func content(_ summary: CardSummary) -> some View {
        ScrollView {
            VStack(spacing: Spacing.unit) {
                CardArtView(card: summary, revealed: card.revealed)

                showDetailsButton

                spendMeter(summary)

                actionRow(summary)

                CardTransactionsList(
                    transactions: card.transactions,
                    hasMore: card.nextCursor != nil,
                    onLoadMore: {
                        Task { await card.loadTransactions(api: model.api, reset: false) }
                    }
                )
            }
            .padding(Spacing.unit)
        }
    }

    // MARK: - Reveal

    private var showDetailsButton: some View {
        Button {
            if card.revealed != nil {
                card.hideDetails()
            } else {
                Task { await card.reveal(api: model.api) }
            }
        } label: {
            HStack(spacing: Spacing.half) {
                if card.isRevealing {
                    ProgressView().controlSize(.small)
                }
                Image(systemName: card.revealed == nil ? "eye" : "eye.slash")
                Text(card.revealed == nil ? "Show details" : "Hide details")
            }
        }
        .buttonStyle(.secondary)
        .disabled(card.isRevealing || card.isFrozen)
        .accessibilityIdentifier("card.showDetailsButton")
    }

    // MARK: - Spend meter

    private func spendMeter(_ summary: CardSummary) -> some View {
        let dailyCap = summary.spendingControls.dailyUsd
        let share = dailyCap > 0 ? summary.spentTodayUsd / dailyCap : 0
        return VStack(alignment: .leading, spacing: Spacing.half) {
            HStack {
                Text("Today")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
                Spacer()
                Text("\(Format.money(summary.spentTodayUsd)) of \(Format.money(dailyCap))")
                    .font(.captionTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
            }
            ProgressBar(value: share, tint: share >= 1 ? .danger : share > 0.8 ? .warningGold : .actionCoral)
            HStack {
                Text("This month")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                Spacer()
                Text(Format.money(summary.spentThisMonthUsd))
                    .font(.captionTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
            }
            Divider()
            HStack {
                Text("Balance")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                Spacer()
                if let funding = card.funding, funding.available {
                    Text(balanceText(funding))
                        .font(.captionTextSemibold)
                        .monospacedDigit()
                        .foregroundStyle(Color.textPrimary)
                        .accessibilityIdentifier("card.balance")
                } else {
                    Text("Not ready yet")
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.textSecondary)
                        .accessibilityIdentifier("card.balanceNotReady")
                }
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity)
        .cardStyle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("card.spendMeter")
    }

    private func balanceText(_ funding: CardFunding) -> String {
        let balance = Format.money(funding.balanceUsd ?? 0)
        if let pending = funding.pendingUsd, pending > 0 {
            return "\(balance) + \(Format.money(pending)) pending"
        }
        return balance
    }

    // MARK: - Actions

    private func actionRow(_ summary: CardSummary) -> some View {
        HStack(spacing: Spacing.half) {
            CardActionButton(
                icon: "plus.circle.fill",
                label: "Add money",
                tint: .actionCoralLink,
                identifier: "card.addMoneyButton"
            ) {
                showingAddMoney = true
            }
            CardActionButton(
                icon: "arrow.down.circle",
                label: "Withdraw",
                identifier: "card.withdrawButton"
            ) {
                fundingDirection = .withdraw
            }
            CardActionButton(
                icon: card.isFrozen ? "snowflake.slash" : "snowflake",
                label: card.isFrozen ? "Unfreeze" : "Freeze",
                identifier: "card.freezeButton"
            ) {
                if card.isFrozen {
                    Task { await card.setFrozen(false, api: model.api) }
                } else {
                    confirmingFreeze = true
                }
            }
            AddToWalletButton(card: summary)
        }
        .confirmationDialog(
            "Freeze this card?",
            isPresented: $confirmingFreeze,
            titleVisibility: .visible
        ) {
            Button("Freeze card", role: .destructive) {
                Task { await card.setFrozen(true, api: model.api) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every charge is declined until you unfreeze it. Meters already paid keep running.")
        }
    }
}

/// One tile in the row of card actions: icon over a short label.
struct CardActionButton: View {
    let icon: String
    let label: String
    var tint: Color = .textPrimary
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Spacing.half) {
                Image(systemName: icon)
                    .font(.system(size: 22))
                Text(label)
                    .font(.captionTextSemibold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

extension FundingDirection: Identifiable {
    var id: String { title }
}

#Preview {
    CardView()
        .environment(AppModel())
}
