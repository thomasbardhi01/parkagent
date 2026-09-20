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
            case .active: .slate
            case .expiring: .warningGold
            case .failed: .danger
            }
        }
    }

    let status: Status

    var body: some View {
        Text(status.label)
            .font(.captionTextSemibold)
            .foregroundStyle(status.color)
            .padding(.horizontal, 10)
            .padding(.vertical, Spacing.quarter)
            .background(status.color.opacity(0.14))
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
