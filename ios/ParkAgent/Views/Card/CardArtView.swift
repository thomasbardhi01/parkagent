import SwiftUI

/// The hero: the virtual card in ink with a single coral detail. Frozen
/// desaturates the art and pins a "Frozen" pill; revealed swaps the masked
/// number for the real one from Stripe.
struct CardArtView: View {
    let card: CardSummary
    let revealed: RevealedCardDetails?

    // Text opacities stay ≥0.85: the slate end of the gradient is light
    // enough that dimmer white drops under 4.5:1.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("ParkAgent")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.white.opacity(0.9))
                // The one coral detail on the card.
                Circle()
                    .fill(Color.actionCoral)
                    .frame(width: 8, height: 8)
                Spacer()
                Image(systemName: "wave.3.right")
                    .foregroundStyle(Color.white.opacity(0.75))
            }
            Spacer()
            numberLine
            Spacer()
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.cardholderName.uppercased())
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.white.opacity(0.85))
                    Text(expiryText)
                        .font(.captionText)
                        .foregroundStyle(Color.white.opacity(0.85))
                        .monospacedDigit()
                        .accessibilityIdentifier("card.expiry")
                }
                Spacer()
                if let revealed {
                    Text("CVC \(revealed.cvc)")
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.white.opacity(0.9))
                        .monospacedDigit()
                        .accessibilityIdentifier("card.cvc")
                } else {
                    // Whatever network the API says — never assumed.
                    CardBrandMark(brand: card.brand)
                }
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
        .saturation(card.isFrozen ? 0 : 1)
        .opacity(card.isFrozen ? 0.75 : 1)
        .overlay(alignment: .topTrailing) {
            if card.isFrozen {
                TagPill(label: "Frozen", color: .white)
                    .background(Color.ink.opacity(0.6), in: Capsule())
                    .padding(Spacing.unit)
                    .accessibilityIdentifier("card.frozenPill")
            }
        }
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
        .animation(.easeOut(duration: 0.25), value: card.isFrozen)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("card.art")
    }

    private var numberLine: some View {
        Text(revealed.map { Self.grouped($0.number) } ?? "••••  ••••  ••••  \(card.last4)")
            .font(.bodyTextSemibold)
            .monospacedDigit()
            .foregroundStyle(Color.white.opacity(0.9))
            .contentTransition(.numericText())
            .accessibilityIdentifier("card.number")
    }

    private var expiryText: String {
        let month = revealed?.expMonth ?? card.expMonth
        let year = (revealed?.expYear ?? card.expYear) % 100
        return String(format: "%02d/%02d", month, year)
    }

    static func grouped(_ number: String) -> String {
        stride(from: 0, to: number.count, by: 4).map { start in
            let lower = number.index(number.startIndex, offsetBy: start)
            let upper = number.index(lower, offsetBy: 4, limitedBy: number.endIndex) ?? number.endIndex
            return String(number[lower..<upper])
        }.joined(separator: "  ")
    }
}

#Preview("Active") {
    CardArtView(card: MockFixtures.cardSummary(frozen: false), revealed: nil)
        .padding(Spacing.unit)
        .background(Color.appBackground)
}

#Preview("Frozen") {
    CardArtView(card: MockFixtures.cardSummary(frozen: true), revealed: nil)
        .padding(Spacing.unit)
        .background(Color.appBackground)
}

#Preview("Revealed") {
    CardArtView(
        card: MockFixtures.cardSummary(frozen: false),
        revealed: RevealedCardDetails(number: "5555555555554444", cvc: "123", expMonth: 8, expYear: 2030)
    )
    .padding(Spacing.unit)
    .background(Color.appBackground)
}
