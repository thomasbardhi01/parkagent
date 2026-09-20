import SwiftUI

// Design tokens. Colors live in DesignSystem/Colors.xcassets so light/dark
// variants resolve automatically; everything on-screen should go through the
// semantic names, with the raw palette as a fallback for one-offs.

extension Color {
    // Semantic (adapts to light/dark)
    static let appBackground = Color("Background")
    static let surface = Color("Surface")
    static let textPrimary = Color("TextPrimary")
    static let textSecondary = Color("TextSecondary")
    static let separator = Color("Separator")

    // Action & status. One coral action per screen; everything else neutral.
    static let actionCoral = Color("ActionCoral")
    static let actionCoralPressed = Color("ActionCoralPressed")
    static let actionCoralTint = Color("ActionCoralTint")
    /// Coral for text links and selection accents. Lighter than ActionCoral in
    /// dark mode so it keeps 4.5:1 on Surface; ActionCoral itself is tuned for
    /// white text on top of it, which pins it too dark to double as dark-mode text.
    static let actionCoralLink = Color("ActionCoralLink")
    static let success = Color("Success")
    static let warningGold = Color("WarningGold")
    static let danger = Color("Danger")

    // Raw palette (fixed in both modes)
    static let ink = Color("Ink")
    static let slate = Color("Slate")
    static let steel = Color("Steel")
    static let sky = Color("Sky")
    static let mist = Color("Mist")
}

extension Font {
    /// Hero money amounts and the active-session countdown.
    static let numeralLarge = Font.system(size: 48, weight: .semibold).monospacedDigit()
    /// Money and countdowns one level down (sheets, cards).
    static let numeral = Font.system(size: 40, weight: .semibold).monospacedDigit()

    static let bodyText = Font.system(size: 17)
    static let bodyTextSemibold = Font.system(size: 17, weight: .semibold)
    static let secondaryText = Font.system(size: 15)
    static let captionText = Font.system(size: 13)
    static let captionTextSemibold = Font.system(size: 13, weight: .semibold)
}

/// 16pt grid.
enum Spacing {
    static let quarter: CGFloat = 4
    static let half: CGFloat = 8
    static let unit: CGFloat = 16
    static let unitAndHalf: CGFloat = 24
    static let double: CGFloat = 32
}

enum Radius {
    static let card: CGFloat = 20
    static let button: CGFloat = 12
}

extension View {
    /// Standard card chrome: surface fill, 20pt radius, whisper of a shadow.
    func cardStyle() -> some View {
        background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
    }
}
