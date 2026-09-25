import MapKit
import SwiftUI

/// Itinerary plan: numbered stops on a map, an editable list with
/// per-stop cost, the day total against the cap, and ONE Sign off button.
/// Stops always show in arrival order (ItineraryOrder); only a stop whose
/// time the user cleared can be dragged or moved.
///
/// Every edit is priced by the SERVER (`price`, POST
/// /assistant/plans/:planId/price) before it counts: the card shows its
/// costs and total, and Sign off waits for them and stays off while the
/// day is over the cap. Sign-off itself re-prices once more.
struct ItineraryPlanCard: View {
    let plan: ItineraryPlan
    let confirming: Bool
    let linkConnected: Bool
    /// The server's price for the card's stops.
    let price: ([ItineraryStop]) async throws -> ItineraryPriceResponse
    let onSignOff: ([ItineraryStop]) -> Void

    @State private var stops: [ItineraryStop] = []
    @State private var editingStop: ItineraryStop?
    /// The latest price request; an older answer arriving late is dropped.
    @State private var pricingRequest = 0
    @State private var isPricing = false
    @State private var lastPrice: ItineraryPriceResponse?
    @State private var priceFailed = false

    private var totalUsd: Double {
        (stops.reduce(0) { $0 + $1.costUsd } * 100).rounded() / 100
    }

    /// The server's verdict after an edit; before any edit, the proposal's
    /// own check (the plan was refused at proposal if it didn't fit).
    private var fitsCap: Bool {
        lastPrice?.fitsCap ?? (totalUsd <= plan.capUsd)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            ItineraryMap(stops: stops)
                .frame(height: 180)
                .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))

            // An untimed row drags onto another row to take its place. A
            // List in edit mode would give system drag handles, but it
            // can't self-size inside the transcript's ScrollView — a fixed
            // height either clips the last stop or leaves a gap. The
            // menu's Move up/down does the same job for VoiceOver and UI
            // tests (a synthesized drag is famously flaky). A timed stop
            // gets neither: its place is its time — edit the time instead.
            VStack(spacing: 0) {
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    let movable = ItineraryOrder.isMovable(stop)
                    ItineraryStopRow(
                        index: index + 1,
                        stop: stop,
                        isFirst: index == 0,
                        isLast: index == stops.count - 1,
                        onEdit: { editingStop = stop },
                        onMoveUp: movable ? { move(stop, by: -1) } : nil,
                        onMoveDown: movable ? { move(stop, by: 1) } : nil
                    )
                    .draggableIfUntimed(stop)
                    .dropDestination(for: String.self) { dragged, _ in
                        guard let movedID = dragged.first else { return false }
                        return move(id: movedID, toRowOf: stop.id)
                    }
                    if index < stops.count - 1 { Divider() }
                }
            }
            // No identifier on this container: on a VStack an identifier
            // publishes the whole stack as one element and swallows the
            // stop rows (a List published them; this doesn't).
            .cardStyle()

            totalRow

            if !isPricing && !fitsCap {
                Text(overCapReason)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.danger)
                    .accessibilityIdentifier("assistant.overCapNote")
            } else if priceFailed {
                Text("Couldn't check the new price. Signing off checks it again.")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("assistant.priceFailedNote")
            }

            Button(confirming ? "Signing off…" : "Sign off — \(Format.money(totalUsd)) day") {
                onSignOff(stops)
            }
            .buttonStyle(.primary)
            .disabled(confirming || isPricing || !fitsCap)
            .accessibilityIdentifier("assistant.signOffButton")

            if linkConnected {
                HStack(spacing: Spacing.quarter) {
                    Image(systemName: "link.circle.fill")
                    Text("Garages pay through Link — you'll approve each one in Link")
                }
                .font(.captionTextSemibold)
                .foregroundStyle(Color.actionCoralLink)
                .accessibilityIdentifier("assistant.linkPayBadge")
            }
            if let note = plan.note {
                Text(note)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .onAppear { if stops.isEmpty { stops = ItineraryOrder.normalized(plan.stops) } }
        .sheet(item: $editingStop) { stop in
            StopEditSheet(stop: stop, day: plan.date) { edited in
                guard let index = stops.firstIndex(where: { $0.id == edited.id }) else { return }
                // A changed time re-sorts the stop into its place.
                withAnimation {
                    stops[index] = edited
                    stops = ItineraryOrder.normalized(stops)
                }
                // Then the server prices the day as it now stands.
                Task { await reprice() }
            }
            .presentationDetents([.medium, .large])
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.itineraryPlan")
    }

    private var totalRow: some View {
        HStack {
            Text("Day total")
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textSecondary)
                .textCase(.uppercase)
            Spacer()
            if isPricing {
                HStack(spacing: Spacing.quarter) {
                    ProgressView().controlSize(.small)
                    Text("Updating price…")
                }
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("assistant.pricingNote")
            } else {
                Text("\(Format.money(totalUsd)) of \(Format.money(plan.capUsd))")
                    .font(.bodyTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(fitsCap ? Color.textPrimary : Color.danger)
                    .accessibilityIdentifier("assistant.dayTotal")
            }
        }
    }

    /// Why Sign off is off, in plain words.
    private var overCapReason: String {
        let cap = Format.money(lastPrice?.capUsd ?? plan.capUsd)
        if let spent = lastPrice?.spentTodayUsd, spent > 0 {
            return "With \(Format.money(spent)) already spent today, this day goes over your \(cap) daily limit. Shorten or drop a stop to sign off."
        }
        return "This day goes over your \(cap) daily limit. Shorten or drop a stop to sign off."
    }

    /// Ask the server for the day's price as the card now stands, and take
    /// its per-stop costs (and canonical times, estimate flags, re-picked
    /// garages) onto the card. Only the latest request's answer lands.
    private func reprice() async {
        pricingRequest += 1
        let request = pricingRequest
        isPricing = true
        priceFailed = false
        defer { if request == pricingRequest { isPricing = false } }
        do {
            let priced = try await price(stops)
            guard request == pricingRequest else { return }
            let byId = Dictionary(uniqueKeysWithValues: priced.stops.map { ($0.id, $0) })
            withAnimation {
                stops = ItineraryOrder.normalized(stops.map { stop in
                    guard let server = byId[stop.id] else { return stop }
                    var updated = stop
                    updated.arrival = server.arrival
                    updated.costUsd = server.costUsd
                    updated.estimate = server.estimate
                    updated.zoneId = server.zoneId
                    updated.garageOptionId = server.garageOptionId
                    updated.deepLink = server.deepLink
                    return updated
                })
                lastPrice = priced
            }
        } catch {
            guard request == pricingRequest else { return }
            // Sign-off re-prices on the server anyway; say so rather than
            // trap the day behind a flaky connection.
            priceFailed = true
        }
    }

    /// Move up/down, untimed stops only: swap with the neighbour, then
    /// re-apply the rule so the timed stops stay in time order around it.
    private func move(_ stop: ItineraryStop, by offset: Int) {
        guard ItineraryOrder.isMovable(stop),
              let index = stops.firstIndex(where: { $0.id == stop.id }) else { return }
        let target = index + offset
        guard stops.indices.contains(target) else { return }
        withAnimation {
            stops.swapAt(index, target)
            stops = ItineraryOrder.normalized(stops)
        }
    }

    /// Drop: the dragged (untimed) stop takes the target row's position,
    /// the rest closing up behind it. Returns false for a no-op — or a
    /// timed stop, which never moves by hand — so the drop animates back
    /// instead of pretending it landed.
    @discardableResult
    private func move(id movedID: String, toRowOf targetID: String) -> Bool {
        guard movedID != targetID,
              let from = stops.firstIndex(where: { $0.id == movedID }),
              let to = stops.firstIndex(where: { $0.id == targetID }),
              ItineraryOrder.isMovable(stops[from])
        else { return false }
        withAnimation {
            let moved = stops.remove(at: from)
            stops.insert(moved, at: to)
            stops = ItineraryOrder.normalized(stops)
        }
        return true
    }
}

