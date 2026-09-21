import SwiftUI

/// Single-spot plan: up to three option cards, one recommended, one
/// coral Confirm per card. Confirm is the ONLY thing that books or pays.
struct SingleSpotPlanCards: View {
    let plan: SingleSpotPlan
    let confirming: Bool
    let linkConnected: Bool
    let onConfirm: (SingleSpotOption) -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            ForEach(plan.options) { option in
                OptionCard(
                    option: option,
                    confirming: confirming,
                    linkConnected: linkConnected,
                    onConfirm: { onConfirm(option) }
                )
            }
            if let note = plan.note {
                Text(note)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.singleSpotPlan")
    }
}

private struct OptionCard: View {
    let option: SingleSpotOption
    let confirming: Bool
    let linkConnected: Bool
    let onConfirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack(spacing: Spacing.half) {
                Image(systemName: option.type == "garage" ? "building.2.fill" : "parkingsign")
                    .foregroundStyle(Color.textSecondary)
                Text(option.label)
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if option.recommended {
                    TagPill(label: "Recommended", color: .success)
                }
            }
            if !option.detail.isEmpty {
                Text(option.detail)
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
            }
            HStack(spacing: Spacing.unit) {
                Label(Format.money(option.priceUsd), systemImage: "dollarsign.circle")
                if let walk = option.walkMinutes {
                    Label("\(walk) min walk", systemImage: "figure.walk")
                }
                if let entry = option.entryType {
                    Label(entry.capitalized, systemImage: "arrow.right.to.line")
                }
            }
            .font(.captionText)
            .foregroundStyle(Color.textSecondary)

            if option.payOnArrival == true {
                // A future street meter: nothing to confirm now — the
                // detector pays at the curb when the car parks there.
                HStack(spacing: Spacing.half) {
                    Image(systemName: "checkmark.seal")
                        .foregroundStyle(Color.success)
                    Text("We'll pay automatically when you park here.")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                }
                .padding(.vertical, Spacing.quarter)
                .accessibilityIdentifier("assistant.autoPayNote.\(option.id)")
            } else {
                Button(confirmLabel) { onConfirm() }
                    .buttonStyle(.primary)
                    .disabled(confirming)
                    .accessibilityIdentifier("assistant.confirm.\(option.id)")
            }

            if option.type == "garage" {
                Text("Checkout finishes in SpotHero — the pass will live in your SpotHero account.")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            if linkConnected && option.priceUsd > 0 {
                HStack(spacing: Spacing.quarter) {
                    Image(systemName: "link.circle.fill")
                    Text("Paying with your Link wallet")
                }
                .font(.captionTextSemibold)
                .foregroundStyle(Color.actionCoralLink)
                .accessibilityIdentifier("assistant.linkPayBadge")
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(option.recommended ? Color.success.opacity(0.5) : .clear, lineWidth: 2)
        )
    }

    private var confirmLabel: String {
        option.type == "garage"
            ? "Confirm — open SpotHero (\(Format.money(option.priceUsd)))"
            : "Confirm \(Format.money(option.priceUsd)) for \(option.durationMinutes) min"
    }
}
