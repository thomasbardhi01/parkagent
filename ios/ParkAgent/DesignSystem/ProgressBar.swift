import SwiftUI

/// Thin capsule progress bar, e.g. today's spend against the daily cap.
struct ProgressBar: View {
    /// 0...1; values outside are clamped.
    let value: Double
    var tint: Color = .actionCoral

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.separator.opacity(0.6))
                Capsule()
                    .fill(tint)
                    .frame(width: geo.size.width * min(max(value, 0), 1))
            }
        }
        .frame(height: 6)
        .animation(.easeOut(duration: 0.25), value: value)
    }
}

#if DEBUG
#Preview("ProgressBar") {
    VStack(spacing: Spacing.unit) {
        ProgressBar(value: 0.12)
        ProgressBar(value: 0.55)
        ProgressBar(value: 0.85, tint: .warningGold)
        ProgressBar(value: 1.0, tint: .danger)
    }
    .padding(Spacing.unit)
    .background(Color.appBackground)
}
#endif
