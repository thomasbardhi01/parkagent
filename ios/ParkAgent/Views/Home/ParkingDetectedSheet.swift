import SwiftUI

/// The sheet that appears when /parked comes back. One view, four shapes:
/// single quote (pay/confirm), two-candidate side selection, free period,
/// and unknown zone. A payment failure replaces the content in place.
struct ParkingDetectedSheet: View {
    @Environment(AppModel.self) private var model
    let parked: ParkedResponse

    @State private var selectedZoneId: String?
    @State private var manualZoneNumber = ""
    /// The needsZoneNumber flow: what the driver read off the meter.
    @State private var zoneNumberEntry = ""
    @State private var zoneNumberSaved = false
    @State private var zoneNumberSaveFailed = false
    /// Set when the server applied a different number than the one typed
    /// (import or verified precedence) — shown so the user knows what is
    /// actually being paid.
    @State private var appliedNumberNotice: String?
    /// Presents the link flow from inside this sheet; set by the "Link
    /// <provider>" primary action or a provider_not_linked refusal.
    @State private var linkingProviderId: String?
    /// Set when the link flow finishes so Pay comes back without waiting
    /// for a fresh /parked (whose provider block is now stale).
    @State private var linkedInSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if let notice = model.freePeriodNotice {
                FreePeriodResultView(notice: notice) { model.dismissParkedSheet() }
            } else if let error = model.paymentError {
                if case .notImplemented = error {
                    SessionsNotBuiltView(dismiss: { model.dismissParkedSheet() })
                } else if case .refused(let code) = error, code == "provider_not_linked" {
                    // Same routing as an unlinked provider block: the fix
                    // is linking, not retrying the payment. No NYC default —
                    // the response's provider, else the effective city's.
                    ProviderNotLinkedView(providerName: providerName) {
                        model.paymentError = nil
                        linkingProviderId = parked.provider?.id
                            ?? CityCatalog.providerId(for: model.effectiveCity)
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
            // ?? "" is unreachable (only presented with an id); an empty id
            // lands on the flow's unavailable state, never a NYC default.
            ProviderLinkFlowView(providerId: linkingProviderId ?? "") {
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
                zoneNumber: displayZoneNumber(candidate),
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
            if parked.needsZoneNumber && !needsLink {
                zoneNumberCapture
            }
            Spacer(minLength: 0)
            payButtons(for: candidate)
        }
    }

    // MARK: - Zone number capture (needsZoneNumber)

    /// Nobody has reported this block's pay-by-app number yet — collect it
    /// from the meter once, then paying here is automatic for everyone.
    @ViewBuilder
    private var zoneNumberCapture: some View {
        if zoneNumberSaved {
            Label("Zone number saved for this block", systemImage: "checkmark.seal.fill")
                .font(.captionTextSemibold)
                .foregroundStyle(Color.success)
                .accessibilityIdentifier("parkedSheet.zoneSavedNotice")
            if let appliedNumberNotice {
                Text(appliedNumberNotice)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("parkedSheet.appliedNumberNotice")
            }
        } else {
            TextField("Zone number from the meter", text: $zoneNumberEntry)
                .keyboardType(.numberPad)
                .font(.bodyText)
                .padding(Spacing.unit)
                .background(Color.surface)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                .accessibilityIdentifier("parkedSheet.zoneNumberField")
            Text(zoneNumberSaveFailed
                ? "Couldn't save the number. Check the connection and try again."
                : "First park on this block — enter the zone number posted at the meter.")
                .font(.captionText)
                .foregroundStyle(zoneNumberSaveFailed ? Color.danger : Color.textSecondary)
                .accessibilityIdentifier("parkedSheet.zoneNumberHint")
        }
    }

    private var trimmedZoneNumber: String {
        zoneNumberEntry.trimmingCharacters(in: .whitespaces)
    }

    private var zoneNumberValid: Bool {
        // 1–5 digits: real ParkBoston numbers go as short as "1" (seen in
        // the 2026-09-22 Find Parking sweep); the old 3-digit floor made
        // those blocks impossible to enter.
        (1...5).contains(trimmedZoneNumber.count) && trimmedZoneNumber.allSatisfy(\.isNumber)
    }

    /// One tap: store the number, then pay with whatever number the
    /// server actually APPLIED — under import/verified precedence that can
    /// differ from what the driver typed, and paying the typed number
    /// while the executor types another would lie to the user.
    private func saveNumberAndPay(_ candidate: Candidate) async {
        zoneNumberSaveFailed = false
        let number = trimmedZoneNumber
        guard let applied = await model.reportZoneNumber(zoneId: candidate.zoneId, number: number) else {
            zoneNumberSaveFailed = true
            return
        }
        zoneNumberSaved = true
        if applied.number != number {
            appliedNumberNotice =
                "This block is registered as Zone \(applied.number) — paying that number."
        }
        var updated = candidate
        updated.providerZoneNumber = applied.number
        updated.quote.providerZoneNumber = applied.number
        await model.pay(candidate: updated)
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
                    zoneNumber: displayZoneNumber(candidate),
                    street: zoneSubtitle(candidate),
                    rateFirstHourUsd: candidate.rateFirstHourUsd,
                    rateAdditionalHourUsd: candidate.rateAdditionalHourUsd,
                    maxStayMinutes: candidate.maxStayMinutes,
                    isSelected: candidate.zoneId == selectedZoneId
                )
            }
            .buttonStyle(.pressable)
            .accessibilityIdentifier("parkedSheet.candidate.\(candidate.providerZoneNumber)")
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
                zoneNumber: displayZoneNumber(candidate),
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
        let zoneNumberName = CityCatalog.providerDisplayName(for: model.effectiveCity)
            .map { "\($0) zone number" } ?? "pay-by-app zone number"
        header("No meter zone found here")
        Text("If you can see a \(zoneNumberName) on the meter, enter it to get a quote.")
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
        } else if parked.needsZoneNumber && !zoneNumberSaved {
            // One tap saves the meter's number and pays with it.
            Button("Save number and pay \(Format.money(candidate.quote.totalUsd))") {
                Task { await saveNumberAndPay(candidate) }
            }
            .buttonStyle(.primary)
            .disabled(!zoneNumberValid || model.isPaying)
            .accessibilityIdentifier("parkedSheet.saveAndPayButton")
        } else {
            Button {
                Task { await model.pay(candidate: candidate) }
            } label: {
                HStack(spacing: Spacing.half) {
                    if model.isPaying {
                        ProgressView().controlSize(.small).tint(.white)
                    }
                    Text(model.isPaying
                        ? "Paying…"
                        : "Pay \(Format.money(candidate.quote.totalUsd)) for \(Format.minutes(candidate.quote.stayMinutes))")
                }
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

    /// "Zone —" reads better than "Zone " while the block's pay-by-app
    /// number is still unreported.
    private func displayZoneNumber(_ candidate: Candidate) -> String {
        candidate.providerZoneNumber.isEmpty ? "—" : candidate.providerZoneNumber
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
        // The zone-number capture below explains itself.
        case "needs_zone_number": nil
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

/// session/start answered free_period: the provider says the zone isn't
/// charging right now. Nothing was paid; there is no session to show.
struct FreePeriodResultView: View {
    let notice: String
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer(minLength: Spacing.unit)
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(Color.success)
            Text("No payment needed")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text(notice)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
            Button("Done", action: dismiss)
                .buttonStyle(.secondary)
                .accessibilityIdentifier("parkedSheet.freePeriodDoneButton")
        }
        .frame(maxWidth: .infinity)
        // No container identifier: nested .contain containers flatten
        // inside parkedSheet.view — tests pin the leaves (the Done button
        // and the "No payment needed" text) instead.
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
