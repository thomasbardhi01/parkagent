import SwiftUI

/// The words for the two cards that say no, and for a near-miss wherever
/// it appears. Everything is the server's — which limit, the limit, the
/// actual — put into a sentence; nothing is computed about the request on
/// the phone.
enum NoCardPresentation {
    /// What a near-miss breaks, and by how much: "$2.00 over your $20.00
    /// limit", "4 min past your 10-min walk". The limit is the user's own,
    /// for this request — never called a cap: there is no per-trip cap
    /// (decision 9).
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
            return "\(Int((actual - limit).rounded())) min past your \(Int(limit.rounded()))-min walk"
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

    /// What a secondary alternative is, next to the option that leads:
    /// "Closer" or "Cheaper" (decision 8). Nil for any other option.
    static func alternativeLead(_ option: SingleSpotOption) -> String? {
        guard option.secondary == true, option.nearMiss != true else { return nil }
        switch option.axis {
        case "closest": return "Closer"
        case "cheapest": return "Cheaper"
        case "both": return "Cheaper and closer"
        default: return nil
        }
    }

    /// The "no" card's headline, from the limits nothing met: "Nothing
    /// under $2.00", "No garage under $10.00 within a 5-min walk". With
    /// the garage search itself down, that is the headline.
    static func headline(_ plan: NoneMeetsPlan) -> String {
        if plan.garageSearchUnavailable { return "Couldn't check garages" }
        var noun = "Nothing"
        var limits: [String] = []
        for failed in plan.constraintsFailed {
            switch failed.field {
            case "kinds":
                if case .list(let kinds)? = failed.limit, kinds.count == 1 {
                    noun = kinds[0] == "garage" ? "No garage" : "No street parking"
                }
            case "entryType":
                limits.append(failed.limit?.text == "valet" ? "with valet" : "you park yourself")
            case "covered":
                limits.append("that's covered")
            case "maxPriceUsd":
                if let limit = failed.limit?.number { limits.append("under \(Format.money(limit))") }
            case "maxWalkMinutes":
                if let limit = failed.limit?.number {
                    limits.append("within a \(Int(limit.rounded()))-min walk")
                }
            default:
                break
            }
        }
        if noun == "Nothing", limits.isEmpty { return "Nothing meets your request" }
        return ([noun] + limits).joined(separator: " ")
    }

    /// How near anything came to the limits that failed, when the server
    /// has a number for it: "Lowest price found: $4.50", "Shortest walk
    /// found: 14 min".
    static func nearest(_ plan: NoneMeetsPlan) -> String? {
        let lines: [String] = plan.constraintsFailed.compactMap { failed in
            guard let actual = failed.nearestActual?.number else { return nil }
            switch failed.field {
            case "maxPriceUsd": return "Lowest price found: \(Format.money(actual))"
            case "maxWalkMinutes": return "Shortest walk found: \(Int(actual.rounded())) min"
            default: return nil
            }
        }
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
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

/// "Nothing meets this" (FR-45): a headline from the limits nothing met,
/// up to three options that came closest — each with a badge saying which
/// limit it breaks and by how much — and the ways to relax the request as
/// chips. There is nothing to confirm here: no near-miss has a button. The
/// way forward is the user changing the request, one tap on a chip; the
/// chips are the reply's own suggestions, shown on the card they belong to.
struct NoneMeetsCardView: View {
    let plan: NoneMeetsPlan
    /// The server's ways to relax the request (the reply's suggestions).
    var relaxChips: [AssistantSuggestion] = []
    var disabled = false
    var onRelax: (AssistantSuggestion) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if let assumptions = plan.assumptions {
                AssumptionsLine(text: assumptions)
            }
            VStack(alignment: .leading, spacing: Spacing.half) {
                Label(NoCardPresentation.headline(plan), systemImage: "exclamationmark.circle")
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                    .labelStyle(.titleAndIcon)
                    .fixedSize(horizontal: false, vertical: true)
                    // On the text: a Label's identifier would land on its icon.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(NoCardPresentation.headline(plan))
                    .accessibilityIdentifier("assistant.noneMeets.title")
                if let nearest = NoCardPresentation.nearest(plan) {
                    Text(nearest)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .accessibilityIdentifier("assistant.noneMeets.nearest")
                }
                if !plan.nearMisses.isEmpty {
                    Text("These came closest:")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                    ForEach(Array(plan.nearMisses.prefix(3).enumerated()), id: \.element.id) { index, option in
                        if index > 0 { Divider() }
                        NearMissRow(option: option)
                    }
                }
                if !relaxChips.isEmpty {
                    Divider()
                    Text(plan.garageSearchUnavailable ? "You can:" : "Change the request:")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                    SuggestionChips(suggestions: relaxChips, disabled: disabled, onTap: onRelax)
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
/// breaks. Read-only — no Confirm, no Choose, and no checkout to open.
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

/// Tappable answers as chips: a tap sends that answer as the user's own
/// message, exactly as if they'd typed it. Under a reply that asks
/// something, and on a "no" card for its ways to relax the request.
struct SuggestionChips: View {
    let suggestions: [AssistantSuggestion]
    var disabled = false
    let onTap: (AssistantSuggestion) -> Void

    var body: some View {
        FlowLayout(spacing: Spacing.half) {
            ForEach(Array(suggestions.enumerated()), id: \.offset) { index, suggestion in
                Button {
                    onTap(suggestion)
                } label: {
                    Text(suggestion.label)
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.actionCoralLink)
                        .padding(.horizontal, Spacing.unit)
                        .padding(.vertical, Spacing.half)
                        .background(Color.surface)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(Color.actionCoralLink.opacity(0.5), lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .accessibilityIdentifier("assistant.suggestion.\(index)")
                .accessibilityHint("Sends this answer")
            }
        }
    }
}

#if DEBUG
#Preview("Nothing meets the request") {
    ScrollView {
        if case .noneMeets(let plan) = MockAssistantFixtures.noneMeetsPlan.plan {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                if let request = plan.requestSummary?.value {
                    RequestChipsView(request: request) { _ in }
                }
                NoneMeetsCardView(
                    plan: plan,
                    relaxChips: plan.relaxSuggestions
                        .filter { $0.wouldYield > 0 }
                        .map { AssistantSuggestion(label: $0.label, reply: $0.reply) }
                )
            }
            .padding()
        }
    }
    .background(Color.appBackground)
}

#Preview("Over the approval threshold") {
    ScrollView {
        if case .singleSpot(let plan) = MockAssistantFixtures.warnPlan.plan {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                if let request = plan.requestSummary?.value {
                    RequestChipsView(request: request) { _ in }
                }
                SingleSpotPlanCards(plan: plan, confirming: false, linkConnected: false) { _ in }
            }
            .padding()
        }
    }
    .background(Color.appBackground)
}

#Preview("Cheapest and closest lead") {
    ScrollView {
        if case .singleSpot(let plan) = MockAssistantFixtures.coPrimaryPlan.plan {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                if let request = plan.requestSummary?.value {
                    RequestChipsView(request: request) { _ in }
                }
                SingleSpotPlanCards(plan: plan, confirming: false, linkConnected: false) { _ in }
            }
            .padding()
        }
    }
    .background(Color.appBackground)
}
#endif
