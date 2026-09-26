import CoreLocation
import Foundation
import Observation

/// One chat entry in the assistant sheet.
struct AssistantMessage: Identifiable, Equatable {
    enum Role: Equatable {
        case user
        case assistant
    }

    let id = UUID()
    let role: Role
    var text: String
    /// Set on the assistant message that proposed a plan.
    var planId: String?
    /// Tappable answers to the question this reply asks.
    var suggestions: [AssistantSuggestion] = []
}

/// The assistant sheet's state: transcript, streaming, proposed plans,
/// confirmation flow (deep links, Link approvals), and itinerary sign-off.
/// The model only phrases; the server's tools enforce policy, and nothing
/// books or spends until `confirm` — which is wired to the card's tap.
@MainActor
@Observable
final class AssistantModel {
    enum Phase: Equatable {
        case idle
        case streaming
        case confirming
    }

    private let appModel: AppModel
    /// The conversation this sheet is in: nil until the first reply names
    /// one, or the one opened from history (sending continues it).
    private(set) var conversationId: String?
    /// An opened conversation's earlier plans, by id — shown read-only (a
    /// plan from then carries then's prices; asking again gets today's).
    var storedPlans: [String: StoredPlan] = [:]

    var messages: [AssistantMessage] = []
    var phase: Phase = .idle
    var input = ""
    var errorText: String?
    /// The most recent proposed plan, rendered as cards under its message.
    var proposedPlan: AssistantReply.ProposedPlan?
    /// Set when a confirm produced a deep link to open (a garage's own
    /// checkout — SpotHero or ParkWhiz — or a Link approval). RootView presents it in SFSafariViewController.
    var externalLink: ExternalLink?
    /// After a Link-approval sheet closes, the spend request to poll.
    var pendingLinkSync: String?
    /// The garage checkout waiting behind a Link approval: opened once the
    /// approval resolves (with the Link card to pay it, when approved).
    private var pendingGarageCheckout: URL?
    /// An approved Link garage payment: the sheet offers "Show Link card"
    /// (Face ID) and then the garage's own checkout.
    var approvedLinkCheckout: ApprovedLinkCheckout?

    struct ApprovedLinkCheckout: Equatable {
        let spendRequestId: String
        let checkoutURL: URL?
    }
    /// "Paying with your Link wallet" banner on the confirm result.
    var lastPaymentSource: String?
    var signedOffItineraryId: String?

    struct ExternalLink: Identifiable, Equatable {
        enum Kind: Equatable {
            case garageCheckout
            case linkApproval
        }

        let id = UUID()
        let url: URL
        let kind: Kind
    }

    init(appModel: AppModel) {
        self.appModel = appModel
    }

    var api: any APIClient { appModel.api }

    /// Opens a saved conversation to read or keep going: its transcript,
    /// its plans read-only, and the next message continues it.
    func open(conversationId id: String) async {
        guard phase != .streaming else { return }
        do {
            let detail = try await api.conversation(id: id)
            conversationId = detail.id
            storedPlans = Dictionary(detail.plans.map { ($0.planId, $0) }, uniquingKeysWith: { _, last in last })
            messages = detail.messages.map {
                AssistantMessage(
                    role: $0.role == "user" ? .user : .assistant,
                    text: $0.text,
                    planId: $0.planId,
                    suggestions: $0.suggestions ?? []
                )
            }
            proposedPlan = nil
            errorText = nil
            input = ""
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? "Couldn't open that conversation."
        }
    }

    /// A fresh conversation: the next message starts a new one.
    func startNewConversation() {
        guard phase != .streaming else { return }
        conversationId = nil
        messages = []
        storedPlans = [:]
        proposedPlan = nil
        errorText = nil
        input = ""
    }

    /// The chips under the newest reply, if it asked something — an older
    /// question's chips go away once the conversation moves on.
    var activeSuggestions: [AssistantSuggestion] {
        guard phase != .streaming, let last = messages.last, last.role == .assistant else { return [] }
        return last.suggestions
    }

