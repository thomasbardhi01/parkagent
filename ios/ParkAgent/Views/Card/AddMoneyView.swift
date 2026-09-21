import PassKit
import SwiftUI

/// Apple Pay top-up of the card's funding balance — the primary way money
/// gets in. Onboarding step 6 embeds it; the Card tab presents it as a
/// sheet. Quick amounts, the Apple Pay button, and a card-form fallback;
/// in dry run the banner is explicit and the flow completes without the
/// Stripe SDK ever being touched.
struct AddMoneyView: View {
    @Environment(AppModel.self) private var model
    /// Onboarding shows a Skip; the sheet gets a Cancel from its host.
    var allowSkip = false
    /// Called when the user is done here (paid, dry-run "paid", or skipped).
    var onFinished: () -> Void

    @State private var amountText = "20"
    @State private var isSubmitting = false
    @State private var outcomeNotice: String?
    @State private var errorText: String?

    private static let quickAmounts: [Int] = [20, 50, 100]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if isDryRun {
                dryRunBanner
            }

            Text("Money on the card pays the meters. Add some now, or later from the Card tab.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)

            amountEntry

            if let errorText {
                Text(errorText)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.danger)
                    .accessibilityIdentifier("addMoney.error")
            }

            Spacer(minLength: 0)

            if let outcomeNotice {
                completed(outcomeNotice)
            } else {
                actions
            }
        }
        .padding(Spacing.unit)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("addMoney.view")
    }

    private var isDryRun: Bool {
        // Until the policy loads, assume dry run — the safe reading.
        model.policyResponse?.dryRun ?? true
    }

    private var amount: Double? {
        Double(amountText.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "."))
    }

    private var isValid: Bool {
        (amount ?? 0) > 0
    }

    // MARK: - Pieces

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
        .accessibilityIdentifier("addMoney.dryRunBanner")
    }

    private var amountEntry: some View {
        VStack(spacing: Spacing.half) {
            TextField("$0", text: $amountText)
                .keyboardType(.decimalPad)
                .font(.numeral)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.textPrimary)
                .accessibilityIdentifier("addMoney.amountField")
            HStack(spacing: Spacing.half) {
                ForEach(Self.quickAmounts, id: \.self) { quick in
                    Button("$\(quick)") { amountText = String(quick) }
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.textPrimary)
                        .padding(.horizontal, Spacing.unit)
                        .padding(.vertical, Spacing.half)
                        .background(Color.mist.opacity(0.5), in: Capsule())
                        .accessibilityIdentifier("addMoney.quick.\(quick)")
                }
            }
        }
        .padding(.vertical, Spacing.unitAndHalf)
        .frame(maxWidth: .infinity)
        .cardStyle()
    }

    @ViewBuilder
    private var actions: some View {
        ApplePayButton {
            Task { await submit(applePay: true) }
        }
        .frame(height: 48)
        .disabled(!isValid || isSubmitting)
        .opacity(isValid && !isSubmitting ? 1 : 0.5)
        .accessibilityIdentifier("addMoney.applePayButton")

        Button("Use a card instead") {
            Task { await submit(applePay: false) }
        }
        .buttonStyle(.secondary)
        .disabled(!isValid || isSubmitting)
        .accessibilityIdentifier("addMoney.cardButton")

        if allowSkip {
            Button("Skip for now") { onFinished() }
                .buttonStyle(.secondary)
                .disabled(isSubmitting)
                .accessibilityIdentifier("addMoney.skipButton")
        }
    }

    private func completed(_ notice: String) -> some View {
        VStack(spacing: Spacing.unit) {
            Label {
                // Identifier on the text: on the Label it propagates to the
                // icon too, and tests would match the image first.
                Text(notice)
                    .accessibilityIdentifier("addMoney.doneNotice")
            } icon: {
                Image(systemName: "checkmark.circle.fill")
            }
            .font(.bodyTextSemibold)
            .foregroundStyle(Color.success)
            Button("Done") { onFinished() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("addMoney.doneButton")
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Submit

    private func submit(applePay: Bool) async {
        guard let amount else { return }
        isSubmitting = true
        errorText = nil
        defer { isSubmitting = false }

        let intent: TopupIntentResponse
        do {
            intent = try await model.api.topupIntent(amountUsd: amount)
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? "Could not reach the server."
            return
        }

        // Dry run: no PaymentIntent exists and nothing can ever charge —
        // the flow completes without presenting any payment UI.
        if intent.dryRun {
            outcomeNotice = "Dry run — nothing was charged."
            return
        }

        let outcome = applePay
            ? await StripeTopup.presentApplePay(clientSecret: intent.clientSecret, amountUsd: amount)
            : await StripeTopup.presentCardForm(clientSecret: intent.clientSecret)
        switch outcome {
        case .paid:
            outcomeNotice = "\(Format.money(amount)) is on its way to your card."
        case .canceled:
            break
        case .failed(let message):
            errorText = message
        }
    }
}

/// PKPaymentButton, since SwiftUI has no native Apple Pay button.
private struct ApplePayButton: UIViewRepresentable {
    let action: () -> Void

    func makeUIView(context: Context) -> PKPaymentButton {
        let button = PKPaymentButton(paymentButtonType: .addMoney, paymentButtonStyle: .automatic)
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped), for: .touchUpInside)
        return button
    }

    func updateUIView(_ button: PKPaymentButton, context: Context) {
        context.coordinator.action = action
        // .disabled() only sets the SwiftUI environment; the UIKit button
        // has to be told.
        button.isEnabled = context.environment.isEnabled
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    @MainActor
    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func tapped() {
            action()
        }
    }
}

/// The Card tab's sheet wrapper; refreshes the card when the flow ends.
struct AddMoneySheet: View {
    @Environment(\.dismiss) private var dismiss
    var onFinished: () -> Void = {}

    var body: some View {
        NavigationStack {
            AddMoneyView {
                onFinished()
                dismiss()
            }
            .background(Color.appBackground)
            .navigationTitle("Add money")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("addMoney.cancelButton")
                }
            }
        }
    }
}

#Preview {
    AddMoneySheet()
        .environment(AppModel())
}
