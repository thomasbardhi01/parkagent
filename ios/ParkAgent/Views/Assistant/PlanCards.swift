import MapKit
import SwiftUI

/// Single-spot results: a mini map, the recommended option as ONE hero
/// card carrying the only coral action (and one line on why it's the
/// recommendation), the rest as compact rows, and the provider note once
/// under the list. A street option for a future time has no button at all
/// — the detector pays at the curb when the car arrives.
///
/// Choosing: tapping an option's row or its map pin selects it — the pin
/// is highlighted, the map recenters on it with a walking route from the
/// destination, the other pins dim, and its detail card opens (price
/// split, walk, entry, hours and max stay, where checkout happens, and its
/// action). One selection drives rows and pins both ways (PlanSelection).
struct SingleSpotPlanCards: View {
    let plan: SingleSpotPlan
    let confirming: Bool
    let linkConnected: Bool
    let onConfirm: (SingleSpotOption) -> Void

    /// The option rows and pins share; nil until the user picks one.
    @State private var selectedOptionID: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if hasMapContent {
                PlanMiniMap(plan: plan, selectedOptionID: $selectedOptionID)
                    .frame(height: 200)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            }

            if let hero = plan.recommendedOption {
                HeroOptionCard(
                    option: hero,
                    reason: plan.recommendedReason,
                    // Its distinct color only while nothing else is chosen.
                    emphasized: selectedOptionID == nil || selectedOptionID == hero.id,
                    isSelected: selectedOptionID == hero.id,
                    destinationLabel: plan.destination?.label,
                    confirming: confirming,
                    linkConnected: linkConnected,
                    onSelect: { select(hero) },
                    onConfirm: { onConfirm(hero) }
                )
            }

