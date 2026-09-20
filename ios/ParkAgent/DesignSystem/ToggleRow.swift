import SwiftUI

/// Settings-style row with a title, optional subtitle, and a coral-tinted toggle.
struct ToggleRow: View {
    let title: String
    var subtitle: String?
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(title)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                }
            }
        }
        .tint(.actionCoral)
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
    }
}

#Preview("ToggleRow") {
    struct Host: View {
        @State private var autoExtend = true
        @State private var mockAPI = false

        var body: some View {
            VStack(spacing: Spacing.half) {
                ToggleRow(
                    title: "Auto-extend",
                    subtitle: "Up to 2 times, 60 min each",
                    isOn: $autoExtend
                )
                ToggleRow(title: "Use mock API", isOn: $mockAPI)
            }
            .padding(Spacing.unit)
            .background(Color.appBackground)
        }
    }
    return Host()
}
