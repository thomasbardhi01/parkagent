import SwiftUI

/// The signed-off day on Home: live status per stop (linked session,
/// pushed garage link, upcoming), drag-to-reorder in edit mode, PATCHes
/// edits back to the server.
struct ItineraryDaySection: View {
    @Environment(AppModel.self) private var model
    let day: ItinerarySummary
    @State private var stops: [ItineraryStop] = []
    @State private var editing = false
    @State private var editingStop: ItineraryStop?
    @State private var saveError = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack {
                Text("Today's plan")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
                    .textCase(.uppercase)
                    .accessibilityIdentifier("home.dayHeader")
                Spacer()
                Text(Format.money(day.totalUsd))
                    .font(.secondaryText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
                Button(editing ? "Done" : "Edit") {
                    if editing { Task { await save() } }
                    editing.toggle()
                }
                .font(.captionTextSemibold)
                .foregroundStyle(Color.actionCoralLink)
                // 44pt target for a caption-sized label.
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("home.dayEditButton")
            }

            if editing {
                List {
                    ForEach(stops) { stop in
                        row(stop)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                    .onMove { from, to in
                        stops.move(fromOffsets: from, toOffset: to)
                    }
                }
                .listStyle(.plain)
                .environment(\.editMode, .constant(.active))
                .frame(height: CGFloat(stops.count) * 74)
                .accessibilityIdentifier("home.dayEditList")
            } else {
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    HStack(spacing: Spacing.half) {
                        statusIcon(stop)
                        ItineraryStopRow(
                            index: index + 1,
                            stop: stop,
                            isFirst: index == 0,
                            isLast: index == stops.count - 1,
                            onEdit: nil,
                            onMoveUp: nil,
                            onMoveDown: nil
                        )
                    }
                }
            }
            if saveError {
                Text("Couldn't save the change — the day is unchanged on the server.")
                    .font(.captionText)
                    .foregroundStyle(Color.danger)
            }
        }
        .onAppear { stops = day.stops }
        .onChange(of: day.stops) { stops = day.stops }
        .sheet(item: $editingStop) { stop in
            StopEditSheet(stop: stop) { edited in
                if let index = stops.firstIndex(where: { $0.id == edited.id }) {
                    stops[index] = edited
                }
                Task { await save() }
            }
            .presentationDetents([.medium])
        }
        // No container identifier: this VStack sits inside home.view's
        // .contain element, which flattens nested containers — tests pin
        // the leaves (home.dayHeader, home.dayStop.*) instead.
    }

    private func row(_ stop: ItineraryStop) -> some View {
        HStack {
            Text(stop.label)
                .font(.bodyText)
                .foregroundStyle(Color.textPrimary)
            Spacer()
            Text(Format.money(stop.costUsd))
                .font(.secondaryText)
                .monospacedDigit()
                .foregroundStyle(Color.textSecondary)
            Button("Edit") { editingStop = stop }
                .font(.captionTextSemibold)
                .foregroundStyle(Color.actionCoralLink)
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("home.stopEdit.\(stop.id)")
        }
        .padding(.vertical, Spacing.half)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("home.dayStop.\(stop.id)")
    }

    @ViewBuilder
    private func statusIcon(_ stop: ItineraryStop) -> some View {
        if stop.sessionId != nil {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.success)
        } else if stop.choice == "garage" && stop.garageLinkPushed {
            Image(systemName: "link.circle.fill").foregroundStyle(Color.actionCoralLink)
        } else {
            Image(systemName: "circle.dashed").foregroundStyle(Color.textSecondary)
        }
    }

    private func save() async {
        saveError = false
        do {
            let updated = try await model.api.patchItinerary(id: day.id, stops: stops)
            stops = updated.stops
            await model.refreshItineraries()
        } catch {
            saveError = true
            stops = day.stops
        }
    }
}

private extension ItineraryStop {
    /// The worker stamps garageLinkPushedAt server-side; the summary
    /// surfaces it through the stops JSON.
    var garageLinkPushed: Bool {
        garageLinkPushedAt != nil
    }
}
