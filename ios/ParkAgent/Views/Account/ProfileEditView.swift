import SwiftUI

/// Name and phone. The email is shown but not editable here — it is the
/// sign-in identity, and changing it would need its own verification flow.
struct ProfileEditView: View {
    @Environment(AppModel.self) private var model
    @Environment(AuthStore.self) private var authStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var phone = ""
    @State private var loaded = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("Name") {
                TextField("Your name", text: $name)
                    .textContentType(.name)
                    .accessibilityIdentifier("profile.nameField")
            }
            Section {
                TextField("Phone (optional)", text: $phone)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                    .accessibilityIdentifier("profile.phoneField")
            } header: {
                Text("Phone")
            } footer: {
                Text("Used to prefill your parking provider's sign-up page. We never share it.")
            }
            Section {
                LabeledContent("Email", value: authStore.user?.email ?? "—")
                    .accessibilityIdentifier("profile.emailRow")
            } header: {
                Text("Account")
            } footer: {
                Text("From your Apple ID when you signed in. If you chose Hide My Email, this is the private address Apple forwards to you.")
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .accessibilityIdentifier("profile.errorLabel")
            }
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") {
                    Task { await save() }
                }
                .disabled(isSaving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("profile.saveButton")
            }
        }
        .task {
            guard !loaded else { return }
            loaded = true
            name = authStore.user?.name ?? ""
            phone = authStore.user?.phone ?? ""
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("profile.view")
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        let trimmedPhone = phone.trimmingCharacters(in: .whitespaces)
        do {
            let updated = try await model.api.updateMe(
                name: name.trimmingCharacters(in: .whitespaces),
                phone: trimmedPhone.isEmpty ? nil : trimmedPhone
            )
            authStore.update(user: updated)
            isSaving = false
            dismiss()
        } catch {
            isSaving = false
            errorMessage = (error as? APIError)?.errorDescription ?? "Couldn't save. Try again."
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack { ProfileEditView() }
        .environment(AppModel())
        .environment(AuthStore())
}
#endif
