import AuthenticationServices
import SwiftUI

/// The first screen anyone sees. Sign in with Apple is the primary action
/// and, by default, the only one. "Continue with email" (a 6-digit code
/// flow) appears only when the server reports it switched on (GET
/// /auth/methods). "Continue with Google" also needs a build that can mint
/// its token, which no build can yet (FeatureFlags.googleSignIn), so it is
/// test-only and absent from Release.
///
/// Sign-in and sign-up are the same act here — the server creates the
/// account on first use, so there is nothing to choose between.
struct WelcomeView: View {
    @Environment(AuthModel.self) private var auth
    @Environment(\.colorScheme) private var colorScheme
    @State private var emailPresented = false

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()

            Image(systemName: "parkingsign.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(Color.actionCoral)
                .accessibilityHidden(true)
            Text("ParkAgent")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("Park at a meter and ParkAgent notices, quotes the cost, and pays through your own parking account — within limits you set.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Spacing.unit)

            Spacer()

            if let reason = auth.signedOutReason {
                Text(reason)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("welcome.signedOutReason")
            }
            if let error = auth.errorMessage {
                Text(error)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("welcome.errorLabel")
            }

            appleButton

            if auth.methods.email {
                Button("Continue with email") { emailPresented = true }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("welcome.emailButton")
            }

            #if DEBUG
            // Test-only until the Google SDK ships (FeatureFlags.googleSignIn).
            if auth.methods.google && FeatureFlags.googleSignIn {
                Button("Continue with Google") {
                    Task { await auth.signInWithGoogle() }
                }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("welcome.googleButton")
            }
            #endif

            Text("We never see your parking provider's password.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.top, Spacing.quarter)
        }
        .padding(Spacing.unitAndHalf)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.appBackground)
        .sheet(isPresented: $emailPresented) {
            EmailSignInView()
                .presentationDetents([.medium, .large])
        }
        .task { await auth.loadMethods() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("welcome.view")
    }

    @ViewBuilder
    private var appleButton: some View {
        #if DEBUG
        if auth.usesMockSignIn {
            // The real ASAuthorization sheet is system UI and can't be
            // driven in UI tests; the mock path stands in for it.
            Button("Sign in with Apple") {
                Task { await auth.signInWithAppleMock() }
            }
            .buttonStyle(.primary)
            .accessibilityIdentifier("welcome.appleButton")
        } else {
            systemAppleButton
        }
        #else
        systemAppleButton
        #endif
    }

    private var systemAppleButton: some View {
        SignInWithAppleButton(.signIn) { request in
            request.requestedScopes = [.fullName, .email]
        } onCompletion: { result in
            auth.handleAppleCompletion(result)
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(height: 50)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityIdentifier("welcome.appleButton")
    }
}

/// The email code flow: address, then a 6-digit code with `.oneTimeCode`
/// autofill (iOS offers the code straight from the notification) and a
/// resend timer so nobody taps resend into a rate limit.
struct EmailSignInView: View {
    @Environment(AuthModel.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @FocusState private var codeFocused: Bool

    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var isWorking = false
    @State private var message: String?
    @State private var resendAfter = 0
    @State private var countdown: Task<Void, Never>?

    private var emailLooksValid: Bool {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        return trimmed.contains("@") && trimmed.contains(".") && trimmed.count >= 6
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Text(codeSent ? "Enter your code" : "Continue with email")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text(codeSent
                ? "We sent a 6-digit code to \(email). It expires in 10 minutes."
                : "We'll email you a 6-digit code. No password to remember.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("emailSignIn.subtitle")

            if codeSent {
                TextField("123456", text: $code)
                    .font(.numeral)
                    .monospacedDigit()
                    .keyboardType(.numberPad)
                    // The point of the whole flow: iOS fills this from the
                    // email without the user retyping anything.
                    .textContentType(.oneTimeCode)
                    .focused($codeFocused)
                    .padding(Spacing.unit)
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                    .accessibilityIdentifier("emailSignIn.codeField")
                    .onChange(of: code) { _, next in
                        code = String(next.filter(\.isNumber).prefix(6))
                        // Autofill delivers all six at once: verify without
                        // making the user find a button.
                        if code.count == 6 { Task { await verify() } }
                    }
            } else {
                TextField("you@example.com", text: $email)
                    .font(.bodyText)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(Spacing.unit)
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                    .accessibilityIdentifier("emailSignIn.emailField")
            }

            if let message {
                Text(message)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .accessibilityIdentifier("emailSignIn.messageLabel")
            }

            if codeSent {
                Button(resendAfter > 0 ? "Resend in \(resendAfter)s" : "Send a new code") {
                    Task { await send() }
                }
                .font(.captionTextSemibold)
                .foregroundStyle(resendAfter > 0 ? Color.textSecondary : Color.actionCoralLink)
                .disabled(resendAfter > 0 || isWorking)
                .accessibilityIdentifier("emailSignIn.resendButton")
            }

            Spacer()

            Button(primaryLabel) {
                Task { codeSent ? await verify() : await send() }
            }
            .buttonStyle(.primary)
            .disabled(isWorking || (codeSent ? code.count != 6 : !emailLooksValid))
            .accessibilityIdentifier("emailSignIn.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.appBackground)
        .onDisappear { stopTimer() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("emailSignIn.view")
    }

    private var primaryLabel: String {
        if isWorking { return codeSent ? "Checking…" : "Sending…" }
        return codeSent ? "Sign in" : "Send code"
    }

    private func send() async {
        isWorking = true
        message = nil
        let sent = await auth.startEmailSignIn(email: email.trimmingCharacters(in: .whitespaces))
        isWorking = false
        switch sent {
        case .success:
            codeSent = true
            code = ""
            codeFocused = true
            startResendTimer()
        case .failure(let error):
            message = error.errorDescription
        }
    }

    private func verify() async {
        guard !isWorking else { return }
        isWorking = true
        message = nil
        let result = await auth.verifyEmailSignIn(
            email: email.trimmingCharacters(in: .whitespaces),
            code: code
        )
        isWorking = false
        switch result {
        case .success:
            stopTimer()
            dismiss()
        case .failure(let error):
            message = error.errorDescription
            code = ""
        }
    }

    /// 30 seconds — long enough that the mail arrives first, short enough
    /// that a genuinely lost email isn't a dead end.
    private func startResendTimer() {
        stopTimer()
        resendAfter = 30
        countdown = Task {
            while !Task.isCancelled && resendAfter > 0 {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
                resendAfter -= 1
            }
        }
    }

    private func stopTimer() {
        countdown?.cancel()
        countdown = nil
    }
}

#if DEBUG
#Preview {
    WelcomeView()
        .environment(AuthModel(api: MockAPI(), store: AuthStore()))
}
#endif
