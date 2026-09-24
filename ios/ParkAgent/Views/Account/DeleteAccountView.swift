import SwiftUI

/// Deleting an account is irreversible, so it takes two deliberate steps:
/// read what goes, then type DELETE. The screen says plainly what survives
/// — the spending ledger, with the account's identity stripped off it.
struct DeleteAccountView: View {
    @Environment(AuthModel.self) private var auth
    @Environment(\.dismiss) private var dismiss

    @State private var confirmation = ""
    @State private var isDeleting = false
    @State private var errorMessage: String?

    private var canDelete: Bool {
        confirmation.trimmingCharacters(in: .whitespaces).uppercased() == "DELETE"
    }

    var body: some View {
        Form {
            Section {
                bullet("Your profile, cars, and devices are deleted.")
                bullet("Your parking accounts are disconnected and their stored sign-ins erased.")
                bullet("Any ParkAgent card is frozen.")
                bullet("Active sessions you've paid for run out as normal — we can't refund them.")
            } header: {
                Text("What happens")
            }

            Section {
                bullet("The record of what was spent, with your identity removed. We keep it because it's the audit trail for money that moved.")
            } header: {
                Text("What we keep")
            }

            Section {
                TextField("DELETE", text: $confirmation)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("deleteAccount.confirmField")
            } header: {
                Text("Type DELETE to confirm")
            } footer: {
                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(Color.warningGold)
                        .accessibilityIdentifier("deleteAccount.errorLabel")
                }
            }

            Section {
                Button(isDeleting ? "Deleting…" : "Delete my account") {
                    Task { await delete() }
                }
                .disabled(!canDelete || isDeleting)
                .foregroundStyle(canDelete ? Color.danger : Color.textSecondary)
                .accessibilityIdentifier("deleteAccount.confirmButton")
            }
        }
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("deleteAccount.view")
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.half) {
            Text("•")
                .foregroundStyle(Color.textSecondary)
            Text(text)
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
        }
    }

    private func delete() async {
        isDeleting = true
        errorMessage = nil
        switch await auth.deleteAccount() {
        case .success:
            // The root view swaps to the welcome screen on its own once the
            // store reports signed out; dismissing keeps the sheet tidy.
            isDeleting = false
            dismiss()
        case .failure(let error):
            isDeleting = false
            errorMessage = error.errorDescription ?? "Couldn't delete the account. Try again."
        }
    }
}

#Preview {
    NavigationStack { DeleteAccountView() }
        .environment(AuthModel(api: MockAPI(), store: AuthStore()))
}
