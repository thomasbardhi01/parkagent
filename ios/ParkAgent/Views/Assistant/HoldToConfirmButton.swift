import SwiftUI

/// The action on an option over the approval threshold (the server's
/// `warn`, FR-45): a tap confirms nothing — it only says how — and a press
/// held for `holdSeconds` confirms. The fill follows the hold, so it reads
/// as a deliberate act rather than a slow button. Everything after the
/// hold is the ordinary confirm: the same tap-minted token, the same route.
struct HoldToConfirmButton: View {
    static let holdSeconds = 0.8
    private static let titleLineHeight = UIFont.systemFont(ofSize: 17, weight: .semibold).lineHeight

    let title: String
    let identifier: String
    /// Coral, for the option that leads; neutral for an alternative.
    var prominent = true
    var disabled = false
    let onConfirm: () -> Void

    @State private var pressing = false
    @State private var began: Date?
    @State private var showHint = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.quarter) {
            Text(title)
                .font(.bodyTextSemibold)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                // The height of an unscaled line: a title that shrinks to
                // fit a narrow tile must not make the button shorter than
                // the plain button beside it.
                .frame(maxWidth: .infinity, minHeight: Self.titleLineHeight)
                .padding(.vertical, 14)
                .padding(.horizontal, Spacing.half)
                .foregroundStyle(foreground)
                .background(background)
                .overlay(alignment: .leading) { fill }
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.button, style: .continuous)
                        .strokeBorder(prominent ? Color.clear : Color.separator, lineWidth: 1)
                )
                .contentShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                .pressScale(pressing)
                .onLongPressGesture(minimumDuration: Self.holdSeconds, maximumDistance: 30) {
                    Haptics.light()
                    showHint = false
                    onConfirm()
                } onPressingChanged: { isPressing in
                    pressing = isPressing
                    if isPressing {
                        began = Date()
                    } else if let began, Date().timeIntervalSince(began) < Self.holdSeconds - 0.05 {
                        // Let go early: a tap. Say what it takes instead.
                        showHint = true
                    }
                }
                .allowsHitTesting(!disabled)
                .opacity(disabled ? 0.5 : 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(title)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(ConfirmCopy.holdHint)
                .accessibilityIdentifier(identifier)
                // A hold isn't available to every way of using the phone:
                // a named action is the deliberate second step instead.
                .accessibilityAction(named: "Confirm") { if !disabled { onConfirm() } }

            if showHint {
                Text(ConfirmCopy.holdHint)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .transition(.opacity)
                    .accessibilityIdentifier("\(identifier).holdHint")
            }
        }
        .animation(.easeInOut(duration: 0.2), value: showHint)
    }

    private var foreground: Color {
        prominent ? Color.white : Color.textPrimary
    }

    private var background: Color {
        prominent ? Color.actionCoral : Color.surface
    }

    /// The hold's progress, left to right. Under Reduce Motion the button
    /// just darkens while held.
    private var fill: some View {
        Rectangle()
            .fill(prominent ? Color.black.opacity(0.22) : Color.actionCoral.opacity(0.18))
            .scaleEffect(x: reduceMotion ? 1 : (pressing ? 1 : 0), y: 1, anchor: .leading)
            .opacity(reduceMotion ? (pressing ? 1 : 0) : 1)
            .animation(
                pressing && !reduceMotion ? .linear(duration: Self.holdSeconds) : .easeOut(duration: 0.15),
                value: pressing
            )
            .allowsHitTesting(false)
    }
}

#if DEBUG
#Preview("Hold to confirm") {
    VStack(spacing: Spacing.unit) {
        HoldToConfirmButton(title: "Hold to open SpotHero ($32.00)", identifier: "preview.hold") {}
        HoldToConfirmButton(title: "Hold to pay $18.00", identifier: "preview.hold.row", prominent: false) {}
    }
    .padding()
    .background(Color.appBackground)
}
#endif
