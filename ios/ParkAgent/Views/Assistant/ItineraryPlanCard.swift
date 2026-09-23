import MapKit
import SwiftUI

/// Itinerary plan: numbered stops on a map, an editable/reorderable
/// list with per-stop cost, the day total against the cap, and ONE
/// Sign off button.
struct ItineraryPlanCard: View {
    let plan: ItineraryPlan
    let confirming: Bool
    let linkConnected: Bool
    let onSignOff: ([ItineraryStop]) -> Void

    @State private var stops: [ItineraryStop] = []
    @State private var editingStop: ItineraryStop?

    private var totalUsd: Double {
        (stops.reduce(0) { $0 + $1.costUsd } * 100).rounded() / 100
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            ItineraryMap(stops: stops)
                .frame(height: 180)
                .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))

            VStack(spacing: 0) {
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    ItineraryStopRow(
                        index: index + 1,
                        stop: stop,
                        isFirst: index == 0,
                        isLast: index == stops.count - 1,
                        onEdit: { editingStop = stop },
                        onMoveUp: { move(stop, by: -1) },
                        onMoveDown: { move(stop, by: 1) }
                    )
                    if index < stops.count - 1 { Divider() }
                }
            }
            .cardStyle()

            totalRow

            Button(confirming ? "Signing off…" : "Sign off — \(Format.money(totalUsd)) day") {
                onSignOff(stops)
            }
            .buttonStyle(.primary)
            .disabled(confirming || totalUsd > plan.capUsd)
            .accessibilityIdentifier("assistant.signOffButton")

            if linkConnected {
                HStack(spacing: Spacing.quarter) {
                    Image(systemName: "link.circle.fill")
                    Text("Paying with your Link wallet — you'll approve each paid stop")
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
        .onAppear { if stops.isEmpty { stops = plan.stops } }
        .sheet(item: $editingStop) { stop in
            StopEditSheet(stop: stop) { edited in
                if let index = stops.firstIndex(where: { $0.id == edited.id }) {
                    stops[index] = edited
                }
            }
            .presentationDetents([.medium])
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.itineraryPlan")
    }

    private var totalRow: some View {
        let over = totalUsd > plan.capUsd
        return HStack {
            Text("Day total")
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textSecondary)
                .textCase(.uppercase)
            Spacer()
            Text("\(Format.money(totalUsd)) of \(Format.money(plan.capUsd))")
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(over ? Color.danger : Color.textPrimary)
                .accessibilityIdentifier("assistant.dayTotal")
        }
    }

    private func move(_ stop: ItineraryStop, by offset: Int) {
        guard let index = stops.firstIndex(where: { $0.id == stop.id }) else { return }
        let target = index + offset
        guard stops.indices.contains(target) else { return }
        withAnimation { stops.swapAt(index, target) }
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
                HStack(spacing: Spacing.half) {
                    Text(Format.arrivalTime(stop.arrival))
                    Text("·")
                    Text("\(stop.durationMinutes) min")
                    TagPill(
                        label: stop.choice == "garage" ? "Garage" : "Street",
                        color: stop.choice == "garage" ? .sky : .actionCoralLink
                    )
                    if stop.paymentSource == "link_wallet" {
                        TagPill(label: "Link", color: .actionCoralLink)
                    }
                }
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            Text(Format.money(stop.costUsd))
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
            if onEdit != nil {
                Menu {
                    Button("Edit stop") { onEdit?() }
                    if !isFirst { Button("Move up") { onMoveUp?() } }
                    if !isLast { Button("Move down") { onMoveDown?() } }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Color.textSecondary)
                }
                .accessibilityIdentifier("assistant.stopMenu.\(stop.id)")
                .accessibilityLabel("\(stop.label) stop actions")
            }
        }
        .padding(Spacing.unit)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistant.stopRow.\(stop.id)")
        // Drag-to-reorder lives on the List variant (Home's day view);
        // inside the chat card the menu's Move up/down does the same job
        // deterministically.
        .contentShape(Rectangle())
    }
}

/// Edit one stop: arrival, duration, street/garage choice.
struct StopEditSheet: View {
    @State var stop: ItineraryStop
    let onSave: (ItineraryStop) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Stop") {
                    TextField("Label", text: $stop.label)
                        .accessibilityIdentifier("stopEdit.label")
                    TextField("Address", text: $stop.address)
                }
                Section("Timing") {
                    DatePicker(
                        "Arrival",
                        selection: Binding(
                            get: { Format.parseArrival(stop.arrival) ?? .now },
                            set: { stop.arrival = Format.arrivalISO($0) }
                        ),
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    Stepper(
                        "Duration: \(stop.durationMinutes) min",
                        value: $stop.durationMinutes,
                        in: 15...720,
                        step: 15
                    )
                    .accessibilityIdentifier("stopEdit.duration")
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
                        onSave(stop)
                        dismiss()
                    }
                    .accessibilityIdentifier("stopEdit.save")
                }
            }
        }
    }
}
