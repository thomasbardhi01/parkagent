import SwiftUI

/// Home's detection banner: the most serious thing missing or reduced,
/// what it costs, and its fix in one tap. It reads the live snapshot, so
/// it appears and clears as the user changes things in Settings, and the
/// "+N more" line opens the full list.
struct DetectionStatusBanner: View {
    @Environment(PermissionsManager.self) private var permissions
    @State private var showingAll = false
    @State private var explainingAlways = false

    var body: some View {
        let issues = permissions.capabilities.issues
        if let top = issues.first {
            let action = permissions.capabilities.action(
                for: top, alwaysUpgradeAvailable: permissions.alwaysUpgradeAvailable
            )
            HStack(alignment: .top, spacing: Spacing.half) {
                Image(systemName: top.symbol)
                    .foregroundStyle(top.severity == .blocking ? Color.danger : Color.warningGold)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(top.title)
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.textPrimary)
                        .accessibilityIdentifier("home.detectionBanner.title")
                    Text(top.consequence)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if issues.count > 1 {
                        Button("+\(issues.count - 1) more") { showingAll = true }
                            .font(.captionTextSemibold)
                            .foregroundStyle(Color.actionCoralLink)
                            .accessibilityIdentifier("home.detectionBanner.more")
                    }
                }
                Spacer(minLength: 0)
                if let title = action.title {
                    Button(title) { run(action) }
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.actionCoralLink)
                        .accessibilityIdentifier("home.detectionBanner.action")
                }
            }
            .padding(Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .shadow(color: .black.opacity(0.1), radius: 4, y: 1)
            .contentShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .onTapGesture { showingAll = true }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("home.detectionBanner")
            .sheet(isPresented: $showingAll) {
                DetectionStatusSheet()
                    .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $explainingAlways) {
                AlwaysLocationExplainer(onDone: { explainingAlways = false })
            }
        }
    }

    private func run(_ action: CapabilityAction) {
        Task {
            let outcome = await permissions.perform(action)
            // Kept While Using, or iOS skipped its prompt: only Settings
            // can grant Always now — say how.
            if outcome == .declined || outcome == .notShown { explainingAlways = true }
        }
    }
}

/// Every capability with its live state, tappable; plus what's missing.
struct DetectionStatusSheet: View {
    @Environment(PermissionsManager.self) private var permissions
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                // What doesn't work first: it's why the sheet was opened.
                let issues = permissions.capabilities.issues
                if !issues.isEmpty {
                    Section("What doesn't work") {
                        ForEach(issues) { issue in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(issue.title).font(.bodyTextSemibold)
                                Text(issue.consequence)
                                    .font(.captionText)
                                    .foregroundStyle(Color.textSecondary)
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("detectionStatus.issue.\(issue.rawValue)")
                        }
                    }
                }
                Section {
                    CapabilityRowsView(identifierPrefix: "detectionStatus")
                } footer: {
                    Text(DetectionCopy.levelSentence(permissions.capabilities.detectionLevel))
                }
            }
            .navigationTitle("Park detection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("detectionStatus.view")
    }
}

/// The capability rows, each showing iOS Settings' own word for its state
/// and doing the right thing when tapped: ask while iOS still will, else
/// open this app's page in Settings (the notification page for
/// notifications). Used by Account → Privacy, the status sheet, and
/// Diagnostics.
struct CapabilityRowsView: View {
    @Environment(PermissionsManager.self) private var permissions
    var rows: [CapabilityRow] = CapabilityRow.allCases
    /// "account.privacy" → identifiers like "account.privacy.location".
    let identifierPrefix: String
    /// A different name for a row where the screen calls it something else
    /// ("Push notifications" in Account's Notifications section).
    var titles: [CapabilityRow: String] = [:]
    @State private var explainingAlways = false

