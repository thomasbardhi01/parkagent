import Foundation

/// Every sentence the app says about how the user pays — one place, so the
/// Wallet, the Account sheet, and onboarding's pay step can never tell the
/// user two different things. Provider names come in as arguments (from the
/// server's provider rows or CityCatalog); nothing here names a city.
enum WalletCopy {
    /// The source's name as a row title / hero heading.
    static func title(_ source: PaymentSource, provider: String) -> String {
        switch source {
        case .providerCard: "Your card on \(provider)"
        case .linkWallet: "Link"
        case .parkagentCard: "ParkAgent card"
        }
    }

    /// The one-line explanation under each choice.
    static func explanation(_ source: PaymentSource, provider: String) -> String {
        switch source {
        case .providerCard:
            "The card saved in \(provider) pays each meter. Nothing to set up."
        case .linkWallet:
            "Pays garages you book with the assistant — you approve each one in Link. Street meters stay on your card on \(provider)."
        case .parkagentCard:
            "Our virtual card pays every meter: we hold the price on your card when you park and keep only what it cost."
        }
    }

    /// Link's approval rule, said once where the user picks it and on its hero.
    static let linkApprovalNote = "Every Link payment needs your approval in Link — you approve each garage when you confirm it."

    /// Why a ParkAgent-card switch asks before going ahead.
    static func parkAgentConsent(providers: [String]) -> String {
        let names = providers.isEmpty ? "your parking account" : listSentence(providers)
        return "The ParkAgent card goes on \(names), replacing the card saved there. You can switch back any time — then add your own card there again."
    }

    static let linkComingSoon = "Link — coming soon"
    static let parkAgentComingSoon = "Coming soon — pending approval"

    /// The state tag on a "Change how you pay" row.
    static func stateLabel(_ option: WalletSourceOption, active: Bool, sandboxAllowed: Bool) -> String {
        if active { return "Active" }
        if isComingSoon(option, sandboxAllowed: sandboxAllowed) { return "Coming soon" }
        switch option.needs {
        case "connect_link": return "Connect"
        case "add_card": return "Add card"
        default: return "Available"
        }
    }

    /// Coming soon for this build: the server says so, or it's a sandbox-only
    /// ParkAgent card and this isn't a Debug build.
    static func isComingSoon(_ option: WalletSourceOption, sandboxAllowed: Bool) -> Bool {
        option.isComingSoon || (option.sandbox && !sandboxAllowed)
    }

    /// "Visa ••4242" — the masked form every card line uses.
    static func masked(brand: String?, last4: String?) -> String? {
        guard let last4, !last4.isEmpty else { return nil }
        return "\(brand ?? "Card") ••\(last4)"
    }

    /// "Visa ••4242 · Apple Pay" — the ParkAgent card's funding line.
    static func fundingLine(_ method: FundingMethod) -> String {
        let card = "\(method.brand) ••\(method.last4)"
        return method.wallet == "apple_pay" ? "\(card) · Apple Pay" : card
    }

    /// "Link · Visa ••1234" (or the bank's name for a bank account).
    static func linkLine(_ method: LinkPaymentMethod?) -> String {
        guard let method, let masked = masked(brand: method.brand, last4: method.last4) else {
            return "Link"
        }
        return "Link · \(masked)"
    }

    /// What pays street meters on one parking account, for its Wallet row.
    static func paysWith(_ provider: WalletProvider) -> String {
        switch provider.attention {
        case "connect": return "Not connected"
        case "reconnect" where !provider.isLinked: return "Sign in again to keep paying"
        case "add_parkagent_card": return "The ParkAgent card isn't on this account yet"
        case "own_card_replaced": return "Carries the ParkAgent card — add your own card in \(provider.displayName)"
        default: break
        }
        guard let pays = provider.paysWith else { return "Not connected" }
        let card = masked(brand: pays.brand, last4: pays.last4)
        switch pays.source {
        case .parkagentCard:
            return "Paid by the ParkAgent card\(card.map { " \($0)" } ?? "")"
        default:
            return card.map { "Paid by your \($0)" } ?? "Paid by the card saved there"
        }
    }

    private static func listSentence(_ names: [String]) -> String {
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        default: return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        }
    }

    // MARK: - Activity

    /// A session row's place: "Boylston St · Zone 456".
    static func place(_ item: ActivityItem) -> String {
        switch item.kind {
        case "garage": return item.label ?? "Garage"
        case "plan": return item.label ?? "Plan"
        case "link_payment": return item.merchantName ?? "Link payment"
        default:
            let zone = item.zoneNumber.map { $0.isEmpty ? nil : "Zone \($0)" } ?? nil
            let street = item.street.map(streetName)
            return [street, zone].compactMap { $0 }.joined(separator: " · ").nonEmpty ?? "Parking"
        }
    }

    /// Open-data street names arrive upper-case ("BOYLSTON ST D-C").
    static func streetName(_ raw: String) -> String {
        raw.split(separator: " ")
            .map { word in
                word.contains("-") && word.count <= 3 ? String(word) : word.capitalized
            }
            .joined(separator: " ")
    }

    /// The status pill's word for a row.
    static func statusLabel(_ item: ActivityItem) -> String {
        switch (item.kind, item.status) {
        case ("session", "active"): return "Active"
        case ("session", "pending"): return "Paying"
        case ("session", "failed"): return "Failed"
        case ("session", "free_period"): return "Free"
        case ("session", _): return item.dryRun == true ? "Dry run" : "Paid"
        case ("garage", "planned"): return "Planned"
        case ("plan", _): return item.planKind == "itinerary" ? "Signed off" : "Pays when you park"
        case ("garage", _):
            switch item.link?.status {
            case "pending_approval", "created", "requires_action": return "Approve in Link"
            case "denied": return "Declined in Link"
            case "expired": return "Approval expired"
            default: return "Booked"
            }
        default:
            switch item.status {
            case "approved", "succeeded": return "Approved"
            case "denied": return "Declined"
            case "expired": return "Expired"
            default: return "Pending"
            }
        }
    }

    /// Timeline entry wording on the detail screen.
    static func timelineLabel(_ entry: ActivityTimelineEntry) -> String {
        switch entry.kind {
        case "hold_placed": return "Held on your card"
        case "hold_captured": return "Taken from your card"
        case "hold_released": return "Hold released"
        case "hold_declined": return "Your card declined the hold"
        case "started": return "Meter paid"
        case "extended": return "Extended"
        case "stopped": return "Stopped"
        case "expired": return "Meter ran out"
        case "free_period": return "Parking was free"
        case "failed":
            switch entry.code {
            case "card_declined": return "Your card was declined"
            case "payment_declined": return "The card at the provider was declined"
            case "wallet_not_ready", "hold_failed": return "Couldn't hold the price on your card"
            default: return "Payment didn't go through"
            }
        default: return entry.kind.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
