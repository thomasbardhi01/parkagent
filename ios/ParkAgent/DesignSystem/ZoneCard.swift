import SwiftUI

/// One meter zone: number, street, rate ladder, max stay.
/// `isSelected` is for the two-candidate confirm flow.
struct ZoneCard: View {
    let zoneNumber: String
    let street: String
    let rateFirstHourUsd: Double
    let rateAdditionalHourUsd: Double
    let maxStayMinutes: Int
    var isSelected: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack {
                Text("Zone \(zoneNumber)")
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.actionCoralLink)
                }
            }
            Text(street)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            HStack(spacing: Spacing.unit) {
                Label(rateText, systemImage: "dollarsign.circle")
                Label(maxStayText, systemImage: "clock")
            }
            .font(.captionText)
            .foregroundStyle(Color.textSecondary)
            .padding(.top, Spacing.quarter)
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(isSelected ? Color.actionCoralLink : Color.clear, lineWidth: 2)
        )
    }

    private var rateText: String {
        String(
            format: "$%.2f first hr, $%.2f after",
            rateFirstHourUsd, rateAdditionalHourUsd
        )
    }

    private var maxStayText: String {
        let hours = maxStayMinutes / 60
        let minutes = maxStayMinutes % 60
        if minutes == 0 { return "\(hours) hr max" }
        if hours == 0 { return "\(minutes) min max" }
        return "\(hours) hr \(minutes) min max"
    }
}

#Preview("ZoneCard") {
    VStack(spacing: Spacing.unit) {
        ZoneCard(
            zoneNumber: "110436",
            street: "Columbus Ave near W 81st St",
            rateFirstHourUsd: 5.00,
            rateAdditionalHourUsd: 8.25,
            maxStayMinutes: 120
        )
        ZoneCard(
            zoneNumber: "110437",
            street: "W 81st St near Columbus Ave",
            rateFirstHourUsd: 5.50,
            rateAdditionalHourUsd: 9.00,
            maxStayMinutes: 60,
            isSelected: true
        )
    }
    .padding(Spacing.unit)
    .background(Color.appBackground)
}
