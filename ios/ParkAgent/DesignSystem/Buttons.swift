import SwiftUI

// The three button roles. Coral is reserved for the single primary action on
// a screen; secondary stays neutral, destructive is for stopping sessions.

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.bodyTextSemibold)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(isEnabled ? Color.white : Color.steel)
            .background(
                isEnabled
                    ? (configuration.isPressed ? Color.actionCoralPressed : Color.actionCoral)
                    : Color.mist
            )
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .pressScale(configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.bodyTextSemibold)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(isEnabled ? Color.textPrimary : Color.steel)
            .background(Color.surface.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.button, style: .continuous)
                    .strokeBorder(Color.separator, lineWidth: 1)
            )
            .pressScale(configuration.isPressed)
    }
}

struct DestructiveButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.bodyTextSemibold)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(isEnabled ? Color.danger : Color.steel)
            .background(Color.surface.opacity(configuration.isPressed ? 0.7 : 1))
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.button, style: .continuous)
                    .strokeBorder(isEnabled ? Color.danger.opacity(0.4) : Color.separator, lineWidth: 1)
            )
            .pressScale(configuration.isPressed)
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

extension ButtonStyle where Self == DestructiveButtonStyle {
    static var destructive: DestructiveButtonStyle { DestructiveButtonStyle() }
}

#Preview("Buttons") {
    VStack(spacing: Spacing.unit) {
        Button("Pay $7.28 for 90 min") {}
            .buttonStyle(.primary)
        Button("Pay $7.28 for 90 min") {}
            .buttonStyle(.primary)
            .disabled(true)
        Button("Not parked here") {}
            .buttonStyle(.secondary)
        Button("Not parked here") {}
            .buttonStyle(.secondary)
            .disabled(true)
        Button("Stop session") {}
            .buttonStyle(.destructive)
        Button("Stop session") {}
            .buttonStyle(.destructive)
            .disabled(true)
    }
    .padding(Spacing.unit)
    .background(Color.appBackground)
}
