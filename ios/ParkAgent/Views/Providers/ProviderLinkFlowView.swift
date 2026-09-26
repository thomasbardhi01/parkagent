import SwiftUI

/// The provider link flow presented on its own (Settings re-link, the
/// parked sheet's "Link <provider>", the provider_relink push). Onboarding
/// embeds `ProviderLinkStagesView` directly as step 5 instead.
struct ProviderLinkFlowView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var link: ProviderLinkModel
    /// Called on Done after a finished link, so the presenter can refresh
    /// (re-offer Pay, reload Settings rows). Not when the user moved on
    /// while it ran: nothing is linked yet, and the outcome comes by push.
    var onLinked: (() -> Void)?

    init(providerId: String, onLinked: (() -> Void)? = nil) {
        _link = State(initialValue: ProviderLinkModel(providerId: providerId))
        self.onLinked = onLinked
    }

    var body: some View {
        NavigationStack {
            ProviderLinkStagesView(link: link) {
                if case .done = link.stage { onLinked?() }
                dismiss()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.appBackground)
            .navigationTitle(link.provider?.displayName ?? "Link account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("link.cancelButton")
                }
            }
        }
        // No container identifier: it would swallow the stage containers
        // (link.intro, link.done, …) the tests key off.
        // Mid-link, leaving is by Continue (after 20 s) or Cancel — both
        // ask for the outcome by push; a stray swipe shouldn't.
        .interactiveDismissDisabled(link.stage == .verifying || link.stage == .addingCard)
    }
}

/// The stages themselves: consent → the provider's own login page →
/// progress while the server verifies and adds the card → done or a
/// plain-words failure with retry.
struct ProviderLinkStagesView: View {
    @Environment(AppModel.self) private var model
    @Bindable var link: ProviderLinkModel
    let onDone: () -> Void

