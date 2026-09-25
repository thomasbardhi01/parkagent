import MapKit
import SwiftUI

/// Single-spot results: a mini map, the recommended option as ONE hero
/// card carrying the only coral action, the rest as compact rows that
/// expand on tap with a neutral Choose, and the provider note once under
/// the list. A street option for a future time has no button at all —
/// the detector pays at the curb when the car arrives.
struct SingleSpotPlanCards: View {
    let plan: SingleSpotPlan
    let confirming: Bool
    let linkConnected: Bool
    let onConfirm: (SingleSpotOption) -> Void

    /// Which compact row is open; only one at a time.
    @State private var expandedOptionID: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if hasMapContent {
                PlanMiniMap(plan: plan)
                    .frame(height: 150)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .accessibilityIdentifier("assistant.planMap")
            }

            if let hero = plan.recommendedOption {
                HeroOptionCard(
                    option: hero,
                    confirming: confirming,
                    linkConnected: linkConnected,
                    onConfirm: { onConfirm(hero) }
                )
            }

            if !plan.otherOptions.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(plan.otherOptions.enumerated()), id: \.element.id) { index, option in
                        CompactOptionRow(
                            option: option,
                            isExpanded: expandedOptionID == option.id,
                            confirming: confirming,
                            linkConnected: linkConnected,
                            onToggle: { toggle(option) },
                            onChoose: { onConfirm(option) }
                        )
                        if index < plan.otherOptions.count - 1 { Divider() }
                    }
                }
                .cardStyle()
            }

            if let provider = providerNote {
                Text(provider)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("assistant.providerNote")
            }

            if let note = plan.note {
                Text(note)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : Motion.settle, value: expandedOptionID)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.singleSpotPlan")
    }

    private func toggle(_ option: SingleSpotOption) {
        expandedOptionID = expandedOptionID == option.id ? nil : option.id
    }

    private var hasMapContent: Bool {
        plan.destination != nil || plan.options.contains { $0.coordinate != nil }
    }

    /// Provenance once for the whole list — which sources the garages
    /// came from and when we looked. Never invented: no provenance from
    /// the server, no line.
    private var providerNote: String? {
        guard plan.options.contains(where: { $0.type == "garage" }),
              let provenance = plan.provenance
        else { return nil }
        // The server sends the sources actually shown, "+"-joined.
        let names = provenance.provider
            .split(separator: "+")
            .map { GarageSource.displayName($0) ?? $0.capitalized }
        let sources = ListFormatter.localizedString(byJoining: names)
        guard let searchedAt = Format.parseArrival(provenance.searchedAt) else {
            return "Garage prices from \(sources)."
        }
        return "Garage prices from \(sources), checked \(Format.clockTime(searchedAt))."
    }

}

/// The recommended option, full width, with the single coral action.
private struct HeroOptionCard: View {
    let option: SingleSpotOption
    let confirming: Bool
    let linkConnected: Bool
    let onConfirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack(spacing: Spacing.half) {
                Image(systemName: option.type == "garage" ? "building.2.fill" : "parkingsign")
                    .foregroundStyle(Color.textSecondary)
                Text(option.label)
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Spacer(minLength: Spacing.half)
                TagPill(label: "Recommended", color: .success)
            }
            if !option.detail.isEmpty {
                Text(option.detail)
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
            }
            OptionFacts(option: option)

            if option.payOnArrival == true {
                // A future street meter: nothing to confirm now — meters
                // run from the moment they're paid, so the detector pays
                // when the car actually parks there.
                AutoPayNote(optionID: option.id)
            } else {
                Button(confirmLabel) { onConfirm() }
                    .buttonStyle(.primary)
                    .disabled(confirming)
                    .accessibilityIdentifier("assistant.confirm.\(option.id)")
            }

            // Link pays garages only; a street meter stays on the card on
            // the parking account.
            if linkConnected && option.type == "garage" && option.priceUsd > 0 {
                LinkPayBadge()
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .overlay(
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(Color.success.opacity(0.5), lineWidth: 2)
        )
        // Deliberately NO identifier on this container: an identifier here
        // makes SwiftUI publish the card as one element and swallows the
        // Confirm button, the Link badge, and the auto-pay note inside it.
        // The hero is identified by its Recommended pill and its action.
    }

    private var confirmLabel: String {
        option.type == "garage"
            ? "Confirm — open \(option.provider.flatMap(GarageSource.displayName) ?? "checkout") (\(Format.money(option.priceUsd)))"
            : "Confirm \(Format.money(option.priceUsd)) for \(option.durationMinutes) min"
    }
}

