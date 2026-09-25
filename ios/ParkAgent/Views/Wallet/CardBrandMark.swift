import SwiftUI

/// The card network, parsed from the `brand` string GET /card carries
/// (Stripe Issuing sends e.g. "Mastercard" / "Visa"). Nothing in the app
/// may assume a network — our issued cards are Mastercard today, but the
/// truth is whatever the API says.
enum CardBrand: Equatable {
    case mastercard
    case visa
    case other(String)

    init(_ raw: String) {
        switch raw.trimmingCharacters(in: .whitespaces).lowercased() {
        case "mastercard": self = .mastercard
        case "visa": self = .visa
        default: self = .other(raw)
        }
    }

    var displayName: String {
        switch self {
        case .mastercard: "Mastercard"
        case .visa: "Visa"
        case .other(let raw): raw
        }
    }
}

/// The network mark on the card art. Mastercard gets its interlocking
/// circles, drawn in the card's own white so the ink art keeps a single
/// accent; anything else falls back to the brand wordmark as text.
struct CardBrandMark: View {
    let brand: String

    var body: some View {
        Group {
            switch CardBrand(brand) {
            case .mastercard:
                // Interlocked rings, not filled discs — filled ones read as
                // a toggle at card size. Monochrome white keeps the ink art
                // to its single coral accent.
                HStack(spacing: -7) {
                    Circle()
                        .strokeBorder(Color.white.opacity(0.7), lineWidth: 1.8)
                        .frame(width: 21, height: 21)
                    Circle()
                        .strokeBorder(Color.white.opacity(0.9), lineWidth: 1.8)
                        .frame(width: 21, height: 21)
                }
            case .visa:
                Text("VISA")
                    .font(.system(size: 15, weight: .bold, design: .default).italic())
                    .foregroundStyle(Color.white.opacity(0.85))
            case .other(let raw):
                Text(raw)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.white.opacity(0.85))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(CardBrand(brand).displayName)
        .accessibilityIdentifier("card.brand")
    }
}

#if DEBUG
#Preview("Brand marks") {
    VStack(spacing: Spacing.unit) {
        CardBrandMark(brand: "Mastercard")
        CardBrandMark(brand: "Visa")
        CardBrandMark(brand: "Discover")
    }
    .padding(Spacing.double)
    .background(Color.ink)
}
#endif
