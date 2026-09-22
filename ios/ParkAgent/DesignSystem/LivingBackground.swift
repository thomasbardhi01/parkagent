import SwiftUI

/// A slow, low-contrast drift of the palette behind Home's sheet and the
/// assistant — depth, not decoration. Two soft radial washes wander on
/// multi-minute-scale periods (ink → slate → sky in light, ink → deep
/// slate in dark). It freezes to a static wash when the scene leaves the
/// foreground, under Reduce Motion, and in Low Power Mode.
struct LivingBackground: View {
    /// Multiplier on the wash opacities, so surfaces can tone it down.
    var strength: Double = 1
    /// Draw the app background underneath; false layers just the washes
    /// over whatever surface the caller already has.
    var drawsBase: Bool = true

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled

    private var animated: Bool {
        !reduceMotion && !lowPower && scenePhase == .active
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 12, paused: !animated)) { context in
            let t = animated ? context.date.timeIntervalSinceReferenceDate : 0
            wash(at: t)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onReceive(
            NotificationCenter.default
                .publisher(for: Notification.Name.NSProcessInfoPowerStateDidChange)
                .receive(on: RunLoop.main)
        ) { _ in
            lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
    }

    private func wash(at t: TimeInterval) -> some View {
        let dark = colorScheme == .dark
        // Light: a slate wash up top shading into sky low — the ink end of
        // the ramp is carried by the text and card art already on the page.
        // Dark: ink over deep slate, kept dim so text stays ahead of it.
        let a = Color.slate.opacity((dark ? 0.10 : 0.07) * strength)
        let b = (dark ? Color.ink : Color.sky).opacity((dark ? 0.16 : 0.10) * strength)
        return ZStack {
            if drawsBase { Color.appBackground }
            RadialGradient(
                colors: [a, .clear],
                center: drift(t, cx: 0.22, cy: 0.18, rx: 0.10, ry: 0.07, period: 47),
                startRadius: 0,
                endRadius: 620
            )
            RadialGradient(
                colors: [b, .clear],
                center: drift(t, cx: 0.85, cy: 0.78, rx: 0.09, ry: 0.10, period: 61),
                startRadius: 0,
                endRadius: 560
            )
        }
    }

    /// A slow Lissajous wander around (cx, cy). Incommensurate periods keep
    /// the two washes from ever visibly syncing.
    private func drift(
        _ t: TimeInterval, cx: Double, cy: Double, rx: Double, ry: Double, period: Double
    ) -> UnitPoint {
        UnitPoint(
            x: cx + rx * sin(t * 2 * .pi / period),
            y: cy + ry * cos(t * 2 * .pi / (period * 1.31))
        )
    }
}

#Preview("Living background — light") {
    LivingBackground()
}

#Preview("Living background — dark") {
    LivingBackground()
        .preferredColorScheme(.dark)
}