/// An alternative: name, price, walk time. Tap to expand into the detail
/// and a NEUTRAL Choose — the coral action stays with the hero.
private struct CompactOptionRow: View {
    let option: SingleSpotOption
    let isExpanded: Bool
    let confirming: Bool
    let linkConnected: Bool
    let onToggle: () -> Void
    let onChoose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            // The whole row is the hit target: a Button wrapping an HStack
            // with a Spacer lets taps in the gap fall through, so the tap
            // goes on the row with an explicit contentShape instead.
            HStack(spacing: Spacing.half) {
                Image(systemName: option.type == "garage" ? "building.2.fill" : "parkingsign")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                Text(option.label)
                    .font(.secondaryText)
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: Spacing.half)
                if let walk = option.walkMinutes {
                    Text("\(walk) min")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                }
                Text(Format.money(option.priceUsd))
                    .font(.bodyTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            .padding(Spacing.unit)
            .contentShape(Rectangle())
            .onTapGesture { onToggle() }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("assistant.optionRow.\(option.id)")
            .accessibilityHint(isExpanded ? "Collapses the option" : "Expands the option")

            if isExpanded {
                VStack(alignment: .leading, spacing: Spacing.half) {
                    if !option.detail.isEmpty {
                        Text(option.detail)
                            .font(.secondaryText)
                            .foregroundStyle(Color.textSecondary)
                    }
                    OptionFacts(option: option)
                    // Choosing a garage with Link active goes through a
                    // Link approval — say so before the tap, as the hero does.
                    if linkConnected && option.type == "garage" && option.priceUsd > 0 {
                        LinkPayBadge()
                    }
                    if option.payOnArrival == true {
                        AutoPayNote(optionID: option.id)
                    } else {
                        Button("Choose") { onChoose() }
                            .buttonStyle(.secondary)
                            .disabled(confirming)
                            .accessibilityIdentifier("assistant.choose.\(option.id)")
                    }
                }
                .padding(.horizontal, Spacing.unit)
                .padding(.bottom, Spacing.unit)
            }
        }
    }
}

/// Price, walk time, entry type — the same row in both card shapes.
private struct OptionFacts: View {
    let option: SingleSpotOption

    var body: some View {
        HStack(spacing: Spacing.unit) {
            Label(Format.money(option.priceUsd), systemImage: "dollarsign.circle")
            if let walk = option.walkMinutes {
                Label("\(walk) min walk", systemImage: "figure.walk")
            }
            if let entry = option.entryType, entry != "unknown" {
                Label(entry.capitalized, systemImage: "arrow.right.to.line")
            }
        }
        .font(.captionText)
        .foregroundStyle(Color.textSecondary)
    }
}

/// A future street meter can't be started now — no button, just the fact.
private struct AutoPayNote: View {
    let optionID: String

    var body: some View {
        HStack(spacing: Spacing.half) {
            Image(systemName: "checkmark.seal")
                .foregroundStyle(Color.success)
            Text("Pays automatically when you park")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
        }
        .padding(.vertical, Spacing.quarter)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistant.autoPayNote.\(optionID)")
    }
}

private struct LinkPayBadge: View {
    var body: some View {
        HStack(spacing: Spacing.quarter) {
            Image(systemName: "link.circle.fill")
            Text("Paying with Link — you'll approve it in Link")
        }
        .font(.captionTextSemibold)
        .foregroundStyle(Color.actionCoralLink)
        .accessibilityIdentifier("assistant.linkPayBadge")
    }
}

/// Destination and option pins. The destination is the place the user
/// named; options are tinted street vs garage, the recommended one
/// filled coral so the hero is findable on the map too.
struct PlanMiniMap: View {
    let plan: SingleSpotPlan

    var body: some View {
        Map(initialPosition: .region(region)) {
            if let destination = plan.destination {
                Annotation(
                    destination.label,
                    coordinate: CLLocationCoordinate2D(
                        latitude: destination.lat, longitude: destination.lng
                    )
                ) {
                    Image(systemName: "mappin.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(Color.textPrimary)
                        .background(Circle().fill(Color.surface))
                }
            }
            ForEach(plan.options) { option in
                if let coordinate = option.coordinate {
                    Annotation(option.label, coordinate: coordinate) {
                        Circle()
                            .fill(option.recommended ? Color.actionCoral : Color.sky)
                            .frame(width: 18, height: 18)
                            .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
                    }
                }
            }
        }
        // Decorative and non-interactive: every pin is also a card below,
        // and a live map inside a scrolling transcript steals the drag.
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Fit the destination and every pinned option, with a floor so a
    /// single pin doesn't zoom to the building.
    private var region: MKCoordinateRegion {
        var points: [CLLocationCoordinate2D] = plan.options.compactMap(\.coordinate)
        if let destination = plan.destination {
            points.append(
                CLLocationCoordinate2D(latitude: destination.lat, longitude: destination.lng)
            )
        }
        guard let first = points.first else {
            // No pins at all (the plan carries its options' own points, so
            // this is a malformed plan): the metro fallback, never a fixed
            // NYC point.
            return MKCoordinateRegion(
                center: CityCatalog.fallbackCenter,
                span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
            )
        }
        let lats = points.map(\.latitude)
        let lngs = points.map(\.longitude)
        let minLat = lats.min() ?? first.latitude
        let maxLat = lats.max() ?? first.latitude
        let minLng = lngs.min() ?? first.longitude
        let maxLng = lngs.max() ?? first.longitude
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(
                latitude: (minLat + maxLat) / 2,
                longitude: (minLng + maxLng) / 2
            ),
            span: MKCoordinateSpan(
                latitudeDelta: max((maxLat - minLat) * 1.6, 0.006),
                longitudeDelta: max((maxLng - minLng) * 1.6, 0.006)
            )
        )
    }
}
