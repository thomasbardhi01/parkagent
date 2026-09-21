import SwiftUI

/// The sheet that appears when /parked comes back. One view, four shapes:
/// single quote (pay/confirm), two-candidate side selection, free period,
/// and unknown zone. A payment failure replaces the content in place.
struct ParkingDetectedSheet: View {
    @Environment(AppModel.self) private var model
    let parked: ParkedResponse

    @State private var selectedZoneId: String?
    @State private var manualZoneNumber = ""
    /// Presents the link flow from inside this sheet; set by the "Link
    /// <provider>" primary action or a provider_not_linked refusal.
    @State private var linkingProviderId: String?
    /// Set when the link flow finishes so Pay comes back without waiting
    /// for a fresh /parked (whose provider block is now stale).
    @State private var linkedInSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if let error = model.paymentError {
                if case .notImplemented = error {
                    SessionsNotBuiltView(dismiss: { model.dismissParkedSheet() })
                } else if case .refused(let code) = error, code == "provider_not_linked" {
                    // Same routing as an unlinked provider block: the fix
                    // is linking, not retrying the payment.
                    ProviderNotLinkedView(providerName: providerName) {
                        model.paymentError = nil
                        linkingProviderId = parked.provider?.id ?? "parknyc"
                    } dismiss: {
                        model.dismissParkedSheet()
                    }
                } else {
                    PaymentFailedView(
                        retry: { Task { await paySelected() } },
                        dismiss: { model.dismissParkedSheet() }
                    )
                }
            } else {
                content
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.appBackground)
        .interactiveDismissDisabled(model.isPaying)
        .fullScreenCover(
            isPresented: Binding(
                get: { linkingProviderId != nil },
                set: { if !$0 { linkingProviderId = nil } }
            )
        ) {
            ProviderLinkFlowView(providerId: linkingProviderId ?? "parknyc") {
                linkedInSheet = true
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("parkedSheet.view")
    }

    private var providerName: String {
        parked.provider?.displayName ?? "your parking account"
    }

    /// The provider needs linking before Pay makes sense.
    private var needsLink: Bool {
        guard let provider = parked.provider else { return false }
        return !provider.linked && !linkedInSheet
    }

    @ViewBuilder
    private var content: some View {
        switch parked.action {
        case .pay:
            singleQuote(reason: nil)
        case .confirm:
            if parked.candidates.count > 1 {
                twoCandidates
            } else {
                singleQuote(reason: confirmReason)
            }
        case .ignore:
            freePeriod
        case .unknownZone:
            unknownZone
        }
    }

    // MARK: - Single quote

    @ViewBuilder
    private func singleQuote(reason: String?) -> some View {
        if let candidate = parked.candidates.first, let quote = parked.quote {
            header("Parking detected")
            ZoneCard(
                zoneNumber: candidate.parknycZoneNumber,
                street: zoneSubtitle(candidate),
                rateFirstHourUsd: candidate.rateFirstHourUsd,
                rateAdditionalHourUsd: candidate.rateAdditionalHourUsd,
                maxStayMinutes: candidate.maxStayMinutes
            )
            if let reason {
                Label(reason, systemImage: "hand.raised")
                    .font(.secondaryText)
                    .foregroundStyle(Color.warningGold)
            }
            quoteSummary(quote)
            Spacer(minLength: 0)
            payButtons(for: candidate)
        }
    }

    // MARK: - Two candidates

    @ViewBuilder
    private var twoCandidates: some View {
        header("Which block did you park on?")
        Text("The two sides of this street have different terms.")
            .font(.secondaryText)
            .foregroundStyle(Color.textSecondary)
        ForEach(parked.candidates) { candidate in
            Button {
                selectedZoneId = candidate.zoneId
            } label: {
                ZoneCard(
                    zoneNumber: candidate.parknycZoneNumber,
                    street: zoneSubtitle(candidate),
                    rateFirstHourUsd: candidate.rateFirstHourUsd,
                    rateAdditionalHourUsd: candidate.rateAdditionalHourUsd,
                    maxStayMinutes: candidate.maxStayMinutes,
                    isSelected: candidate.zoneId == selectedZoneId
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("parkedSheet.candidate.\(candidate.parknycZoneNumber)")
        }
        Spacer(minLength: 0)
        if let selected = selectedCandidate {
            payButtons(for: selected)
        } else {
            // The whole point of this state is that the sides disagree, so
            // paying stays disabled until the user picks one.
            Button("Pay") {}
                .buttonStyle(.primary)
                .disabled(true)
                .accessibilityIdentifier("parkedSheet.payButton")
            dismissButton
        }
    }

    // MARK: - Free period

    @ViewBuilder
    private var freePeriod: some View {
        header("No payment needed")
        Label("Meters here are free right now", systemImage: "checkmark.circle.fill")
            .font(.bodyText)
            .foregroundStyle(Color.success)
        if let candidate = parked.candidates.first {
            ZoneCard(
                zoneNumber: candidate.parknycZoneNumber,
                street: zoneSubtitle(candidate),
                rateFirstHourUsd: candidate.rateFirstHourUsd,
                rateAdditionalHourUsd: candidate.rateAdditionalHourUsd,
                maxStayMinutes: candidate.maxStayMinutes
            )
        }
        Spacer(minLength: 0)
        Button("Done") { model.dismissParkedSheet() }
            .buttonStyle(.secondary)
    }

    // MARK: - Unknown zone

    @ViewBuilder
    private var unknownZone: some View {
        header("No meter zone found here")
        Text("If you can see a ParkNYC zone number on the meter, enter it to get a quote.")
            .font(.secondaryText)
            .foregroundStyle(Color.textSecondary)
        TextField("Zone number", text: $manualZoneNumber)
            .keyboardType(.numberPad)
            .font(.bodyText)
            .padding(Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .accessibilityIdentifier("parkedSheet.zoneField")
        Spacer(minLength: 0)
        Button("Get quote") {
            model.quoteForManualZone(zoneNumber: manualZoneNumber)
        }
        .buttonStyle(.primary)
        .disabled(manualZoneNumber.isEmpty)
        .accessibilityIdentifier("parkedSheet.getQuoteButton")
        dismissButton
    }

    // MARK: - Pieces

    private func header(_ title: String) -> some View {
        Text(title)
            .font(.bodyTextSemibold)
            .foregroundStyle(Color.textPrimary)
            .padding(.top, Spacing.half)
    }

    private func quoteSummary(_ quote: Quote) -> some View {
        VStack(alignment: .leading, spacing: Spacing.quarter) {
            Text(Format.money(quote.totalUsd))
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
                .accessibilityIdentifier("parkedSheet.total")
            Text("\(Format.minutes(quote.stayMinutes)) · \(Format.money(quote.meterUsd)) meter + \(Format.money(quote.feeUsd)) fee")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            if let provider = parked.provider {
                Text("Pays through \(provider.displayName)")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("parkedSheet.provider")
            }
            if parked.dryRun {
                Text("Dry run — no money moves")
                    .font(.captionTextSemibold)
                    // textSecondary, not slate: slate is fixed and drops to
                    // 2.7:1 on the dark sheet background.
                    .foregroundStyle(Color.textSecondary)
            }
        }
    }

    @ViewBuilder
    private func payButtons(for candidate: Candidate) -> some View {
        if needsLink {
            // Paying would 409 — the primary action becomes linking.
            Button("Link \(providerName)") {
                linkingProviderId = parked.provider?.id
            }
            .buttonStyle(.primary)
            .accessibilityIdentifier("parkedSheet.linkProviderButton")
        } else {
            Button("Pay \(Format.money(candidate.quote.totalUsd)) for \(Format.minutes(candidate.quote.stayMinutes))") {
                Task { await model.pay(candidate: candidate) }
            }
            .buttonStyle(.primary)
            .disabled(model.isPaying)
            .accessibilityIdentifier("parkedSheet.payButton")
        }
        dismissButton
    }

    private var dismissButton: some View {
        Button("Not parked here") { model.dismissParkedSheet() }
            .buttonStyle(.secondary)
            .disabled(model.isPaying)
            .accessibilityIdentifier("parkedSheet.dismissButton")
    }

    private func paySelected() async {
        guard let candidate = selectedCandidate ?? parked.candidates.first else { return }
        await model.pay(candidate: candidate)
    }

    private var selectedCandidate: Candidate? {
        parked.candidates.first { $0.zoneId == selectedZoneId }
    }

    /// The API carries no street names, so the subtitle is distance + hours.
    private func zoneSubtitle(_ candidate: Candidate) -> String {
        var parts = ["\(Format.distanceMeters(candidate.distanceM)) away"]
        if let hours = candidate.hours.first {
            parts.append("\(hours.start)–\(hours.end)")
        }
        return parts.joined(separator: " · ")
    }

    private var confirmReason: String? {
        switch parked.rule {
        case "rate_above_ceiling": "Above your auto-pay rate cap"
        case "session_cap_exceeded": "Above your per-session cap"
        case "daily_cap_exceeded": "Would pass your daily cap"
        default: "Needs your confirmation"
        }
    }
}

/// The live server 501s session/start until Phase 5 wires the executor;
/// distinct from a payment failure — nothing was attempted, nothing charged.
struct SessionsNotBuiltView: View {
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer(minLength: Spacing.unit)
            Image(systemName: "hammer.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(Color.textSecondary)
            Text("Paying is not wired up yet")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("The server quoted this zone, but session payment lands in a later phase. Nothing was charged — pay at the meter for now.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
            Button("Dismiss", action: dismiss)
                .buttonStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// POST /session/start answered provider_not_linked: nothing was charged,
/// and the fix is linking the account, not retrying.
struct ProviderNotLinkedView: View {
    let providerName: String
    let link: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer(minLength: Spacing.unit)
            Image(systemName: "link.badge.plus")
                .font(.system(size: 44))
                .foregroundStyle(Color.warningGold)
            Text("\(providerName) isn't linked")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("Paying here goes through your own \(providerName) account. Link it once and this works automatically.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
            Button("Link \(providerName)", action: link)
                .buttonStyle(.primary)
                .accessibilityIdentifier("parkedSheet.linkProviderButton")
            Button("Not now", action: dismiss)
                .buttonStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("parkedSheet.notLinked")
    }
}

struct PaymentFailedView: View {
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer(minLength: Spacing.unit)
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(Color.danger)
            Text("Payment failed")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("The meter was not paid. You can try again, or pay at the meter directly.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
            Button("Try again", action: retry)
                .buttonStyle(.primary)
            Button("Dismiss", action: dismiss)
                .buttonStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

#Preview("Single quote") {
    ParkingDetectedSheet(parked: MockFixtures.singleQuote())
        .environment(AppModel())
}

#Preview("Two candidates") {
    ParkingDetectedSheet(parked: MockFixtures.twoCandidates())
        .environment(AppModel())
}

#Preview("Unknown zone") {
    ParkingDetectedSheet(parked: MockFixtures.unknownZone())
        .environment(AppModel())
}