    func send(_ overrideText: String? = nil) async {
        let text = (overrideText ?? input).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, phase != .streaming else { return }
        input = ""
        errorText = nil
        proposedPlan = nil
        messages.append(AssistantMessage(role: .user, text: text))
        messages.append(AssistantMessage(role: .assistant, text: ""))
        let assistantIndex = messages.count - 1
        phase = .streaming

        // The car's spot, else where the phone is now — never a fixture on
        // the live API (a Seaport question must not carry NYC coordinates).
        // The mock keeps the fixture so UI tests stay deterministic.
        var location: CLLocationCoordinate2D? = appModel.carCoordinate
        #if DEBUG
        if location == nil, appModel.useMockAPI {
            location = MockFixtures.fixtureCoordinate
        }
        #endif
        if location == nil {
            location = await OneShotLocation.request()
        }
        do {
            let stream = api.assistantMessage(
                text: text,
                conversationId: conversationId,
                location: location.map { (lat: $0.latitude, lng: $0.longitude) }
            )
            for try await event in stream {
                switch event {
                case .delta(let delta):
                    messages[assistantIndex].text += delta
                case .plan(let plan):
                    // Its own event: the card renders as soon as the plan
                    // is ready, without waiting for the reply to settle.
                    messages[assistantIndex].planId = plan.planId
                    proposedPlan = plan
                case .done(let reply):
                    conversationId = reply.conversationId
                    messages[assistantIndex].text = reply.reply
                    messages[assistantIndex].suggestions = reply.suggestions ?? []
                    if let plan = reply.plan {
                        messages[assistantIndex].planId = plan.planId
                        proposedPlan = plan
                    }
                }
            }
        } catch {
            messages[assistantIndex].text = ""
            errorText = (error as? APIError)?.errorDescription ?? "The assistant is unreachable."
        }
        if messages[assistantIndex].text.isEmpty && errorText == nil {
            messages[assistantIndex].text = "…"
        }
        phase = .idle
    }

    /// The Confirm / Sign off tap — the ONLY path that books or spends.
    /// `stops` is the itinerary as the user left it on the card: when they
    /// changed it, the edits go WITH the sign-off, and the server re-prices
    /// them and re-checks the day against the cap before storing anything.
    func confirm(planId: String, optionId: String?, stops: [ItineraryStop]? = nil) async {
        guard phase != .confirming else { return }
        phase = .confirming
        errorText = nil
        Haptics.light()
        do {
            let response = try await api.confirmPlan(
                planId: planId,
                optionId: optionId,
                stops: cardEdits(planId: planId, stops: stops)
            )
            lastPaymentSource = response.paymentSource
            switch response.kind {
            case "garage_handoff":
                // Link approval first when present, then the garage's own
                // checkout (the user approves the spend, then pays there
                // with the Link card).
                let checkout = response.deepLink.flatMap(URL.init(string:))
                if let approval = response.linkApproval?.approvalUrl, let url = URL(string: approval) {
                    pendingLinkSync = response.linkApproval?.spendRequestId
                    pendingGarageCheckout = checkout
                    externalLink = ExternalLink(url: url, kind: .linkApproval)
                    appendNote("Approve \(approvalAmountText(optionId: optionId)) in Link, then pay the garage's checkout with your Link card.")
                } else {
                    if let checkout {
                        externalLink = ExternalLink(url: checkout, kind: .garageCheckout)
                    }
                    appendNote(response.note ?? "Opening the garage's checkout to finish.")
                }
            case "street_confirmed":
                appendNote(streetNote(response))
            case "itinerary_signed_off":
                signedOffItineraryId = response.itineraryId
                if let first = response.linkApprovals?.first?.approvalUrl, let url = URL(string: first) {
                    pendingLinkSync = response.linkApprovals?.first?.spendRequestId
                    externalLink = ExternalLink(url: url, kind: .linkApproval)
                }
                appendNote("Signed off — the day is on Home. Garage links arrive 15 minutes before each stop.")
                await appModel.refreshItineraries()
            default:
                appendNote("Confirmed.")
            }
            proposedPlan = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? "Could not confirm."
        }
        phase = .idle
    }

