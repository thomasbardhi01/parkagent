import SwiftUI

// Everything in one scrollable canvas for design review. Preview-only; no
// screen ships this view.

private struct DesignSystemGallery: View {
    @State private var autoExtend = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.unitAndHalf) {
                section("Palette") {
                    VStack(spacing: Spacing.half) {
                        swatchRow("Ink", .ink)
                        swatchRow("Slate", .slate)
                        swatchRow("Steel", .steel)
                        swatchRow("Sky", .sky)
                        swatchRow("Mist", .mist)
                        swatchRow("Coral", .actionCoral)
                        swatchRow("Coral pressed", .actionCoralPressed)
                        swatchRow("Coral tint", .actionCoralTint)
                        swatchRow("Success", .success)
                        swatchRow("Warning gold", .warningGold)
                        swatchRow("Danger", .danger)
                    }
                }

                section("Typography") {
                    VStack(alignment: .leading, spacing: Spacing.half) {
                        Text("$7.28").font(.numeralLarge)
                        Text("1:29:45").font(.numeral)
                        Text("Body 17 — quote details and labels").font(.bodyText)
                        Text("Secondary 15 — street names, context")
                            .font(.secondaryText)
                            .foregroundStyle(Color.textSecondary)
                        Text("Caption 13 — rates, timestamps")
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                    }
                    .foregroundStyle(Color.textPrimary)
                }

                section("Buttons") {
                    VStack(spacing: Spacing.half) {
                        Button("Pay $7.28 for 90 min") {}.buttonStyle(.primary)
                        Button("Not parked here") {}.buttonStyle(.secondary)
                        Button("Stop session") {}.buttonStyle(.destructive)
                        Button("Pay $7.28 for 90 min") {}.buttonStyle(.primary).disabled(true)
                    }
                }

                section("Status pills") {
                    HStack(spacing: Spacing.half) {
                        StatusPill(status: .paid)
                        StatusPill(status: .active)
                        StatusPill(status: .expiring)
                        StatusPill(status: .failed)
                    }
                }

                section("Zone card") {
                    ZoneCard(
                        zoneNumber: "110436",
                        street: "Columbus Ave near W 81st St",
                        rateFirstHourUsd: 5.00,
                        rateAdditionalHourUsd: 8.25,
                        maxStayMinutes: 120,
                        isSelected: true
                    )
                }

                section("Session row") {
                    SessionRow(
                        street: "Columbus Ave near W 81st St",
                        zoneNumber: "110436",
                        date: "Today, 2:03 PM",
                        amountUsd: 7.28,
                        status: .active
                    )
                }

                section("Progress + toggle") {
                    VStack(spacing: Spacing.unit) {
                        ProgressBar(value: 0.55)
                        ToggleRow(
                            title: "Auto-extend",
                            subtitle: "Up to 2 times, 60 min each",
                            isOn: $autoExtend
                        )
                    }
                }

                section("Map pins") {
                    HStack(spacing: Spacing.double) {
                        MapPin(kind: .car)
                        MapPin(kind: .zone)
                    }
                    .padding(Spacing.unit)
                    .frame(maxWidth: .infinity)
                    .background(Color.sky.opacity(0.35))
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }
            }
            .padding(Spacing.unit)
        }
        .background(Color.appBackground)
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            Text(title)
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textSecondary)
                .textCase(.uppercase)
            content()
        }
    }

    private func swatchRow(_ name: String, _ color: Color) -> some View {
        HStack(spacing: Spacing.unit) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(color)
                .frame(width: 44, height: 28)
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(Color.separator, lineWidth: 1)
                )
            Text(name)
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
            Spacer()
        }
    }
}

#Preview("Gallery — light") {
    DesignSystemGallery()
}

#Preview("Gallery — dark") {
    DesignSystemGallery()
        .preferredColorScheme(.dark)
}