    var body: some View {
        ForEach(rows, id: \.self) { row in
            let capabilities = permissions.capabilities
            let action = capabilities.action(for: row, alwaysUpgradeAvailable: permissions.alwaysUpgradeAvailable)
            Group {
                if action == .none {
                    // Nothing to do (restricted, no hardware): a plain row,
                    // not a dimmed button.
                    rowLabel(row, capabilities, tappable: false)
                } else {
                    Button {
                        Task {
                            let outcome = await permissions.perform(action)
                            if outcome == .declined || outcome == .notShown { explainingAlways = true }
                        }
                    } label: {
                        rowLabel(row, capabilities, tappable: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(action.title ?? "")
                }
            }
            // One element whose label reads "Location, While Using": the
            // tests assert the exact state.
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("\(identifierPrefix).\(row.rawValue)")
            // On the location row only: a modifier on the ForEach lands on
            // every row, and five sheets on one flag is four too many.
            .sheet(isPresented: row == .location ? $explainingAlways : .constant(false)) {
                AlwaysLocationExplainer(onDone: { explainingAlways = false })
            }
        }
    }
}

extension CapabilityRowsView {
    fileprivate func rowLabel(_ row: CapabilityRow, _ capabilities: DetectionCapabilities, tappable: Bool) -> some View {
        HStack {
            Text(titles[row] ?? row.title)
                .foregroundStyle(Color.textPrimary)
            Spacer()
            Text(capabilities.value(of: row))
                .foregroundStyle(capabilities.isSatisfied(row) ? Color.textSecondary : Color.warningGold)
            if tappable {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.textSecondary.opacity(0.6))
            }
        }
        .contentShape(Rectangle())
    }
}

/// One screen for the only road to Always once iOS's own prompt is spent
/// (or was answered "Keep Only While Using"): what it's for, the three
/// taps in Settings, and a button that goes there. It closes itself when
/// the user comes back with Always granted.
struct AlwaysLocationExplainer: View {
    @Environment(PermissionsManager.self) private var permissions
    /// Called for "Not now", and when Always arrives.
    let onDone: () -> Void
    var notNowTitle = "Not now"

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "location.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.actionCoral)
            Text("Allow location \"Always\"")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("You park with the app closed, so that's when ParkAgent needs to notice. With \"While Using\", parks are only caught while the app is open.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
            VStack(alignment: .leading, spacing: Spacing.half) {
                step(1, "Tap Open Settings below")
                step(2, "Tap Location")
                step(3, "Choose Always, and keep Precise Location on")
            }
            .padding(.top, Spacing.half)
            Spacer()
            Button("Open Settings") {
                Task { await permissions.perform(.openAppSettings) }
            }
            .buttonStyle(.primary)
            .accessibilityIdentifier("alwaysExplainer.openSettings")
            Button(notNowTitle, action: onDone)
                .buttonStyle(.secondary)
                .accessibilityIdentifier("alwaysExplainer.notNow")
        }
        .padding(Spacing.unitAndHalf)
        .background(Color.appBackground)
        .onChange(of: permissions.capabilities.location) { _, location in
            if location == .always { onDone() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("alwaysExplainer.view")
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.half) {
            Text("\(number)")
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textSecondary)
                .frame(width: 18)
            Text(text)
                .font(.bodyText)
                .foregroundStyle(Color.textPrimary)
        }
    }
}

/// The sentences about detection shared by the banner, the sheet, and
/// onboarding.
enum DetectionCopy {
    static func levelSentence(_ level: DetectionCapabilities.DetectionLevel) -> String {
        switch level {
        case .full: "ParkAgent notices when you park, even with the app closed."
        case .whileOpen: "ParkAgent only notices a park while it's open."
        case .off: "ParkAgent can't notice when you park."
        }
    }
}

extension CapabilityIssue {
    var symbol: String {
        switch self {
        case .locationServicesOff, .locationNotAsked, .locationDenied, .locationRestricted: "location.slash.fill"
        case .locationWhileUsing, .preciseOff: "location.circle"
        case .motionNotAsked, .motionDenied, .motionRestricted: "figure.walk.circle"
        case .notificationsNotAsked, .notificationsDenied: "bell.slash.fill"
        case .backgroundRefreshOff, .backgroundRefreshRestricted: "arrow.clockwise.circle"
        case .lowPowerMode: "battery.25percent"
        }
    }
}
