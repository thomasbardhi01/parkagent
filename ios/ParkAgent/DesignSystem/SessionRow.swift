import SwiftUI

/// One line of session history: where, when, how much, current state.
struct SessionRow: View {
    let street: String
    let zoneNumber: String
    let date: String
    let amountUsd: Double
    let status: StatusPill.Status

    var body: some View {
        HStack(spacing: Spacing.unit) {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(street)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(1)
                Text("Zone \(zoneNumber) · \(date)")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: Spacing.quarter) {
                Text(Format.money(amountUsd))
                    .font(.bodyTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
                StatusPill(status: status)
            }
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
    }
}

#if DEBUG
#Preview("SessionRow") {
    VStack(spacing: Spacing.half) {
        SessionRow(
            street: "Columbus Ave near W 81st St",
            zoneNumber: "110436",
            date: "Today, 2:03 PM",
            amountUsd: 7.28,
            status: .active
        )
        SessionRow(
            street: "Amsterdam Ave near W 76th St",
            zoneNumber: "110212",
            date: "Yesterday, 9:41 AM",
            amountUsd: 12.65,
            status: .paid
        )
        SessionRow(
            street: "Broadway near W 96th St",
            zoneNumber: "110888",
            date: "Sep 17, 6:12 PM",
            amountUsd: 0,
            status: .failed
        )
    }
    .padding(Spacing.unit)
    .background(Color.appBackground)
}
#endif
