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
    /// Set when a confirm produced a deep link to open (SpotHero checkout
    /// or a Link approval). RootView presents it in SFSafariViewController.
    var externalLink: ExternalLink?
    /// After a Link-approval sheet closes, the spend request to poll.
    var pendingLinkSync: String?
    /// "Paying with your Link wallet" banner on the confirm result.
    var lastPaymentSource: String?
    var signedOffItineraryId: String?

    struct ExternalLink: Identifiable, Equatable {
        enum Kind: Equatable {
            case spothero
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

        let location = appModel.carCoordinate ?? AppModel.fixtureCoordinate
        do {
            let stream = api.assistantMessage(
                text: text,
                conversationId: conversationId,
                location: (lat: location.latitude, lng: location.longitude)
            )
            for try await event in stream {
                switch event {
                case .delta(let delta):
                    messages[assistantIndex].text += delta
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
    func confirm(planId: String, optionId: String?) async {
        guard phase != .confirming else { return }
        phase = .confirming
        errorText = nil
        do {
            let response = try await api.confirmPlan(planId: planId, optionId: optionId)
            lastPaymentSource = response.paymentSource
            switch response.kind {
            case "garage_handoff":
                // Link approval first when present, then the SpotHero link
                // (the user approves the spend, then checks out).
                if let approval = response.linkApproval?.approvalUrl, let url = URL(string: approval) {
                    pendingLinkSync = response.linkApproval?.spendRequestId
                    externalLink = ExternalLink(url: url, kind: .linkApproval)
                } else if let link = response.deepLink, let url = URL(string: link) {
                    externalLink = ExternalLink(url: url, kind: .spothero)
                }
                appendNote(response.note ?? "Opening SpotHero to finish checkout.")
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

    private func streetNote(_ response: AssistantConfirmResponse) -> String {
        let zone = response.zoneId.map { "Zone \($0)" } ?? "the zone"
        let pay = response.paymentSource == "link_wallet"
            ? "Paying with your Link wallet."
            : "Paying with your ParkAgent card."
        return "\(zone) is set for \(response.durationMinutes ?? 0) min — the session starts when you park there. \(pay)"
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
