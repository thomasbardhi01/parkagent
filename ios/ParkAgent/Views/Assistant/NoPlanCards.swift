import SwiftUI

/// The words for the two cards that say no, and for a near-miss wherever
/// it appears. Everything is the server's — which limit, the limit, the
/// actual — put into a sentence; nothing is computed about the request on
/// the phone.
enum NoCardPresentation {
    /// What a near-miss breaks, and by how much: "$2.50 over your $2.00
    /// limit", "4 min past your 10 min walk".
    static func badge(_ violation: PlanViolation) -> String {
        switch violation.field {
        case "maxPriceUsd":
            guard let actual = violation.actual.number, let limit = violation.limit.number else {
                return "Over your price limit"
            }
            return "\(Format.money(actual - limit)) over your \(Format.money(limit)) limit"
        case "maxWalkMinutes":
            guard let actual = violation.actual.number, let limit = violation.limit.number else {
                return "Past your walking limit"
            }
            return "\(Int(actual - limit)) min past your \(Int(limit)) min walk"
        case "kinds":
            return violation.actual.text == "street" ? "Street parking, not a garage" : "A garage, not street parking"
        case "entryType":
            return violation.limit.text == "valet" ? "Not valet" : "Valet only"
        case "covered":
            return "Not known to be covered"
        default:
            return "Doesn't meet your request"
        }
    }

    /// Every limit an option breaks, one line.
    static func badges(_ option: SingleSpotOption) -> String? {
        guard let violates = option.violates, !violates.isEmpty else { return nil }
        return violates.map(badge).joined(separator: " · ")
    }

    /// "Cheapest", "Closest", or both — the label decision 8 puts on the
    /// options that lead. Nil for an option that is neither.
    static func axisLabel(_ option: SingleSpotOption) -> String? {
        switch option.axis {
        case "cheapest": "Cheapest"
        case "closest": "Closest"
        case "both": "Cheapest and closest"
        default: nil
        }
    }

    /// The card's title: what kind of "no" this is.
    static func title(_ plan: NoneMeetsPlan) -> String {
        plan.garageSearchUnavailable ? "Couldn't check garages" : "Nothing meets your request"
    }

    /// "as of 3:42 PM" for a garage price, from when it was fetched.
    static func fetchedText(_ option: SingleSpotOption) -> String? {
        guard option.type == "garage",
              let fetchedAt = option.fetchedAt,
              let date = Format.parseArrival(fetchedAt)
        else { return nil }
        return "as of \(Format.clockTime(date))"
    }

    /// The garage line under a list: where prices came from and when, or
    /// that garages couldn't be checked. Never invented: no provenance
    /// from the server, no line.
    static func providerNote(_ provenance: SingleSpotPlan.Provenance?, hasGarages: Bool) -> String? {
        guard let provenance else { return nil }
        if provenance.garage == "unavailable" {
            return "Couldn't check garages just now — these are street options only."
        }
        guard hasGarages else { return nil }
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

    /// "Brattle St · about 900 m, 15 min walk"
    static func zoneLine(_ zone: NoDataPlan.NearestZone) -> String {
        let name = zone.street ?? zone.zoneNumber.map { "Zone \($0)" } ?? "A metered block"
        return "\(name) · about \(zone.distanceM) m, \(zone.walkMinutes) min walk"
    }
}

/// "Nothing meets this": the options that came closest, each with the
/// limit it breaks. There is nothing to confirm here — the way forward is
/// to change the request, and the chips under the reply do that in one
/// tap. (The request chips and the designed near-miss card are FR-45.)
struct NoneMeetsPlanCard: View {
    let plan: NoneMeetsPlan

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if let assumptions = plan.assumptions {
                AssumptionsLine(text: assumptions)
            }
            VStack(alignment: .leading, spacing: Spacing.half) {
                Label(NoCardPresentation.title(plan), systemImage: "exclamationmark.circle")
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                    .labelStyle(.titleAndIcon)
                    // On the text: a Label's identifier would land on its icon.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(NoCardPresentation.title(plan))
                    .accessibilityIdentifier("assistant.noneMeets.title")
                if !plan.nearMisses.isEmpty {
                    Text("These came closest:")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                    ForEach(Array(plan.nearMisses.enumerated()), id: \.element.id) { index, option in
                        if index > 0 { Divider() }
                        NearMissRow(option: option)
                    }
                }
            }
            .padding(Spacing.unit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle()

            if let note = NoCardPresentation.providerNote(
                plan.provenance,
                hasGarages: plan.nearMisses.contains { $0.type == "garage" }
            ) {
                Text(note)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("assistant.providerNote")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.noneMeetsPlan")
    }
}

/// One option that broke a limit: what it is, what it costs, and what it
/// breaks. Read-only — no Confirm, no Choose.
struct NearMissRow: View {
    let option: SingleSpotOption

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.quarter) {
            HStack(spacing: Spacing.half) {
                Image(systemName: option.type == "garage" ? "building.2.fill" : "parkingsign")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityHidden(true)
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
            }
            if let badges = NoCardPresentation.badges(option) {
                NearMissBadge(text: badges, optionID: option.id)
            }
            if let fetched = NoCardPresentation.fetchedText(option) {
                Text("Price \(fetched)")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistant.nearMiss.\(option.id)")
    }
}

/// What a near-miss breaks, in the warning color.
struct NearMissBadge: View {
    let text: String
    let optionID: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle")
            .font(.captionTextSemibold)
            .foregroundStyle(Color.warningGold)
            .labelStyle(.titleAndIcon)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
            .accessibilityIdentifier("assistant.nearMissBadge.\(optionID)")
    }
}

/// "We have nothing to offer there": not a refusal, a gap in the data —
/// with the nearest metered blocks we do know.
struct NoDataPlanCard: View {
    let plan: NoDataPlan

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if let assumptions = plan.assumptions {
                AssumptionsLine(text: assumptions)
            }
            VStack(alignment: .leading, spacing: Spacing.half) {
                Label("No parking data here", systemImage: "mappin.slash")
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                    .labelStyle(.titleAndIcon)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("No parking data here")
                    .accessibilityIdentifier("assistant.noData.title")
                if !plan.nearestZones.isEmpty {
                    Text("The nearest metered blocks:")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                    ForEach(plan.nearestZones) { zone in
                        Label(NoCardPresentation.zoneLine(zone), systemImage: "parkingsign")
                            .font(.secondaryText)
                            .foregroundStyle(Color.textPrimary)
                            .labelStyle(.titleAndIcon)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(NoCardPresentation.zoneLine(zone))
                            .accessibilityIdentifier("assistant.nearestZone.\(zone.zoneId)")
                    }
                }
            }
            .padding(Spacing.unit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardStyle()

            if let note = NoCardPresentation.providerNote(plan.provenance, hasGarages: false) {
                Text(note)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.noDataPlan")
    }
}

#if DEBUG
#Preview("Nothing meets the request") {
    ScrollView {
        if case .noneMeets(let plan) = MockAssistantFixtures.noneMeetsPlan.plan {
            NoneMeetsPlanCard(plan: plan).padding()
        }
    }
}
#endif
