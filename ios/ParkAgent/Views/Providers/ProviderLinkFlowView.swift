import SwiftUI

/// The provider link flow presented on its own (Settings re-link, the
/// parked sheet's "Link <provider>", the provider_relink push). Onboarding
/// embeds `ProviderLinkStagesView` directly as step 5 instead.
struct ProviderLinkFlowView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var link: ProviderLinkModel
    /// Called on Done so the presenter can refresh (re-offer Pay, reload
    /// Settings rows).
    var onLinked: (() -> Void)?

    init(providerId: String, onLinked: (() -> Void)? = nil) {
        _link = State(initialValue: ProviderLinkModel(providerId: providerId))
        self.onLinked = onLinked
    }

    var body: some View {
        NavigationStack {
            ProviderLinkStagesView(link: link) {
                onLinked?()
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
    }

    @ViewBuilder
    private var content: some View {
        switch link.stage {
        case .loading:
            ProgressView()
        case .unavailable:
            unavailable
        case .intro:
            LinkIntroView(link: link) {
                link.startSignIn(api: model.api)
            }
        case .signIn:
            signIn
        case .verifying, .addingCard:
            LinkProgressView(stage: link.stage, providerName: providerName)
        case .done(let dryRun):
            LinkDoneView(
                providerName: providerName,
                cardSetUp: link.consentCardSetup,
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
            if model.useMockAPI {
                MockProviderLoginView(provider: provider) {
                    Task {
                        await link.cookiesCaptured(
                            MockFixtures.linkCookies(for: provider.id),
                            api: model.api
                        )
                    }
                }
            } else if let url = URL(string: provider.loginUrl) {
                ProviderLoginWebView(url: url, cookieDomains: provider.cookieDomains) { cookies in
                    Task { await link.cookiesCaptured(cookies, api: model.api) }
                }
                .ignoresSafeArea(edges: .bottom)
            } else {
                unavailable
            }
        }
    }
}

/// Step one: what is about to happen, and the card consent.
private struct LinkIntroView: View {
    @Bindable var link: ProviderLinkModel
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "link.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.actionCoral)
            Text("Sign in to \(providerName)")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("You'll sign in on \(providerName)'s own page. We never see your password — only the signed-in session, which stays sealed on the server.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)

            if link.usesParkAgentCard {
                consentRow
            } else {
                providerCardNote
            }

            Spacer()
            Button("Continue") { onContinue() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("link.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link.intro")
    }

    private var providerName: String {
        link.provider?.displayName ?? "your provider"
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
private struct LinkProgressView: View {
    let stage: ProviderLinkModel.Stage
    let providerName: String

    var body: some View {
        VStack(spacing: Spacing.unit) {
            ProgressView()
                .controlSize(.large)
            Text(stage == .verifying ? "Checking your sign-in" : "Adding your card")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text(stage == .verifying
                ? "Making sure \(providerName) recognizes the session."
                : "Putting your ParkAgent card on the \(providerName) account. This takes a few seconds.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link.progress")
    }
}

private struct LinkDoneView: View {
    let providerName: String
    let cardSetUp: Bool
    let dryRun: Bool
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.success)
            Text("\(providerName) is linked")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text(cardSetUp
                ? "Your ParkAgent card now pays for parking there."
                : "Linked without changing the account's payment method.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
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

/// Stand-in for the provider's login page when the mock API is active, so
/// the whole flow is walkable on the simulator and in UI tests.
private struct MockProviderLoginView: View {
    let provider: ProviderAccountStatus
    let onSignIn: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "globe")
                .font(.system(size: 44))
                .foregroundStyle(Color.textSecondary)
            Text("\(provider.displayName) sign-in (mock)")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("The real flow opens \(provider.loginUrl) in a web view and captures the session cookies once you sign in.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Sign in") { onSignIn() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("link.mockSignInButton")
        }
        .padding(Spacing.unitAndHalf)
    }
}

#Preview {
    ProviderLinkFlowView(providerId: "parknyc")
        .environment(AppModel())
}
