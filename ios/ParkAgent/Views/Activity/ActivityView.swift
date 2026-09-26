import MapKit
import SwiftUI

/// The Activity tab — Sessions, upgraded: every meter session, garage, and
/// Link payment from the server's ledger, grouped by day. Rows carry the
/// place, duration, total, status, and the one-line explanation; the detail
/// has the map, the timeline, and the receipt.
struct ActivityView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var activityZoom

    private var wallet: WalletModel { model.wallet }

    var body: some View {
        NavigationStack {
            Group {
                if !wallet.activity.isEmpty || model.activeSession != nil {
                    list
                } else if wallet.activityFailed {
                    EmptyStateView(
                        icon: "wifi.exclamationmark",
                        title: "Couldn't load activity",
                        message: "Check the connection and pull to retry."
                    )
                    .accessibilityIdentifier("activity.loadFailed")
                } else if !wallet.activityLoaded {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("activity.loading")
                } else {
                    EmptyStateView(
                        icon: "clock.arrow.circlepath",
                        title: "No activity yet",
                        message: "Once ParkAgent pays a meter or books a garage, it shows up here."
                    )
                    .accessibilityIdentifier("activity.empty")
                }
            }
            .tabScreen()
            .navigationTitle("Activity")
            .navigationDestination(for: ActivityItem.self) { item in
                ActivityDetailView(item: item)
                    // The row grows into its detail (iOS 18+; plain push
                    // before that and under Reduce Motion).
                    .zoomDestination(id: item.id, in: activityZoom)
            }
            .refreshable { await wallet.loadActivity(api: model.api, reset: true) }
        }
        .task { await wallet.loadActivity(api: model.api, reset: true) }
    }

    /// The server's ledger lists the running session too. It shows once,
    /// on top, live from the app's own state (an extension moves its end
    /// before the ledger is reloaded), and opens the ledger's detail.
    private var runningItem: ActivityItem? {
        guard let id = model.activeSession?.sessionId else { return nil }
        return wallet.activity.first { $0.sessionId == id }
    }

    private var days: [(day: Date, items: [ActivityItem])] {
        let runningId = model.activeSession?.sessionId
        let past = wallet.activity.filter { runningId == nil || $0.sessionId != runningId }
        return Dictionary(grouping: past) { Calendar.current.startOfDay(for: $0.at) }
            .sorted { $0.key > $1.key }
            .map { (day: $0.key, items: $0.value.sorted { $0.at > $1.at }) }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.half) {
                if let session = model.activeSession {
                    if let item = runningItem {
                        NavigationLink(value: item) {
                            activeRow(session)
                        }
                        .buttonStyle(.plain)
                        .zoomSource(id: item.id, in: activityZoom)
                        .accessibilityIdentifier("activity.activeSession")
                    } else {
                        activeRow(session)
                            .accessibilityIdentifier("activity.activeSession")
                    }
                }
                ForEach(days, id: \.day) { group in
                    Text(Format.dayHeader(group.day))
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.textSecondary)
                        .textCase(.uppercase)
                        .padding(.top, Spacing.half)
                        .accessibilityAddTraits(.isHeader)
                    VStack(spacing: 0) {
                        ForEach(group.items) { item in
                            NavigationLink(value: item) {
                                ActivityRow(item: item)
                            }
                            .buttonStyle(.plain)
                            .zoomSource(id: item.id, in: activityZoom)
                            .accessibilityIdentifier("activity.row.\(item.id)")
                            if item.id != group.items.last?.id {
                                Divider().padding(.leading, Spacing.unit)
                            }
                        }
                    }
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }
                if wallet.activityCursor != nil {
                    Button(wallet.isLoadingActivity ? "Loading…" : "Load more") {
                        Task { await wallet.loadActivity(api: model.api, reset: false) }
                    }
                    .buttonStyle(.secondary)
                    .disabled(wallet.isLoadingActivity)
                    .accessibilityIdentifier("activity.loadMoreButton")
                }
            }
            .padding(Spacing.unit)
        }
        .accessibilityIdentifier("activity.view")
    }

    /// The session running now, on top (Home's active card, in list form).
    private func activeRow(_ session: ActiveSession) -> some View {
        HStack(spacing: Spacing.unit) {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(session.zoneLabel)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                Text("Until \(Format.clockTime(session.expiresAt))")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: Spacing.quarter) {
                Text(Format.money(session.amountUsd))
                    .font(.bodyTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
                StatusPill(status: .active)
            }
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// One Activity row: place, duration (sessions), total, status, and the
/// explanation line.
struct ActivityRow: View {
    let item: ActivityItem

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.unit) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(Color.textSecondary)
                .frame(width: 22)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(WalletCopy.place(item))
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                if let explanation = item.explanation {
                    Text(explanation)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: Spacing.quarter) {
                Text(Format.money(total))
                    .font(.bodyTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(item.status == "failed" ? Color.textSecondary : Color.textPrimary)
                TagPill(label: WalletCopy.statusLabel(item), color: pillColor)
            }
        }
        .padding(Spacing.unit)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch item.kind {
        case "garage": "building.2"
        case "link_payment": "link"
        case "plan": item.planKind == "itinerary" ? "calendar" : "map"
        default: "parkingsign.circle"
        }
    }

    private var total: Double {
        item.totalUsd ?? item.priceUsd ?? item.amountUsd ?? 0
    }

    private var subtitle: String {
        let when = Format.clockTime(item.at)
        if let minutes = item.durationMinutes, item.kind == "session" {
            return "\(when) · \(Format.minutes(minutes))"
        }
        if let provider = item.providerDisplayName, item.kind == "garage" {
            return "\(when) · \(provider)"
        }
        return when
    }

    private var pillColor: Color {
        switch WalletCopy.statusLabel(item) {
        case "Paid", "Booked", "Approved": .success
        case "Failed", "Declined", "Declined in Link": .danger
        case "Approve in Link", "Approval expired": .warningGold
        default: .textSecondary
        }
    }
}

