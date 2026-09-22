import SwiftUI

/// Container chrome for content presented over the map: grabber, surface
/// background, rounded top corners. Content decides its own height.
struct BottomSheet<Content: View>: View {
    /// Layer the living wash into the sheet surface (Home). Kept faint here
    /// so it reads as depth under the content, never competing with it.
    var livingBackdrop = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Color.separator)
                .frame(width: 36, height: 5)
                .padding(.top, Spacing.half)
                .padding(.bottom, Spacing.unit)
            content
                .padding(.horizontal, Spacing.unit)
                .padding(.bottom, Spacing.unitAndHalf)
        }
        .frame(maxWidth: .infinity)
        .background {
            if livingBackdrop {
                Color.surface.overlay(LivingBackground(strength: 0.55, drawsBase: false))
            } else {
                Color.surface
            }
        }
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: Radius.card,
                topTrailingRadius: Radius.card,
                style: .continuous
            )
        )
        .shadow(color: .black.opacity(0.12), radius: 16, y: -2)
    }
}

#Preview("BottomSheet") {
    ZStack(alignment: .bottom) {
        Color.sky.opacity(0.4)
            .ignoresSafeArea()
        BottomSheet {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                Text("Parked in Zone 110436")
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Text("$7.28")
                    .font(.numeral)
                    .foregroundStyle(Color.textPrimary)
                Button("Pay $7.28 for 90 min") {}
                    .buttonStyle(.primary)
                Button("Not parked here") {}
                    .buttonStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