private extension View {
    /// Only a stop with no set time can be dragged. The system lifts a
    /// preview of the row under the finger; no extra dimming, because a
    /// cancelled drag has no callback to undo it with and the row would
    /// stay dimmed for good.
    @ViewBuilder
    func draggableIfUntimed(_ stop: ItineraryStop) -> some View {
        if ItineraryOrder.isMovable(stop) {
            draggable(stop.id) {
                Text(stop.label)
                    .font(.captionTextSemibold)
                    .padding(Spacing.half)
                    .background(Color.surface)
            }
        } else {
            self
        }
    }
}

/// Numbered pins, street vs garage tinted.
struct ItineraryMap: View {
    let stops: [ItineraryStop]

    var body: some View {
        Map {
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                Annotation(stop.label, coordinate: .init(latitude: stop.lat, longitude: stop.lng)) {
                    ZStack {
                        Circle()
                            .fill(stop.choice == "garage" ? Color.sky : Color.actionCoral)
                            .frame(width: 26, height: 26)
                        Text("\(index + 1)")
                            .font(.captionTextSemibold)
                            .foregroundStyle(Color.white)
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}

struct ItineraryStopRow: View {
    let index: Int
    let stop: ItineraryStop
    let isFirst: Bool
    let isLast: Bool
    var onEdit: (() -> Void)?
    /// nil for a timed stop: its place is its time, so the menu offers no
    /// Move up/down.
    var onMoveUp: (() -> Void)?
    var onMoveDown: (() -> Void)?

    var body: some View {
        HStack(spacing: Spacing.half) {
            Text("\(index)")
                .font(.captionTextSemibold)
                .foregroundStyle(Color.white)
                .frame(width: 22, height: 22)
                .background(stop.choice == "garage" ? Color.sky : Color.actionCoral)
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(stop.label)
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(1)
                // One line: the pills used to break mid-word ("Stre et")
                // when the row got tight, which also made the row taller
                // than anything laying it out could predict.
                HStack(spacing: Spacing.half) {
                    Text(Format.arrivalTime(stop.arrival))
                    Text("·")
                    Text("\(stop.durationMinutes) min")
                    TagPill(
                        label: stop.choice == "garage" ? "Garage" : "Street",
                        color: stop.choice == "garage" ? .sky : .actionCoralLink
                    )
                    .fixedSize()
                    if stop.paymentSource == "link_wallet" {
                        TagPill(label: "Link", color: .actionCoralLink)
                            .fixedSize()
                    }
                }
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .lineLimit(1)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            // "≈": the server carried an earlier price over (no set time,
            // or it couldn't quote the new one).
            Text(stop.estimate == true ? "≈ \(Format.money(stop.costUsd))" : Format.money(stop.costUsd))
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
            if onEdit != nil {
                Menu {
                    Button("Edit stop") { onEdit?() }
                    if let onMoveUp, !isFirst { Button("Move up", action: onMoveUp) }
                    if let onMoveDown, !isLast { Button("Move down", action: onMoveDown) }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Color.textSecondary)
                }
                .accessibilityIdentifier("assistant.stopMenu.\(stop.id)")
                .accessibilityLabel("\(stop.label) stop actions")
            }
        }
        .padding(.horizontal, Spacing.unit)
        .padding(.vertical, Spacing.half)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistant.stopRow.\(stop.id)")
        // Untimed rows drag to reorder in the plan card; the menu's Move
        // up/down does the same job for VoiceOver and UI tests.
        .contentShape(Rectangle())
    }
}

/// Edit one stop: its time (or none), duration, street/garage choice.
/// The time is time-of-day only — the itinerary is one day, so a stop
/// keeps its date. Saving re-sorts the day (the caller normalizes).
struct StopEditSheet: View {
    @State private var stop: ItineraryStop
    @State private var hasTime: Bool
    @State private var time: Date
    private let originalTime: Date?
    let onSave: (ItineraryStop) -> Void
    @Environment(\.dismiss) private var dismiss

    /// `day` is the itinerary's date: where a time lands on a stop that had
    /// none.
    init(stop: ItineraryStop, day: String, onSave: @escaping (ItineraryStop) -> Void) {
        let original = ItineraryOrder.arrival(of: stop)
        _stop = State(initialValue: stop)
        _hasTime = State(initialValue: original != nil)
        _time = State(initialValue: original ?? Format.noon(onPlanDay: day) ?? AppClock.now)
        originalTime = original
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Set a time", isOn: $hasTime)
                        .accessibilityIdentifier("stopEdit.hasTime")
                    if hasTime {
                        // Wheels, not the compact button: they stay on
                        // screen in a medium sheet and are what UI tests
                        // can turn deterministically.
                        DatePicker("Arrival", selection: $time, displayedComponents: .hourAndMinute)
                            .datePickerStyle(.wheel)
                            .labelsHidden()
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("stopEdit.arrival")
                    }
                    Stepper(
                        "Duration: \(stop.durationMinutes) min",
                        value: $stop.durationMinutes,
                        in: 15...720,
                        step: 15
                    )
                    .accessibilityIdentifier("stopEdit.duration")
                } header: {
                    Text("Timing")
                } footer: {
                    Text(hasTime
                        ? "Stops run in time order, so a new time moves this stop to its place."
                        : "With no set time, you place this stop yourself — drag it, or use Move up and Move down.")
                }
                Section("Stop") {
                    TextField("Label", text: $stop.label)
                        .accessibilityIdentifier("stopEdit.label")
                    TextField("Address", text: $stop.address)
                }
                Section("Parking") {
                    Picker("Type", selection: $stop.choice) {
                        Text("Street").tag("street")
                        Text("Garage").tag("garage")
                    }
                    .pickerStyle(.segmented)
                }
            }
            .navigationTitle("Edit stop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        var saved = stop
                        if !hasTime {
                            saved.arrival = nil
                        } else if time != originalTime {
                            // Rewritten only when it changed, so an
                            // untouched stop still equals the one proposed.
                            saved.arrival = Format.arrivalISO(time)
                        }
                        onSave(saved)
                        dismiss()
                    }
                    .accessibilityIdentifier("stopEdit.save")
                }
            }
        }
    }
}