    var body: some View {
        content
            .task { await link.load(api: model.api) }
            // Closed mid-link (Cancel, a swipe once allowed): the job runs
            // on server-side, so ask for its outcome by push and stop
            // polling for a screen nobody is looking at.
            .onDisappear {
                guard link.stage == .verifying || link.stage == .addingCard else { return }
                Task { await link.continueInBackground(api: model.api) }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch link.stage {
        case .loading:
            ProgressView()
        case .unavailable:
            unavailable
        case .intro:
            LinkIntroView(link: link) { creatingAccount in
                link.startSignIn(api: model.api, creatingAccount: creatingAccount)
            }
        case .signIn:
            signIn
        case .verifying, .addingCard:
            LinkProgressView(link: link, providerName: providerName) {
                Task { await link.continueInBackground(api: model.api) }
            }
        case .continuingInBackground:
            LinkContinuingView(providerName: providerName, onDone: onDone)
        case .done(let dryRun):
            LinkDoneView(
                providerName: providerName,
                cardSetUp: link.consentCardSetup,
                providerCard: link.providerCard,
                dryRun: dryRun,
                onDone: onDone
            )
        case .failed(let reason, _):
            LinkFailedView(reason: reason) {
                Task { await link.retry(api: model.api) }
            }
        }
    }

    private var providerName: String {
        link.provider?.displayName ?? "the provider"
    }

    private var unavailable: some View {
        VStack(spacing: Spacing.unit) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(Color.textSecondary)
            Text("Couldn't reach the server")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("Linking needs the server. Check the connection and come back.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityIdentifier("link.unavailable")
    }

    @ViewBuilder
    private var signIn: some View {
        if let provider = link.provider {
            #if DEBUG
            if model.useMockAPI {
                MockProviderLoginView(provider: provider, creatingAccount: link.creatingAccount) {
                    Task {
                        await link.cookiesCaptured(
                            MockFixtures.linkCookies(for: provider.id),
                            api: model.api
                        )
                    }
                }
            } else {
                webLogin(provider)
            }
            #else
            webLogin(provider)
            #endif
        }
    }

    @ViewBuilder
    private func webLogin(_ provider: ProviderAccountStatus) -> some View {
        if let url = link.startURL(creatingAccount: link.creatingAccount) {
            ProviderLoginWebView(
                url: url,
                cookieDomains: provider.cookieDomains,
                // Types what we already know into the provider's empty
                // text inputs; codes, PINs, terms, and captcha stay the
                // user's (ProviderSignupPrefill.swift).
                prefillScript: link.prefillScript()
            ) { cookies in
                Task { await link.cookiesCaptured(cookies, api: model.api) }
            }
            .ignoresSafeArea(edges: .bottom)
        } else {
            unavailable
        }
    }
}

/// Step one: what is about to happen, the card consent, and — for anyone
/// without an account yet — the sign-up door. Both doors lead to the
/// provider's own page; only the starting URL and the wording differ.
private struct LinkIntroView: View {
    @Bindable var link: ProviderLinkModel
    /// `true` when the user says they have no account yet.
    let onContinue: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "link.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.actionCoral)
            Text("Connect \(providerName)")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text(oneLiner)
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("link.introNote")

            if !link.prefill.isEmpty {
                prefillNote
            }

            if link.usesParkAgentCard {
                consentRow
            } else {
                providerCardNote
            }

            Spacer()
            Button(primaryLabel) { onContinue(false) }
                .buttonStyle(.primary)
                .accessibilityIdentifier("link.continueButton")
            // Passport's sign-in and sign-up are one screen, so a second
            // button there would be a lie. ParkNYC gets a real one.
            if !isPasswordless {
                Button("I don't have an account yet") { onContinue(true) }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("link.createAccountButton")
            }
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link.intro")
    }

    private var providerName: String {
        link.provider?.displayName ?? "your provider"
    }

    private var isPasswordless: Bool {
        link.provider?.signup?.isPasswordless ?? false
    }

    private var primaryLabel: String {
        isPasswordless ? "Continue" : "I have an account"
    }

    /// One sentence, from the server registry when it sent one.
    private var oneLiner: String {
        link.provider?.signup?.note
            ?? "You'll sign in on \(providerName)'s own page. We never see your password — only the signed-in session, which stays sealed on the server."
    }

    private var prefillNote: some View {
        HStack(alignment: .top, spacing: Spacing.unit) {
            Image(systemName: "wand.and.sparkles")
                .font(.system(size: 22))
                .foregroundStyle(Color.textSecondary)
            Text("We'll fill in what we already know. You'll finish the code, terms, and anything else yourself.")
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
                .multilineTextAlignment(.leading)
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityIdentifier("link.prefillNote")
    }

    private var consentRow: some View {
        Button {
            link.consentCardSetup.toggle()
        } label: {
            HStack(alignment: .top, spacing: Spacing.unit) {
                Image(systemName: link.consentCardSetup ? "checkmark.square.fill" : "square")
                    .font(.system(size: 22))
                    .foregroundStyle(link.consentCardSetup ? Color.actionCoralLink : Color.textSecondary)
                Text("Use my ParkAgent card for parking (replaces any card on your \(providerName) account)")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textPrimary)
                    .multilineTextAlignment(.leading)
            }
            .padding(Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("link.consentToggle")
        .accessibilityValue(link.consentCardSetup ? "checked" : "unchecked")
    }

    /// provider_card users: nothing on the account changes — say so instead
    /// of asking for card-replacement consent.
    private var providerCardNote: some View {
        HStack(alignment: .top, spacing: Spacing.unit) {
            Image(systemName: "creditcard")
                .font(.system(size: 22))
                .foregroundStyle(Color.textSecondary)
            Text("The card already saved on your \(providerName) account keeps paying. We never change it.")
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
                .multilineTextAlignment(.leading)
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityIdentifier("link.providerCardNote")
    }
}

/// Verifying the sign-in, then adding the card — one quiet progress screen.
/// While the link job runs: its real step, how long it's been, its place
/// in line or its attempt, and — past 20 seconds — a way to move on.
private struct LinkProgressView: View {
    @Bindable var link: ProviderLinkModel
    let providerName: String
    let onContinue: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let elapsed = link.startedAt.map { max(0, context.date.timeIntervalSince($0)) } ?? 0
            VStack(spacing: Spacing.unit) {
                Spacer()
                ProgressView()
                    .controlSize(.large)
                Text(link.stepText(providerName: providerName))
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("link.progress.step")
                if let detail = LinkProgressCopy.detail(link.progress, providerName: providerName) {
                    Text(detail)
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("link.progress.detail")
                }
                Text(LinkProgressCopy.elapsed(elapsed))
                    .font(.captionText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("link.progress.elapsed")
                Spacer()
                if elapsed >= ProviderLinkModel.continueAfter {
                    Text("This is taking longer than usual. You can keep going; ParkAgent will let you know when \(providerName) is connected.")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .multilineTextAlignment(.center)
                    Button("Continue — we'll let you know", action: onContinue)
                        .buttonStyle(.secondary)
                        .accessibilityIdentifier("link.continueInBackground")
                }
            }
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link.progress")
    }
}

/// The user moved on: the job runs on, and a push will say how it went.
private struct LinkContinuingView: View {
    let providerName: String
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "bell.badge")
                .font(.system(size: 48))
                .foregroundStyle(Color.textSecondary)
            Text("We'll let you know")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("ParkAgent keeps connecting \(providerName) and sends a notification when it's done — or says what went wrong.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("OK", action: onDone)
                .buttonStyle(.primary)
                .accessibilityIdentifier("link.continuingDone")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link.continuing")
    }
}

/// The link job's steps in plain words (one place, so the flow and its
/// tests agree).
enum LinkProgressCopy {
    static func step(_ status: LinkStatusResponse?, providerName: String, addingCard: Bool) -> String {
        if addingCard { return "Adding your ParkAgent card…" }
        switch status?.phase {
        case "queued" where (status?.queuePosition ?? 0) > 0:
            return "Waiting for a free spot…"
        case "reading_card":
            return "Reading your card…"
        case "adding_card":
            return "Adding your ParkAgent card…"
        case "retrying":
            return "\(providerName) is slow — trying again…"
        default:
            return "Checking your \(providerName) sign-in…"
        }
    }

    static func detail(_ status: LinkStatusResponse?, providerName: String) -> String? {
        guard let status else { return nil }
        if status.phase == "queued", let ahead = status.queuePosition, ahead > 0 {
            return ahead == 1 ? "1 ahead of you." : "\(ahead) ahead of you."
        }
        if status.phase == "retrying", let attempt = status.attempt, let max = status.maxAttempts {
            return "Attempt \(attempt + 1) of \(max) starts shortly."
        }
        if status.phase == "reading_card" {
            return "\(providerName) is connected. Looking up the card saved there."
        }
        return nil
    }

    static func elapsed(_ seconds: TimeInterval) -> String {
        "\(Int(seconds)) s"
    }
}

private struct LinkDoneView: View {
    let providerName: String
    let cardSetUp: Bool
    /// "Visa ••4242" when we could read the provider account's own card.
    let providerCard: String?
    let dryRun: Bool
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.success)
            Text("\(providerName) is connected")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text(doneDetail)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("link.doneDetail")
            if dryRun {
                Text("Dry run — the provider account was not touched.")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            Button("Done") { onDone() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("link.doneButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link.done")
    }

    /// Say which card will actually be charged when we know it — that is
    /// the one thing someone wants confirmed after connecting.
    private var doneDetail: String {
        if cardSetUp {
            return "Your ParkAgent card now pays for parking there."
        }
        if let providerCard {
            return "\(providerCard) on your \(providerName) account keeps paying. We never change it."
        }
        return "The card on your \(providerName) account keeps paying. We never change it."
    }
}

private struct LinkFailedView: View {
    let reason: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.warningGold)
            Text("That didn't finish")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text(reason)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("link.reasonLabel")
            Spacer()
            Button("Try again") { onRetry() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("link.retryButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link.failed")
    }
}

#if DEBUG
/// Stand-in for the provider's login page when the mock API is active, so
/// the whole flow is walkable on the simulator and in UI tests.
private struct MockProviderLoginView: View {
    let provider: ProviderAccountStatus
    let creatingAccount: Bool
    let onSignIn: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "globe")
                .font(.system(size: 44))
                .foregroundStyle(Color.textSecondary)
            Text("\(provider.displayName) \(creatingAccount ? "sign-up" : "sign-in") (mock)")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
                .accessibilityIdentifier("link.mockTitle")
            Text("The real flow opens \(startURL) in a web view, prefills what we know, and captures the session cookies once you're signed in.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button(creatingAccount ? "Create account" : "Sign in") { onSignIn() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("link.mockSignInButton")
        }
        .padding(Spacing.unitAndHalf)
    }

    private var startURL: String {
        creatingAccount ? (provider.signup?.url ?? provider.loginUrl) : provider.loginUrl
    }
}
#endif

#if DEBUG
#Preview {
    ProviderLinkFlowView(providerId: "parknyc")
        .environment(AppModel())
}
#endif
