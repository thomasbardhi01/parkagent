import SwiftUI

/// Placeholder for the Stripe-issued virtual card that funds ParkNYC
/// top-ups in a later phase. Deliberately shows no numbers — the app never
/// holds card data.
struct CardView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: Spacing.unitAndHalf) {
                cardArt
                VStack(spacing: Spacing.half) {
                    Text("No card yet")
                        .font(.bodyTextSemibold)
                        .foregroundStyle(Color.textPrimary)
                    Text("A virtual card arrives in a later phase. It will fund ParkNYC top-ups within your spending caps, and its details never live on this phone.")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
            .padding(Spacing.unit)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.appBackground)
            .navigationTitle("Card")
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("card.view")
        }
    }

    // Text opacities stay ≥0.85: the slate end of the gradient is light
    // enough that dimmer white drops under 4.5:1.
    private var cardArt: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("ParkAgent")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.white.opacity(0.9))
                Spacer()
                Image(systemName: "wave.3.right")
                    .foregroundStyle(Color.white.opacity(0.75))
            }
            Spacer()
            Text("••••  ••••  ••••  ••••")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.white.opacity(0.85))
            Spacer()
            HStack {
                Text("Virtual card")
                    .font(.captionText)
                    .foregroundStyle(Color.white.opacity(0.85))
                Spacer()
                Text("Coming soon")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.white.opacity(0.85))
            }
        }
        .padding(Spacing.unitAndHalf)
        .frame(maxWidth: .infinity)
        .aspectRatio(1.586, contentMode: .fit)
        .background(
            LinearGradient(
                colors: [Color.ink, Color.slate],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
    }
}

#Preview {
    CardView()
}