            if !plan.otherOptions.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(plan.otherOptions.enumerated()), id: \.element.id) { index, option in
                        CompactOptionRow(
                            option: option,
                            isExpanded: selectedOptionID == option.id,
                            destinationLabel: plan.destination?.label,
                            confirming: confirming,
                            linkConnected: linkConnected,
                            onToggle: { select(option) },
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
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : Motion.settle, value: selectedOptionID)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.singleSpotPlan")
    }

    private func select(_ option: SingleSpotOption) {
        selectedOptionID = PlanSelection.toggled(selectedOptionID, tapping: option.id)
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

/// The recommended option, full width, with the single coral action and
/// the server's one line on why it's the recommendation. Tapping its
/// header selects it like any other option.
private struct HeroOptionCard: View {
    let option: SingleSpotOption
    let reason: String?
    let emphasized: Bool
    let isSelected: Bool
    let destinationLabel: String?
    let confirming: Bool
    let linkConnected: Bool
    let onSelect: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                HStack(spacing: Spacing.half) {
                    Image(systemName: option.type == "garage" ? "building.2.fill" : "parkingsign")
                        .foregroundStyle(Color.textSecondary)
                    // The selection hook lives on the label (a leaf): an
                    // identifier on the stack would swallow the pill.
                    Text(option.label)
                        .font(.bodyTextSemibold)
                        .foregroundStyle(Color.textPrimary)
                        .accessibilityAddTraits(.isButton)
                        .accessibilityValue(isSelected ? "selected" : "")
                        .accessibilityIdentifier("assistant.heroHeader.\(option.id)")
                    Spacer(minLength: Spacing.half)
                    TagPill(label: "Recommended", color: emphasized ? .success : .steel)
                }
                if let reason {
                    Text(reason)
                        .font(.captionTextSemibold)
                        .foregroundStyle(emphasized ? Color.success : Color.textSecondary)
                        .accessibilityIdentifier("assistant.recommendedReason")
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { onSelect() }

            if !option.detailLine.isEmpty {
                Text(option.detailLine)
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("assistant.optionDetail.\(option.id)")
            }
            OptionFacts(option: option)

            if isSelected {
                OptionDetailCard(option: option, destinationLabel: destinationLabel)
                    .transition(.opacity)
            }

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
                .strokeBorder(
                    emphasized ? Color.success.opacity(0.5) : Color.separator,
                    lineWidth: emphasized ? 2 : 1
                )
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

/// An alternative: name, price, walk time. Tapping it (or its pin) selects
/// it: it opens into its detail card and a NEUTRAL Choose — the coral
/// action stays with the hero.
private struct CompactOptionRow: View {
    let option: SingleSpotOption
    let isExpanded: Bool
    let destinationLabel: String?
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
                    .foregroundStyle(isExpanded ? Color.actionCoralLink : Color.textSecondary)
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
            .background(isExpanded ? Color.actionCoral.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
            .onTapGesture { onToggle() }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(isExpanded ? "selected" : "")
            .accessibilityIdentifier("assistant.optionRow.\(option.id)")
            .accessibilityHint(isExpanded ? "Collapses the option" : "Shows the option's details")

            if isExpanded {
                VStack(alignment: .leading, spacing: Spacing.half) {
                    if !option.detailLine.isEmpty {
                        Text(option.detailLine)
                            .font(.secondaryText)
                            .foregroundStyle(Color.textSecondary)
                            .accessibilityIdentifier("assistant.optionDetail.\(option.id)")
                    }
                    OptionDetailCard(option: option, destinationLabel: destinationLabel)
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

/// A selected option's facts: what it costs and why, the walk, how you
/// get in, when it's metered or booked and for how long, and who takes
/// the money where. Leaves carry the identifiers (the plan container is
/// already `.contain`; a nested one would flatten).
private struct OptionDetailCard: View {
    let option: SingleSpotOption
    let destinationLabel: String?

    var body: some View {
        let detail = OptionDetailPresentation(option: option, destinationLabel: destinationLabel)
        VStack(alignment: .leading, spacing: 6) {
            row("dollarsign.circle", detail.price, "price")
            if let walk = detail.walk { row("figure.walk", walk, "walk") }
            if let entry = detail.entry { row("arrow.right.to.line", entry, "entry") }
            if let hours = detail.hours { row("clock", hours, "hours") }
            row(option.type == "garage" ? "safari" : "creditcard", detail.checkout, "checkout")
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appBackground)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
    }

    private func row(_ icon: String, _ text: String, _ kind: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.half) {
            Image(systemName: icon)
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .frame(width: 18)
                .accessibilityHidden(true)
            Text(text)
                .font(.captionText)
                .foregroundStyle(Color.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("assistant.detail.\(kind).\(option.id)")
        }
    }
}

/// Price, walk time, entry type — the same row in both card shapes.
private struct OptionFacts: View {
    let option: SingleSpotOption

    var body: some View {
        HStack(spacing: Spacing.unit) {
            Label(Format.money(option.priceUsd), systemImage: "dollarsign.circle")
            // A street block's line already says the walk.
            if let walk = option.walkMinutes, option.streetSummary == nil {
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
/// named (dark); options are pins that select on tap. With nothing
/// selected the recommended pin is coral and the rest sky; with one
/// selected it grows coral, the rest dim, the map recenters on it, and a
/// walking route runs to it from the destination (a straight dashed line
/// until MapKit's walking directions arrive, or if they can't).
struct PlanMiniMap: View {
    let plan: SingleSpotPlan
    @Binding var selectedOptionID: String?

    @State private var position: MapCameraPosition
    @State private var route: [CLLocationCoordinate2D] = []
    @State private var routeIsWalking = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(plan: SingleSpotPlan, selectedOptionID: Binding<String?>) {
        self.plan = plan
        _selectedOptionID = selectedOptionID
        _position = State(initialValue: .region(
            PlanSelection.region(plan, selectedID: selectedOptionID.wrappedValue)
        ))
    }

    var body: some View {
        // No pan or zoom: a live map inside a scrolling transcript steals
        // the drag. Pins still take taps — they're buttons.
        Map(position: $position, interactionModes: []) {
            if route.count >= 2 {
                MapPolyline(coordinates: route)
                    .stroke(
                        Color.actionCoral,
                        style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round, dash: routeIsWalking ? [] : [6, 6])
                    )
            }
            if let destination = plan.destination {
                Annotation(destination.label, coordinate: destination.coordinate) {
                    Image(systemName: "mappin.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(Color.textPrimary)
                        .background(Circle().fill(Color.surface))
                        .accessibilityLabel("Destination: \(destination.label)")
                }
                .annotationTitles(.hidden)
            }
            ForEach(plan.options) { option in
                if let coordinate = option.coordinate {
                    Annotation(option.label, coordinate: coordinate) {
                        pin(option)
                    }
                    .annotationTitles(.hidden)
                }
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .onChange(of: selectedOptionID) { _, id in
            withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : Motion.settle) {
                position = .region(PlanSelection.region(plan, selectedID: id))
            }
        }
        .task(id: selectedOptionID) { await loadRoute() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.planMap")
    }

    private func pin(_ option: SingleSpotOption) -> some View {
        let style = PlanSelection.pinStyle(
            optionID: option.id,
            recommendedID: plan.recommendedOption?.id,
            selectedID: selectedOptionID
        )
        let size: CGFloat = style == .selected ? 26 : 18
        return Button {
            selectedOptionID = PlanSelection.toggled(selectedOptionID, tapping: option.id)
        } label: {
            Circle()
                .fill(style == .recommended || style == .selected ? Color.actionCoral : Color.sky)
                .frame(width: size, height: size)
                .overlay(Circle().strokeBorder(Color.white, lineWidth: style == .selected ? 3 : 2))
                .shadow(color: .black.opacity(style == .selected ? 0.25 : 0), radius: 3, y: 1)
                .opacity(style == .dimmed ? 0.55 : 1)
                // A 44-pt target around a small dot.
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
        .accessibilityValue(style.rawValue)
        .accessibilityIdentifier("assistant.mapPin.\(option.id)")
    }

    /// The walk from the destination to the selected option: straight at
    /// once, then MapKit's walking route when it arrives. UI tests keep the
    /// straight line — no network, same picture every run.
    private func loadRoute() async {
        guard let id = selectedOptionID,
              let option = plan.options.first(where: { $0.id == id }),
              let to = option.coordinate,
              let from = plan.destination?.coordinate
        else {
            route = []
            return
        }
        route = [from, to]
        routeIsWalking = false
        guard !LaunchOverrides.uiTesting else { return }
        let request = MKDirections.Request()
        request.source = Self.mapItem(from)
        request.destination = Self.mapItem(to)
        request.transportType = .walking
        guard let response = try? await MKDirections(request: request).calculate(),
              let polyline = response.routes.first?.polyline,
              !Task.isCancelled
        else { return }
        var points = [CLLocationCoordinate2D](repeating: kCLLocationCoordinate2DInvalid, count: polyline.pointCount)
        polyline.getCoordinates(&points, range: NSRange(location: 0, length: polyline.pointCount))
        route = points
        routeIsWalking = true
    }

    private static func mapItem(_ coordinate: CLLocationCoordinate2D) -> MKMapItem {
        if #available(iOS 26, *) {
            return MKMapItem(
                location: CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude),
                address: nil
            )
        }
        return MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
    }
}
