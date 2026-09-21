import SwiftUI

/// Neutral empty state for lists and finished flows.
struct EmptyStateView: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Image(systemName: icon)
                .font(.system(size: 44))
                .foregroundStyle(Color.steel)
            Text(title)
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text(message)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(Spacing.double)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appBackground)
    }
}

/// Shown on Home when location permission is missing — without it the whole
/// detect-and-pay loop is off.
struct PermissionBanner: View {
    var icon = "location.slash.fill"
    var title = "Location is off"
    var message = "ParkAgent cannot detect parking without it."

    var body: some View {
        HStack(spacing: Spacing.half) {
            Image(systemName: icon)
                .foregroundStyle(Color.warningGold)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Text(message)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .font(.captionTextSemibold)
            .foregroundStyle(Color.actionCoralLink)
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .shadow(color: .black.opacity(0.1), radius: 4, y: 1)
    }
}

#Preview("Empty state") {
    EmptyStateView(
        icon: "clock.arrow.circlepath",
        title: "No sessions yet",
        message: "Once ParkAgent pays a meter, the session shows up here."
    )
}

#Preview("Permission banner") {
    PermissionBanner()
        .padding(Spacing.unit)
        .background(Color.appBackground)
}
