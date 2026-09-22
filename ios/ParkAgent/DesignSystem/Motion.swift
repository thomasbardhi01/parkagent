import SwiftUI
import UIKit

/// Motion tokens. Short, settled, and never bouncy where money is involved;
/// every use site is expected to respect Reduce Motion (the helpers below
/// carry that check so views don't repeat it).
enum Motion {
    /// Button press-down/release. Critically damped — no overshoot.
    static let press: Animation = .spring(duration: 0.2)
    /// Cards and panels sliding into place. A whisper of settle.
    static let settle: Animation = .spring(duration: 0.35, bounce: 0.12)
    /// Anything showing an amount of money: plain ease, no bounce.
    static let money: Animation = .easeOut(duration: 0.25)
    /// Status color morphs (pills, tints).
    static let morph: Animation = .easeInOut(duration: 0.3)
}

/// Press feedback for button styles: a light scale-down. Skipped under
/// Reduce Motion, where the styles' existing color change carries the state.
private struct PressScale: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let isPressed: Bool

    func body(content: Content) -> some View {
        content
            .scaleEffect(reduceMotion ? 1 : (isPressed ? 0.97 : 1))
            .animation(Motion.press, value: isPressed)
    }
}

extension View {
    func pressScale(_ isPressed: Bool) -> some View {
        modifier(PressScale(isPressed: isPressed))
    }
}

/// `.plain` plus the press scale, for tappable tiles and rows that carry
/// their own chrome (card action tiles, zone candidates, session rows).
struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .pressScale(configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableButtonStyle {
    static var pressable: PressableButtonStyle { PressableButtonStyle() }
}

/// One place for the few haptics the app uses, so the vocabulary stays
/// small: light on a money confirm, success when a session starts, warning
/// when one is about to expire.
@MainActor
enum Haptics {
    static func light() {
        guard enabled else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func success() {
        guard enabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        guard enabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    /// Haptics add nothing under UI test and only slow the runner down.
    private static var enabled: Bool { !LaunchOverrides.uiTesting }
}

// Matched-geometry zoom from a session row into its detail. The API is
// iOS 18+, so earlier systems (and Reduce Motion) keep the plain push.
// ViewModifiers reading the environment, not the UIAccessibility global:
// the global is non-reactive, so a mid-session Reduce Motion toggle would
// never invalidate the view.
private struct ZoomSourceModifier<ID: Hashable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let id: ID
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), !reduceMotion {
            content.matchedTransitionSource(id: id, in: namespace)
        } else {
            content
        }
    }
}

private struct ZoomDestinationModifier<ID: Hashable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let id: ID
    let namespace: Namespace.ID

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), !reduceMotion {
            content.navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            content
        }
    }
}

extension View {
    func zoomSource(id: some Hashable, in namespace: Namespace.ID) -> some View {
        modifier(ZoomSourceModifier(id: id, namespace: namespace))
    }

    func zoomDestination(id: some Hashable, in namespace: Namespace.ID) -> some View {
        modifier(ZoomDestinationModifier(id: id, namespace: namespace))
    }
}
