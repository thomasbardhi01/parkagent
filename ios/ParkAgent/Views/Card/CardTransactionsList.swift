import SwiftUI

/// The ledger below the card, grouped by day. Rows show merchant, amount,
/// and a status pill; the detail carries the decline reason and the linked
/// parking session when the server found one.
struct CardTransactionsList: View {
    let transactions: [CardTransaction]
    let hasMore: Bool
    let onLoadMore: () -> Void

    private var days: [(day: Date, items: [CardTransaction])] {
        Dictionary(grouping: transactions) { Calendar.current.startOfDay(for: $0.createdAt) }
            .sorted { $0.key > $1.key }
            .map { (day: $0.key, items: $0.value.sorted { $0.createdAt > $1.createdAt }) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Text("Activity")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)

            if transactions.isEmpty {
                VStack(spacing: Spacing.half) {
                    Image(systemName: "list.bullet.rectangle")
                        .font(.system(size: 32))
                        .foregroundStyle(Color.steel)
                    Text("No transactions yet")
                        .font(.bodyTextSemibold)
                        .foregroundStyle(Color.textPrimary)
                    Text("Charges on the card show up here as they happen.")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(Spacing.unitAndHalf)
                .frame(maxWidth: .infinity)
                .cardStyle()
                .accessibilityIdentifier("card.transactionsEmpty")
            } else {
                ForEach(days, id: \.day) { group in
                    Text(Format.dayHeader(group.day))
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.textSecondary)
                        .padding(.top, Spacing.quarter)
                    VStack(spacing: 0) {
                        ForEach(group.items) { transaction in
                            NavigationLink(value: transaction) {
                                CardTransactionRow(transaction: transaction)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("card.txnRow.\(transaction.id)")
                            if transaction.id != group.items.last?.id {
                                Divider().padding(.leading, Spacing.unit)
                            }
                        }
                    }
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }
                if hasMore {
                    Button("Load more", action: onLoadMore)
                        .buttonStyle(.secondary)
                        .accessibilityIdentifier("card.loadMoreButton")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("card.transactions")
    }
}

struct CardTransactionRow: View {
    let transaction: CardTransaction

    var body: some View {
        HStack(spacing: Spacing.half) {
            VStack(alignment: .leading, spacing: 2) {
                Text(transaction.merchantName ?? "Unknown merchant")
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(1)
                Text(Format.clockTime(transaction.createdAt))
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            Text(Format.money(transaction.capturedUsd ?? transaction.amountUsd))
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(transaction.approved ? Color.textPrimary : Color.textSecondary)
            transaction.pill
        }
        .padding(Spacing.unit)
        .contentShape(Rectangle())
    }
}

extension CardTransaction {
    /// Approved settles to green, a pending hold stays neutral, declines go
    /// red — the reason itself lives on the detail screen.
    var pill: TagPill {
        if !approved {
            return TagPill(label: "Declined", color: .danger)
        }
        if status == "pending" {
            return TagPill(label: "Pending", color: .textSecondary)
        }
        return TagPill(label: "Approved", color: .success)
    }

    /// Human wording for the webhook's decline reasons (see API.md).
    var declineReason: String? {
        guard !approved else { return nil }
        switch decision {
        case "declined_unknown_card": return "Card not recognized"
        case "declined_wrong_mcc": return "Not a parking merchant"
        case "declined_no_pending_session": return "No parking session in progress"
        case "declined_over_daily_cap": return "Daily cap reached"
        case "declined_dry_run": return "Dry run — nothing charged"
        case "external": return "Declined by Stripe"
        default: return decision.replacingOccurrences(of: "_", with: " ")
        }
    }
}

struct CardTransactionDetailView: View {
    let transaction: CardTransaction
    @Environment(AppModel.self) private var model

    private var linkedSession: SessionRecord? {
        guard let sessionId = transaction.sessionId else { return nil }
        return model.history.first { $0.id == sessionId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                VStack(alignment: .leading, spacing: Spacing.half) {
                    HStack {
                        Text(transaction.merchantName ?? "Unknown merchant")
                            .font(.bodyTextSemibold)
                            .foregroundStyle(Color.textPrimary)
                        Spacer()
                        transaction.pill
                    }
                    Text(Format.money(transaction.capturedUsd ?? transaction.amountUsd))
                        .font(.numeral)
                        .foregroundStyle(Color.textPrimary)
                    if let reason = transaction.declineReason {
                        Text(reason)
                            .font(.secondaryText)
                            .foregroundStyle(Color.danger)
                            .accessibilityIdentifier("txnDetail.declineReason")
                    }
                }
                .padding(Spacing.unit)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardStyle()

                VStack(spacing: 0) {
                    detailRow("When", Format.dayAndTime(transaction.createdAt))
                    Divider()
                    detailRow("Hold", Format.money(transaction.amountUsd))
                    if let captured = transaction.capturedUsd {
                        Divider()
                        detailRow("Settled", Format.money(captured))
                    }
                    Divider()
                    detailRow("Status", transaction.status.capitalized)
                    Divider()
                    detailRow("Authorization", transaction.stripeAuthorizationId)
                }
                .background(Color.surface)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))

                if let record = linkedSession {
                    NavigationLink(value: record) {
                        HStack {
                            Image(systemName: "parkingsign.circle")
                                .foregroundStyle(Color.textSecondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Parking session")
                                    .font(.captionText)
                                    .foregroundStyle(Color.textSecondary)
                                Text(record.zoneLabel)
                                    .font(.bodyText)
                                    .foregroundStyle(Color.textPrimary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.captionText)
                                .foregroundStyle(Color.textSecondary)
                        }
                        .padding(Spacing.unit)
                        .background(Color.surface)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("txnDetail.sessionLink")
                } else if let sessionId = transaction.sessionId {
                    detailRow("Session", sessionId)
                        .background(Color.surface)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }
            }
            .padding(Spacing.unit)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("txnDetail.view")
        }
        .background(Color.appBackground)
        .navigationTitle("Transaction")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            Text(value)
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(Spacing.unit)
    }
}
