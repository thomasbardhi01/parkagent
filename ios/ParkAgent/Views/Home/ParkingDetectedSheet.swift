import SwiftUI

/// The sheet that appears when /parked comes back. One view, four shapes:
/// single quote (pay/confirm), two-candidate side selection, free period,
/// and unknown zone. A payment failure replaces the content in place.
struct ParkingDetectedSheet: View {
    @Environment(AppModel.self) private var model
    let parked: ParkedResponse

    @State private var selectedZoneId: String?
    @State private var manualZoneNumber = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if let error = model.paymentError {
                if case .notImplemented = error {
                    SessionsNotBuiltView(dismiss: { model.dismissParkedSheet() })
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
                    isSelected: candidate.zoneId == effectiveSelectionId
                )
            }
            .buttonStyle(.plain)
        }
        Spacer(minLength: 0)
        if let selected = selectedCandidate {
            payButtons(for: selected)
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
        Spacer(minLength: 0)
        Button("Get quote") {
            model.quoteForManualZone(zoneNumber: manualZoneNumber)
        }
        .buttonStyle(.primary)
        .disabled(manualZoneNumber.isEmpty)
        Button("Not parked here") { model.dismissParkedSheet() }
            .buttonStyle(.secondary)
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
            Text("\(Format.minutes(quote.stayMinutes)) · \(Format.money(quote.meterUsd)) meter + \(Format.money(quote.feeUsd)) fee")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            if parked.dryRun {
                Text("Dry run — no money moves")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.slate)
            }
        }
    }

    @ViewBuilder
    private func payButtons(for candidate: Candidate) -> some View {
        Button("Pay \(Format.money(candidate.quote.totalUsd)) for \(Format.minutes(candidate.quote.stayMinutes))") {
            Task { await model.pay(candidate: candidate) }
        }
        .buttonStyle(.primary)
        .disabled(model.isPaying)
        Button("Not parked here") { model.dismissParkedSheet() }
            .buttonStyle(.secondary)
            .disabled(model.isPaying)
    }

    private func paySelected() async {
        guard let candidate = selectedCandidate ?? parked.candidates.first else { return }
        await model.pay(candidate: candidate)
    }

    private var effectiveSelectionId: String? {
        selectedZoneId ?? parked.candidates.first?.zoneId
    }

    private var selectedCandidate: Candidate? {
        parked.candidates.first { $0.zoneId == effectiveSelectionId }
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
                .foregroundStyle(Color.slate)
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