/// An Activity item's detail: the map where it happened, the timeline of
/// what the money did, and the receipt ids that tie it to the provider,
/// Stripe, and the decisions ledger.
struct ActivityDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let item: ActivityItem

    @State private var linkCard: LinkCardDetails?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                if let lat = item.lat, let lng = item.lng {
                    let coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
                    Map(initialPosition: .region(MKCoordinateRegion(
                        center: coordinate,
                        span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)
                    ))) {
                        Annotation("Parked here", coordinate: coordinate) {
                            MapPin(kind: .car)
                        }
                    }
                    .mapStyle(.standard(pointsOfInterest: .excludingAll))
                    .frame(height: 180)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("activityDetail.map")
                }

                summary

                if let timeline = item.timeline, !timeline.isEmpty {
                    section("Timeline") {
                        VStack(spacing: 0) {
                            ForEach(Array(timeline.enumerated()), id: \.offset) { index, entry in
                                timelineRow(entry)
                                if index < timeline.count - 1 {
                                    Divider().padding(.leading, Spacing.unit)
                                }
                            }
                        }
                        .background(Color.surface)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("activityDetail.timeline")
                    }
                }

                section("Receipt") {
                    receipt
                }

                if let conversationId = item.conversationId {
                    // Made in the assistant: the conversation it came from.
                    Button {
                        model.openAssistant(conversationId: conversationId)
                    } label: {
                        Label("Open the conversation", systemImage: "bubble.left.and.bubble.right")
                    }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("activityDetail.openConversation")
                }

                if item.kind == "garage", let link = item.link, link.status == "approved" {
                    Button {
                        Task {
                            linkCard = await model.wallet.revealLinkCard(
                                spendRequestId: link.spendRequestId,
                                api: model.api
                            )
                        }
                    } label: {
                        Label("Show Link card for checkout", systemImage: "creditcard")
                    }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("activityDetail.showLinkCard")
                }
            }
            .padding(Spacing.unit)
        }
        .background(Color.appBackground)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $linkCard) { card in
            LinkCardSheet(card: card, checkoutURL: item.deepLink.flatMap(URL.init(string:)))
                .presentationDetents([.medium])
        }
        .accessibilityIdentifier("activityDetail.view")
    }

    private var title: String {
        switch item.kind {
        case "garage": "Garage"
        case "plan": item.planKind == "itinerary" ? "Day plan" : "Street spot"
        case "link_payment": "Link payment"
        default: "Session"
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack {
                Text(WalletCopy.place(item))
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                TagPill(label: WalletCopy.statusLabel(item), color: .textSecondary)
            }
            Text(Format.money(item.totalUsd ?? item.priceUsd ?? item.amountUsd ?? 0))
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
                .accessibilityIdentifier("activityDetail.total")
            if let meter = item.meterUsd, let fee = item.feeUsd, item.kind == "session" {
                Text("\(Format.money(meter)) meter + \(Format.money(fee)) fee")
                    .font(.captionText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textSecondary)
            }
            if let explanation = item.explanation {
                Text(explanation)
                    .font(.secondaryText)
                    .foregroundStyle(Color.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("activityDetail.explanation")
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    private func timelineRow(_ entry: ActivityTimelineEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(WalletCopy.timelineLabel(entry))
                    .font(.secondaryText)
                    .foregroundStyle(Color.textPrimary)
                Text(Format.clockTime(entry.at) + (entry.minutes.map { " · \(Format.minutes($0))" } ?? ""))
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            if let amount = entry.amountUsd {
                Text(Format.money(amount))
                    .font(.secondaryText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
            }
        }
        .padding(Spacing.unit)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var receipt: some View {
        VStack(spacing: 0) {
            ForEach(Array(receiptRows.enumerated()), id: \.offset) { index, row in
                detailRow(row.0, row.1)
                if index < receiptRows.count - 1 { Divider() }
            }
        }
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("activityDetail.receipt")
    }

    private var receiptRows: [(String, String)] {
        var rows: [(String, String)] = []
        if let started = item.startedAt { rows.append(("Started", Format.dayAndTime(started))) }
        if let stopped = item.stoppedAt { rows.append(("Ended", Format.dayAndTime(stopped))) }
        if let minutes = item.durationMinutes, item.kind == "session" {
            rows.append(("Bought", Format.minutes(minutes)))
        }
        if let provider = item.providerDisplayName { rows.append(("Paid at", provider)) }
        if let confirmation = item.receipt?.providerConfirmation {
            rows.append(("Confirmation", confirmation))
        }
        for hold in item.receipt?.holds ?? [] {
            rows.append((
                "Hold · \(hold.leg)",
                "\(Format.money(hold.heldUsd)) held, \(Format.money(hold.capturedUsd ?? 0)) taken"
            ))
            if let intent = hold.paymentIntentId { rows.append(("Card charge", intent)) }
        }
        if let link = item.link { rows.append(("Link request", link.spendRequestId)) }
        if let spend = item.spendRequestId { rows.append(("Link request", spend)) }
        if let session = item.sessionId { rows.append(("Session", session)) }
        if let decision = item.receipt?.decisionId { rows.append(("Decision", decision)) }
        if item.dryRun == true { rows.append(("Dry run", "Nothing was charged")) }
        return rows
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            Text(title)
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textSecondary)
                .textCase(.uppercase)
            content()
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            Text(value)
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(Spacing.unit)
    }
}

extension LinkCardDetails: Identifiable {
    var id: String { spendRequestId }
}

/// An approved Link payment's one-time card, for the garage's own checkout.
/// Shown for 30 seconds, then gone; copy buttons so nothing is retyped.
struct LinkCardSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let card: LinkCardDetails
    let checkoutURL: URL?

    @State private var secondsLeft = 30

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Text("Your Link card")
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.textPrimary)
            Text("One use, approved in Link. Pay the garage's checkout with it — it hides in \(secondsLeft)s.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            copyRow("Number", CardArtView.grouped(card.number), raw: card.number)
            copyRow("Expires", String(format: "%02d/%02d", card.expMonth, card.expYear % 100), raw: nil)
            copyRow("CVC", card.cvc, raw: card.cvc)
            if let checkoutURL {
                Button("Go to checkout") {
                    openURL(checkoutURL)
                    dismiss()
                }
                .buttonStyle(.primary)
                .accessibilityIdentifier("linkCard.checkoutButton")
            }
        }
        .padding(Spacing.unitAndHalf)
        .task {
            while secondsLeft > 0 {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
                secondsLeft -= 1
            }
            dismiss()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("linkCard.view")
    }

    private func copyRow(_ label: String, _ value: String, raw: String?) -> some View {
        HStack {
            Text(label)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            Text(value)
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
            if let raw {
                Button {
                    UIPasteboard.general.setItems(
                        [[UIPasteboard.typeAutomatic: raw]],
                        options: [.expirationDate: Date().addingTimeInterval(60), .localOnly: true]
                    )
                    Haptics.light()
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .accessibilityLabel("Copy \(label.lowercased())")
            }
        }
    }
}
