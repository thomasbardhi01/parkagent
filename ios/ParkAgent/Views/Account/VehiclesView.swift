import SwiftUI

/// The garage: add, edit, remove. A plate is global on the server (one
/// car, one account), so a duplicate comes back as a plain refusal rather
/// than a silent no-op.
struct VehiclesView: View {
    @Environment(AppModel.self) private var model

    @State private var vehicles: [VehicleSummary] = []
    @State private var loaded = false
    @State private var editing: VehicleSummary?
    @State private var addingVehicle = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                if vehicles.isEmpty && loaded {
                    Text("No cars yet.")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                        .accessibilityIdentifier("vehicles.empty")
                }
                ForEach(vehicles) { vehicle in
                    Button {
                        editing = vehicle
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: Spacing.quarter) {
                                Text(vehicle.plate)
                                    .font(.bodyTextSemibold)
                                    .foregroundStyle(Color.textPrimary)
                                Text(vehicle.label.map { "\($0) · \(vehicle.state)" } ?? vehicle.state)
                                    .font(.captionText)
                                    .foregroundStyle(Color.textSecondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.captionText)
                                .foregroundStyle(Color.textSecondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("vehicles.row.\(vehicle.plate)")
                }
                .onDelete { offsets in
                    Task { await remove(at: offsets) }
                }
            } header: {
                Text("Your cars")
            } footer: {
                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(Color.warningGold)
                        .accessibilityIdentifier("vehicles.errorLabel")
                } else {
                    Text("Swipe a car to remove it. Past sessions keep their history.")
                }
            }

            Section {
                Button("Add a car") { addingVehicle = true }
                    .foregroundStyle(Color.actionCoralLink)
                    .accessibilityIdentifier("vehicles.addButton")
            }
        }
        .navigationTitle("Vehicles")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !loaded else { return }
            await reload()
            loaded = true
        }
        .sheet(isPresented: $addingVehicle) {
            VehicleEditorView(vehicle: nil) { await reload() }
        }
        .sheet(item: $editing) { vehicle in
            VehicleEditorView(vehicle: vehicle) { await reload() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("vehicles.view")
    }

    private func reload() async {
        vehicles = (try? await model.api.vehicles()) ?? []
    }

    private func remove(at offsets: IndexSet) async {
        errorMessage = nil
        // Resolve to vehicles before any await: an async reload between
        // iterations would invalidate the indices mid-loop.
        let doomed = offsets.compactMap { vehicles.indices.contains($0) ? vehicles[$0] : nil }
        for vehicle in doomed {
            do {
                try await model.api.removeVehicle(id: vehicle.id)
            } catch {
                errorMessage = (error as? APIError)?.errorDescription ?? "Couldn't remove that car."
            }
        }
        await reload()
    }
}

/// Add or edit one car.
struct VehicleEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let vehicle: VehicleSummary?
    let onSaved: () async -> Void

    @State private var plate = ""
    @State private var state = ""
    @State private var label = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var isValid: Bool {
        let trimmedPlate = plate.trimmingCharacters(in: .whitespaces)
        return (2...8).contains(trimmedPlate.count)
            && state.trimmingCharacters(in: .whitespaces).count == 2
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Plate", text: $plate)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("vehicleEditor.plateField")
                    TextField("State (2 letters)", text: $state)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("vehicleEditor.stateField")
                    TextField("Nickname (optional)", text: $label)
                        .accessibilityIdentifier("vehicleEditor.labelField")
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(Color.warningGold)
                            .accessibilityIdentifier("vehicleEditor.errorLabel")
                    }
                }
            }
            .navigationTitle(vehicle == nil ? "Add a car" : "Edit car")
            .navigationBarTitleDisplayMode(.inline)
            .tint(.actionCoral)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("vehicleEditor.cancelButton")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        Task { await save() }
                    }
                    .disabled(!isValid || isSaving)
                    .accessibilityIdentifier("vehicleEditor.saveButton")
                }
            }
            .task {
                plate = vehicle?.plate ?? ""
                state = vehicle?.state ?? ""
                label = vehicle?.label ?? ""
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("vehicleEditor.view")
        }
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        let trimmedLabel = label.trimmingCharacters(in: .whitespaces)
        do {
            if let vehicle {
                _ = try await model.api.updateVehicle(
                    id: vehicle.id,
                    plate: plate.trimmingCharacters(in: .whitespaces),
                    state: state.trimmingCharacters(in: .whitespaces),
                    label: trimmedLabel.isEmpty ? nil : trimmedLabel
                )
            } else {
                _ = try await model.api.addVehicle(
                    plate: plate.trimmingCharacters(in: .whitespaces),
                    state: state.trimmingCharacters(in: .whitespaces),
                    label: trimmedLabel.isEmpty ? nil : trimmedLabel
                )
            }
            await onSaved()
            isSaving = false
            dismiss()
        } catch {
            isSaving = false
            errorMessage = (error as? APIError)?.errorDescription ?? "Couldn't save that car."
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack { VehiclesView() }
        .environment(AppModel())
}
#endif
