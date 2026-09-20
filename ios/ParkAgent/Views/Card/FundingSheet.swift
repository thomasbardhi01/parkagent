import SwiftUI

/// Add money / Withdraw. Amount field with quick amounts, the resulting
/// balance, and a confirm; a banner makes dry run explicit (nothing moves),
/// and an unready financial account replaces the form entirely.
struct FundingSheet: View {
    let direction: FundingDirection
    @Environment(AppModel.self) private var model
    @Environment(CardModel.self) private var card
    @Environment(\.dismiss) private var dismiss

    @State private var amountText = ""
    @State private var isSubmitting = false

    private static let quickAmounts: [Double] = [10, 20, 50]

    var body: some View {
        NavigationStack {
            Group {
                if card.funding?.available == true {
                    form
                } else {
                    EmptyStateView(
                        icon: "building.columns",
                        title: "Funding isn't ready yet",
                        message: "The card's financial account is still being set up. Balance and transfers appear here once it's ready."
                    )
                    .accessibilityIdentifier("funding.notReady")
                }
            }
            .background(Color.appBackground)
            .navigationTitle(direction.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("funding.cancelButton")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("funding.view")
    }

    private var form: some View {
        VStack(spacing: Spacing.unit) {
            if card.isDryRun {
                dryRunBanner
            }

            VStack(spacing: Spacing.half) {
                TextField("$0", text: $amountText)
                    .keyboardType(.decimalPad)
                    .font(.numeral)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.textPrimary)
                    .accessibilityIdentifier("funding.amountField")
                HStack(spacing: Spacing.half) {
                    ForEach(Self.quickAmounts, id: \.self) { amount in
                        Button("$\(Int(amount))") { amountText = String(Int(amount)) }
                            .font(.captionTextSemibold)
                            .foregroundStyle(Color.textPrimary)
                            .padding(.horizontal, Spacing.unit)
                            .padding(.vertical, Spacing.half)
                            .background(Color.mist.opacity(0.5), in: Capsule())
                            .accessibilityIdentifier("funding.quick.\(Int(amount))")
                    }
                }
            }
            .padding(.vertical, Spacing.unitAndHalf)
            .frame(maxWidth: .infinity)
            .cardStyle()

            VStack(spacing: 0) {
                balanceRow("Balance", value: card.funding?.balanceUsd ?? 0)
                if let pending = card.funding?.pendingUsd, pending > 0 {
                    Divider()
                    balanceRow("Pending", value: pending)
                }
                Divider()
                HStack {
                    Text("After \(direction == .topup ? "adding" : "withdrawing")")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                    Spacer()
                    Text(Format.money(resultingBalance))
                        .font(.bodyTextSemibold)
                        .foregroundStyle(Color.textPrimary)
                        .accessibilityIdentifier("funding.resultingBalance")
                }
                .padding(Spacing.unit)
            }
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))

            Spacer()

            Button(confirmLabel) {
                Task { await submit() }
            }
            .buttonStyle(.primary)
            .disabled(!isValid || isSubmitting)
            .accessibilityIdentifier("funding.confirmButton")
        }
        .padding(Spacing.unit)
    }

    private var dryRunBanner: some View {
        HStack(spacing: Spacing.half) {
            Image(systemName: "testtube.2")
                .foregroundStyle(Color.warningGold)
            Text("Dry run is on — no real money moves.")
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Spacer()
        }
        .padding(Spacing.unit)
        .background(Color.warningGold.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityIdentifier("funding.dryRunBanner")
    }

    private func balanceRow(_ label: String, value: Double) -> some View {
        HStack {
            Text(label)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            Text(Format.money(value))
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
        }
        .padding(Spacing.unit)
    }

    private var amount: Double? {
        Double(amountText.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "."))
    }

    private var isValid: Bool {
        guard let amount, amount > 0 else { return false }
        if direction == .withdraw, let balance = card.funding?.balanceUsd, amount > balance {
            return false
        }
        return true
    }

    private var resultingBalance: Double {
        let balance = card.funding?.balanceUsd ?? 0
        guard let amount, amount > 0 else { return balance }
        return direction == .topup ? balance + amount : max(0, balance - amount)
    }

    private var confirmLabel: String {
        guard let amount, amount > 0 else { return direction.title }
        return "\(direction.title): \(Format.money(amount))"
    }

    private func submit() async {
        guard let amount else { return }
        isSubmitting = true
        let ok = await card.move(direction, amountUsd: amount, api: model.api)
        isSubmitting = false
        if ok { dismiss() }
    }
}

#Preview {
    FundingSheet(direction: .topup)
        .environment(AppModel())
        .environment(CardModel())
}
