import SwiftUI

/// Small colored capsule naming a session state.
struct StatusPill: View {
    enum Status {
        case paid
        case active
        case expiring
        case failed

        var label: String {
            switch self {
            case .paid: "Paid"
            case .active: "Active"
            case .expiring: "Expiring"
            case .failed: "Failed"
            }
        }

        var color: Color {
            switch self {
            case .paid: .success
            // textSecondary, not slate: slate is fixed and unreadable on its
            // own tint over the dark surface.
            case .active: .textSecondary
            case .expiring: .warningGold
            case .failed: .danger
            }
        }
    }

    let status: Status

    var body: some View {
        TagPill(label: status.label, color: status.color)
    }
}

/// The same capsule with a free label — card transactions and the frozen
/// badge use vocabularies StatusPill's session enum doesn't cover.
struct TagPill: View {
    let label: String
    let color: Color

    var body: some View {
        Text(label)
            .font(.captionTextSemibold)
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, Spacing.quarter)
            // 0.10, not 0.14: in dark mode the tint brightens the pill enough
            // to cost the text its 4.5:1.
            .background(color.opacity(0.10))
            .clipShape(Capsule())
    }
}

#Preview("StatusPill") {
    HStack(spacing: Spacing.half) {
        StatusPill(status: .paid)
        StatusPill(status: .active)
        StatusPill(status: .expiring)
        StatusPill(status: .failed)
    }
    .padding(Spacing.unit)
    .background(Color.appBackground)
}