    /// The card's live price after an edit, from the server — never the
    /// card's own arithmetic (POST /assistant/plans/:planId/price).
    func price(planId: String, stops: [ItineraryStop]) async throws -> ItineraryPriceResponse {
        try await api.priceItinerary(planId: planId, stops: stops)
    }

    /// The card's stops to send with the sign-off, when the user changed
    /// anything on them; nil signs off the plan as proposed.
    private func cardEdits(planId: String, stops: [ItineraryStop]?) -> [ItineraryStop]? {
        guard let stops,
              case .itinerary(let proposed)? = proposedPlan?.planId == planId ? proposedPlan?.plan : nil
        else { return stops }
        return Self.cardEditsToSend(proposed: proposed.stops, card: stops)
    }

    /// The card's stops when anything on them differs from the proposal —
    /// order, a time set or cleared, duration, street/garage — else nil.
    nonisolated static func cardEditsToSend(
        proposed: [ItineraryStop],
        card: [ItineraryStop]
    ) -> [ItineraryStop]? {
        proposed == card ? nil : card
    }

    private func streetNote(_ response: AssistantConfirmResponse) -> String {
        Self.streetNote(
            providerZoneNumber: response.providerZoneNumber,
            durationMinutes: response.durationMinutes ?? 0,
            paymentSource: response.paymentSource
        )
    }

    /// Static so the wording is unit-testable. The server sends the
    /// pay-by-app number explicitly; the internal zone slug never
    /// reaches chat copy.
    static func streetNote(
        providerZoneNumber: String?,
        durationMinutes: Int,
        paymentSource: String?
    ) -> String {
        let zone: String
        if let number = providerZoneNumber, !number.isEmpty {
            zone = "Zone \(number)"
        } else {
            zone = "Your spot"
        }
        // A street meter is paid by the street source: the ParkAgent card,
        // or the card saved on the parking account (Link never pays one).
        let pay = paymentSource == "parkagent_card"
            ? "Paying with the ParkAgent card."
            : "Paying with the card on your parking account."
        return "\(zone) is set for \(durationMinutes) min — the session starts when you park there. \(pay)"
    }

    private func appendNote(_ text: String) {
        messages.append(AssistantMessage(role: .assistant, text: text))
    }

    /// Called when a Link approval sheet closes: poll once, then take the
    /// user on to the garage's checkout — with the Link card to pay it when
    /// approved, or to pay there themselves when not.
    func syncPendingLinkApproval() async {
        guard let id = pendingLinkSync else { return }
        pendingLinkSync = nil
        let checkout = pendingGarageCheckout
        pendingGarageCheckout = nil
        let status = (try? await api.syncLinkSpendRequest(id: id))?.status
        if status == "approved" {
            approvedLinkCheckout = ApprovedLinkCheckout(spendRequestId: id, checkoutURL: checkout)
            appendNote("Link approved — show your Link card, then pay at the garage's checkout.")
        } else {
            appendNote(
                "Link \((status ?? "didn't answer").replacingOccurrences(of: "_", with: " ")) — nothing was charged. You can still pay at the garage's own checkout."
            )
            if let checkout {
                externalLink = ExternalLink(url: checkout, kind: .garageCheckout)
            }
        }
    }

    /// The amount the pending Link approval covers, for the note.
    private func approvalAmountText(optionId: String?) -> String {
        guard case .singleSpot(let plan)? = proposedPlan?.plan,
              let option = plan.options.first(where: { $0.id == optionId })
        else { return "the payment" }
        return Format.money(option.priceUsd)
    }
}
