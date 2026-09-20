import SwiftUI

/// Three steps: what this is, how it decides, permissions.
struct OnboardingView: View {
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @State private var step = 0

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $step) {
                welcome.tag(0)
                howItWorks.tag(1)
                OnboardingPermissionsStep().tag(2)
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))

            Button(step < 2 ? "Continue" : "Get started") {
                if step < 2 {
                    withAnimation { step += 1 }
                } else {
                    hasOnboarded = true
                }
            }
            .buttonStyle(.primary)
            .padding(Spacing.unit)
            .accessibilityIdentifier("onboarding.continueButton")
        }
        .background(Color.appBackground)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.view")
    }

    private var welcome: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "parkingsign.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(Color.actionCoral)
            Text("Meet ParkAgent")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("Park in a metered NYC zone and ParkAgent notices, quotes the cost, and pays the meter for you.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.welcome")
    }

    private var howItWorks: some View {
        VStack(alignment: .leading, spacing: Spacing.unitAndHalf) {
            Spacer()
            Text("Calm by design")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            explainerRow(
                icon: "car.fill",
                title: "Detects the park",
                detail: "Motion, location, and car audio agree before anything happens."
            )
            explainerRow(
                icon: "dollarsign.circle.fill",
                title: "Quotes before paying",
                detail: "You see the zone, the rate, and the total. Payment stays inside your caps."
            )
            explainerRow(
                icon: "clock.fill",
                title: "Extends within limits",
                detail: "Auto-extend follows your policy and never passes the posted max stay."
            )
            Spacer()
            Spacer()
        }
        .padding(.horizontal, Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.howItWorks")
    }

    private func explainerRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.unit) {
            Image(systemName: icon)
                .font(.system(size: 22))
                .foregroundStyle(Color.textSecondary)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(title)
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Text(detail)
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
            }
        }
    }
}

private struct OnboardingPermissionsStep: View {
    @Environment(PermissionsManager.self) private var permissions

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Two permissions")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("ParkAgent works in the background, so it needs to know where you are and whether you are driving.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)

            permissionRow(
                icon: "location.fill",
                title: "Location",
                granted: permissions.locationGranted,
                denied: permissions.locationDenied,
                action: permissions.requestLocation
            )
            permissionRow(
                icon: "figure.walk.motion",
                title: "Motion activity",
                granted: permissions.motionStatus == .authorized,
                denied: permissions.motionStatus == .denied || !permissions.motionAvailable,
                deniedLabel: permissions.motionAvailable ? "Denied" : "Unavailable here",
                action: permissions.requestMotion
            )

            Text("You can grant these later in Settings; detection stays off until then.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.permissions")
    }

    private func permissionRow(
        icon: String,
        title: String,
        granted: Bool,
        denied: Bool,
        deniedLabel: String = "Denied",
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: Spacing.unit) {
            Image(systemName: icon)
                .foregroundStyle(Color.textSecondary)
                .frame(width: 28)
            Text(title)
                .font(.bodyText)
                .foregroundStyle(Color.textPrimary)
            Spacer()
            if granted {
                Label("Allowed", systemImage: "checkmark.circle.fill")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.success)
            } else if denied {
                Text(deniedLabel)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
            } else {
                Button("Allow", action: action)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.actionCoralLink)
            }
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
    }
}

#Preview {
    OnboardingView()
        .environment(PermissionsManager())
}
