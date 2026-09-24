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
    private var conversationId: String?

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
        let location: CLLocationCoordinate2D?
        if let car = appModel.carCoordinate {
            location = car
        } else if appModel.useMockAPI {
            location = AppModel.fixtureCoordinate
        } else {
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
    /// reordered it before signing off, the new order is saved right after
    /// (the server re-checks the cap on that edit like any other).
    func confirm(planId: String, optionId: String?, stops: [ItineraryStop]? = nil) async {
        guard phase != .confirming else { return }
        phase = .confirming
        errorText = nil
        Haptics.light()
        do {
            let response = try await api.confirmPlan(planId: planId, optionId: optionId)
            lastPaymentSource = response.paymentSource
            switch response.kind {
            case "garage_handoff":
                // Link approval first when present, then the garage's link
                // (the user approves the spend, then checks out).
                if let approval = response.linkApproval?.approvalUrl, let url = URL(string: approval) {
                    pendingLinkSync = response.linkApproval?.spendRequestId
                    externalLink = ExternalLink(url: url, kind: .linkApproval)
                } else if let link = response.deepLink, let url = URL(string: link) {
                    externalLink = ExternalLink(url: url, kind: .garageCheckout)
                }
                appendNote(response.note ?? "Opening the garage's checkout to finish.")
            case "street_confirmed":
                if let approval = response.linkApproval?.approvalUrl, let url = URL(string: approval) {
                    pendingLinkSync = response.linkApproval?.spendRequestId
                    externalLink = ExternalLink(url: url, kind: .linkApproval)
                }
                appendNote(streetNote(response))
            case "itinerary_signed_off":
                signedOffItineraryId = response.itineraryId
                if let first = response.linkApprovals?.first?.approvalUrl, let url = URL(string: first) {
                    pendingLinkSync = response.linkApprovals?.first?.spendRequestId
                    externalLink = ExternalLink(url: url, kind: .linkApproval)
                }
                appendNote("Signed off — the day is on Home. Garage links arrive 15 minutes before each stop.")
                await saveReorder(itineraryId: response.itineraryId, planId: planId, stops: stops)
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

    /// Sign-off stores the plan as proposed; a reorder made on the card
    /// before the tap is applied as the day's first edit. Without this the
    /// drag-to-reorder was silently dropped at sign-off.
    private func saveReorder(itineraryId: String?, planId: String, stops: [ItineraryStop]?) async {
        guard let itineraryId, let stops,
              case .itinerary(let proposed)? = proposedPlan?.planId == planId ? proposedPlan?.plan : nil,
              proposed.stops.map(\.id) != stops.map(\.id)
        else { return }
        do {
            _ = try await api.patchItinerary(id: itineraryId, stops: stops)
        } catch {
            appendNote("The day is signed off in its original order — the new order didn't save.")
        }
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
        let pay = paymentSource == "link_wallet"
            ? "Paying with your Link wallet."
            : "Paying with your ParkAgent card."
        return "\(zone) is set for \(durationMinutes) min — the session starts when you park there. \(pay)"
    }

    private func appendNote(_ text: String) {
        messages.append(AssistantMessage(role: .assistant, text: text))
    }

    /// Called when a Link approval sheet closes: poll once and report.
    func syncPendingLinkApproval() async {
        guard let id = pendingLinkSync else { return }
        pendingLinkSync = nil
        if let result = try? await api.syncLinkSpendRequest(id: id) {
            appendNote(
                result.status == "approved"
                    ? "Link approved — the wallet card is ready."
                    : "Link \(result.status) — this will fall back to your ParkAgent card."
            )
        }
    }
}
