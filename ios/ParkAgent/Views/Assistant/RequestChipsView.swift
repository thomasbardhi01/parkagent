import SwiftUI

/// One chip of the request a card answered: what it says, and the message
/// a tap sends.
struct RequestChip: Identifiable, Equatable {
    /// The request field it stands for: "intent", "place", "window",
    /// "hard.maxPriceUsd", "soft.rank", …
    let id: String
    let label: String
    let icon: String
    /// The server filled this in — the phone's location, the hour's stay —
    /// so it reads as an assumption, not as something the user said.
    var assumed = false
    /// What a tap sends as the user's message. It names what to change and
    /// carries no value: the assistant asks for one, and the request stays
    /// the server's to change.
    let message: String
}

/// The request as chips (FR-45), from the summary the server put on the
/// card. One chip per set field: the intent, the place, the time window,
/// each limit, and the rank — a rank chip only when the user asked for one
/// (decision 8). Nothing about the request is worked out on the phone.
enum RequestChips {
    static func chips(for request: RequestSummary) -> [RequestChip] {
        var chips: [RequestChip] = [intent(request)]
        if let place = place(request) { chips.append(place) }
        chips.append(window(request))

        let hard = request.hard
        if let price = hard.maxPriceUsd {
            chips.append(RequestChip(
                id: "hard.maxPriceUsd",
                label: "Under \(Format.money(price))",
                icon: "dollarsign.circle",
                message: "Change the budget"
            ))
        }
        if let walk = hard.maxWalkMinutes {
            chips.append(RequestChip(
                id: "hard.maxWalkMinutes",
                label: "\(walk)-min walk or less",
                icon: "figure.walk",
                message: "Change the walking distance"
            ))
        }
        // A garage-only request is its intent: the intent chip says it once.
        if hard.kinds == ["street"] {
            chips.append(RequestChip(
                id: "hard.kinds",
                label: "Street only",
                icon: "parkingsign",
                message: "Change street or garage"
            ))
        }
        if let entry = hard.entryType {
            chips.append(RequestChip(
                id: "hard.entryType",
                label: entry == "valet" ? "Valet" : "Self-park",
                icon: "arrow.right.to.line",
                message: "Change valet or self-park"
            ))
        }
        if hard.covered == true {
            chips.append(RequestChip(
                id: "hard.covered",
                label: "Covered",
                icon: "umbrella",
                message: "Change the covered parking requirement"
            ))
        }
        if let rank = rank(request.soft.rank) { chips.append(rank) }
        return chips
    }

    private static func intent(_ request: RequestSummary) -> RequestChip {
        let (label, icon): (String, String) = switch request.intent {
        case "park_later": ("Parking later", "clock")
        case "garage_or_lot": ("Garage or lot", "building.2")
        default: ("Parking now", "car")
        }
        return RequestChip(id: "intent", label: label, icon: icon, message: "Change what I'm looking for")
    }

    /// The place the user named, or the phone's location said as what it
    /// is: an assumption. No place at all is no chip.
    private static func place(_ request: RequestSummary) -> RequestChip? {
        let named = request.place.resolved?.label ?? request.place.query
        if request.assumed?.place != nil {
            return RequestChip(
                id: "place", label: "Near you", icon: "location", assumed: true, message: "Change the place"
            )
        }
        guard let named else { return nil }
        return RequestChip(id: "place", label: "Near \(named)", icon: "mappin", message: "Change the place")
    }

    /// "Now · 1 hr", "Sat 7:00 PM · 3 hr". A stay the search assumed is
    /// shown, and marked.
    private static func window(_ request: RequestSummary) -> RequestChip {
        let start = request.window.startsAt.flatMap(Format.parseArrival).map(startText) ?? "Now"
        let stay = request.window.durationMinutes ?? request.assumed?.durationMinutes
        return RequestChip(
            id: "window",
            label: stay.map { "\(start) · \(Format.minutes($0))" } ?? start,
            icon: "calendar",
            assumed: request.window.durationMinutes == nil && request.assumed?.durationMinutes != nil,
            message: "Change the time"
        )
    }

    private static func startText(_ date: Date) -> String {
        if Calendar.current.isDate(date, inSameDayAs: AppClock.now) { return Format.clockTime(date) }
        return "\(date.formatted(.dateTime.weekday(.abbreviated))) \(Format.clockTime(date))"
    }

    private static func rank(_ rank: String?) -> RequestChip? {
        let label: String? = switch rank {
        case "cheapest": "Cheapest first"
        case "closest": "Closest first"
        case "balanced": "Best balance"
        default: nil
        }
        guard let label else { return nil }
        return RequestChip(id: "soft.rank", label: label, icon: "arrow.up.arrow.down", message: "Change the ranking")
    }
}

/// The request a card answered, above the card: what the assistant
/// understood, at a glance. A tap sends a short message ("Change the
/// budget") — there is no editing here; the server owns the request.
struct RequestChipsView: View {
    let request: RequestSummary
    var disabled = false
    let onTap: (RequestChip) -> Void

    var body: some View {
        FlowLayout(spacing: Spacing.half) {
            ForEach(RequestChips.chips(for: request)) { chip in
                Button {
                    onTap(chip)
                } label: {
                    HStack(spacing: Spacing.quarter) {
                        Image(systemName: chip.icon)
                            .font(.captionText)
                            .accessibilityHidden(true)
                        Text(chip.label)
                            .font(.captionTextSemibold)
                            .lineLimit(1)
                    }
                    .foregroundStyle(chip.assumed ? Color.textSecondary : Color.textPrimary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.surface)
                    .clipShape(Capsule())
                    .overlay(
                        Capsule().strokeBorder(
                            Color.separator,
                            // An assumption is drawn dashed: the server's, not the user's.
                            style: StrokeStyle(lineWidth: 1, dash: chip.assumed ? [3, 3] : [])
                        )
                    )
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .accessibilityLabel(chip.assumed ? "\(chip.label), assumed" : chip.label)
                .accessibilityHint("Asks to change it")
                .accessibilityIdentifier("assistant.requestChip.\(chip.id)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // .contain keeps each chip queryable; an identifier alone would
        // publish the row as one element.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.requestChips")
    }
}

#if DEBUG
#Preview("Request chips") {
    VStack(alignment: .leading, spacing: Spacing.unit) {
        if case .noneMeets(let plan) = MockAssistantFixtures.noneMeetsPlan.plan,
           let request = plan.requestSummary?.value {
            RequestChipsView(request: request) { _ in }
        }
        if case .singleSpot(let plan) = MockAssistantFixtures.warnPlan.plan,
           let request = plan.requestSummary?.value {
            RequestChipsView(request: request) { _ in }
        }
    }
    .padding()
    .background(Color.appBackground)
}
#endif
