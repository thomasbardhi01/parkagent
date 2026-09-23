import Foundation

/// URLSession client for the Fastify server. Auth is the x-api-key header;
/// see server/API.md for the contract.
struct LiveAPI: APIClient {
    let baseURL: URL
    let apiKey: String

    static func fromConfig() -> LiveAPI? {
        guard let url = AppConfig.apiBaseURL, let key = AppConfig.apiKey else { return nil }
        return LiveAPI(baseURL: url, apiKey: key)
    }

    func parked(_ request: ParkedRequest) async throws -> ParkedResponse {
        try await send("parked", method: "POST", body: request)
    }

    func reportZoneNumber(zoneId: String, number: String) async throws -> ZoneNumberReportResponse {
        let escaped = zoneId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? zoneId
        return try await send(
            "zones/\(escaped)/provider-number",
            method: "POST",
            body: ["number": number]
        )
    }

    func policy() async throws -> PolicyResponse {
        try await send("policy")
    }

    func startSession(_ request: SessionStartRequest) async throws -> SessionStartOutcome {
        let wire: SessionStartWire = try await send("session/start", method: "POST", body: request)
        return try wire.outcome()
    }

    func stopSession(sessionId: String) async throws -> SessionStopResponse {
        try await send("session/stop", method: "POST", body: ["sessionId": sessionId])
    }

    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse {
        struct Body: Encodable {
            let sessionId: String
            let minutes: Int
        }
        return try await send("session/extend", method: "POST", body: Body(sessionId: sessionId, minutes: minutes))
    }

    func reportLocation(_ report: LocationReport) async throws {
        struct Ignored: Decodable {}
        let _: Ignored = try await send("location", method: "POST", body: report)
    }

    func registerDevice(_ registration: DeviceRegistration) async throws {
        struct Ignored: Decodable {}
        let _: Ignored = try await send("device", method: "POST", body: registration)
    }

    func updatePolicy(_ policy: Policy) async throws -> PolicyResponse {
        try await send("policy", method: "PUT", body: policy)
    }

    // MARK: - Payment source

    func paymentSource() async throws -> PaymentSourceResponse {
        try await send("me/payment-source")
    }

    func updatePaymentSource(_ source: PaymentSource) async throws -> PaymentSourceResponse {
        try await send(
            "me/payment-source",
            method: "PUT",
            body: ["paymentSource": source.rawValue]
        )
    }

    // MARK: - City & providers

    func detectCity(lat: Double, lng: Double) async throws -> CityDetectResponse {
        try await send("city?lat=\(lat)&lng=\(lng)")
    }

    func providersStatus() async throws -> ProvidersStatusResponse {
        try await send("providers/status")
    }

    func linkProvider(
        _ providerId: String,
        cookies: [ProviderCookie],
        setUpCard: Bool,
        consent: Bool
    ) async throws -> ProviderLinkResponse {
        try await send(
            "providers/\(providerId)/link",
            method: "POST",
            body: ProviderLinkRequest(
                cookies: cookies,
                setUpCard: setUpCard,
                consentReplacePaymentMethod: setUpCard ? consent : nil
            )
        )
    }

    func linkStatus(providerId: String, jobId: String) async throws -> LinkStatusResponse {
        let escaped = jobId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? jobId
        return try await send("providers/\(providerId)/link-status?jobId=\(escaped)")
    }

    func setupCard(providerId: String) async throws -> SetupCardResponse {
        struct Empty: Encodable {}
        return try await send("providers/\(providerId)/setup-card", method: "POST", body: Empty())
    }

    func unlinkProvider(_ providerId: String) async throws -> UnlinkResponse {
        struct Empty: Encodable {}
        return try await send("providers/\(providerId)/unlink", method: "POST", body: Empty())
    }

    // MARK: - Card

    func prepareCard() async throws -> CardPrepareResponse {
        struct Empty: Encodable {}
        return try await send("card/prepare", method: "POST", body: Empty())
    }

    func topupIntent(amountUsd: Double) async throws -> TopupIntentResponse {
        try await send("card/funding/topup-intent", method: "POST", body: ["amountUsd": amountUsd])
    }

    func card() async throws -> CardResponse {
        try await send("card")
    }

    func cardTransactions(cursor: String?) async throws -> CardTransactionsResponse {
        var path = "card/transactions"
        if let cursor, let escaped = cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "?cursor=\(escaped)"
        }
        return try await send(path)
    }

    func cardTopup(amountUsd: Double) async throws -> CardFundingResponse {
        try await send("card/funding/topup", method: "POST", body: ["amountUsd": amountUsd])
    }

    func cardWithdraw(amountUsd: Double) async throws -> CardFundingResponse {
        try await send("card/funding/withdraw", method: "POST", body: ["amountUsd": amountUsd])
    }

    func freezeCard() async throws -> CardStatusResponse {
        struct Empty: Encodable {}
        return try await send("card/freeze", method: "POST", body: Empty())
    }

    func unfreezeCard() async throws -> CardStatusResponse {
        struct Empty: Encodable {}
        return try await send("card/unfreeze", method: "POST", body: Empty())
    }

    /// Client-side PAN reveal: our server hands out a short-lived ephemeral
    /// key (GET /card/reveal) and the details come straight from Stripe —
    /// the number and CVC never transit the ParkAgent server.
    func revealCardDetails() async throws -> RevealedCardDetails {
        let reveal: CardRevealResponse = try await send("card/reveal")

        var request = URLRequest(url: URL(string: "https://api.stripe.com/v1/issuing/cards/\(reveal.stripeCardId)?expand[]=number&expand[]=cvc")!)
        request.setValue("Bearer \(reveal.ephemeralKeySecret)", forHTTPHeaderField: "Authorization")
        request.setValue(reveal.apiVersion, forHTTPHeaderField: "Stripe-Version")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw APIError.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }

        struct StripeCard: Decodable {
            let number: String?
            let cvc: String?
            let expMonth: Int
            let expYear: Int
            enum CodingKeys: String, CodingKey {
                case number, cvc
                case expMonth = "exp_month"
                case expYear = "exp_year"
            }
        }
        do {
            let card = try JSONDecoder().decode(StripeCard.self, from: data)
            guard let number = card.number, let cvc = card.cvc else {
                // Stripe withheld the sensitive fields (key too old, or the
                // account requires the Elements nonce flow).
                throw APIError.refused(code: "reveal_unavailable")
            }
            return RevealedCardDetails(number: number, cvc: cvc, expMonth: card.expMonth, expYear: card.expYear)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error)
        }
    }

    // MARK: - Assistant

    func assistantMessage(
        text: String,
        conversationId: String?,
        location: (lat: Double, lng: Double)?
    ) -> AsyncThrowingStream<AssistantEvent, Error> {
        struct MessageBody: Encodable {
            let text: String
            let conversation_id: String?
            let location: Location?
            struct Location: Encodable {
                let lat: Double
                let lng: Double
            }
        }
        let baseURL = baseURL
        let apiKey = apiKey
        let body = MessageBody(
            text: text,
            conversation_id: conversationId,
            location: location.map { MessageBody.Location(lat: $0.lat, lng: $0.lng) }
        )
        return AsyncThrowingStream { continuation in
            let task = Task {
                var request = URLRequest(url: baseURL.appending(path: "assistant/message"))
                request.httpMethod = "POST"
                request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.httpBody = try Self.encoder.encode(body)
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard (200..<300).contains(status) else {
                        throw status == 503
                            ? APIError.refused(code: "assistant_not_configured")
                            : APIError.server(status: status)
                    }
                    // SSE frames: "event: <name>" then "data: <json>".
                    var event = ""
                    for try await line in bytes.lines {
                        if line.hasPrefix("event: ") {
                            event = String(line.dropFirst(7))
                        } else if line.hasPrefix("data: "), let data = line.dropFirst(6).data(using: .utf8) {
                            switch event {
                            case "text":
                                struct Delta: Decodable { let delta: String }
                                if let delta = try? Self.decoder.decode(Delta.self, from: data) {
                                    continuation.yield(.delta(delta.delta))
                                }
                            case "done":
                                let reply = try Self.decoder.decode(AssistantReply.self, from: data)
                                continuation.yield(.done(reply))
                            case "error":
                                throw APIError.refused(code: "assistant_failed")
                            default:
                                break
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func confirmPlan(planId: String, optionId: String?) async throws -> AssistantConfirmResponse {
        struct Body: Encodable {
            let planId: String
            let optionId: String?
        }
        return try await send("assistant/confirm", method: "POST", body: Body(planId: planId, optionId: optionId))
    }

    func itineraries() async throws -> ItinerariesResponse {
        try await send("assistant/itineraries")
    }

    func patchItinerary(id: String, stops: [ItineraryStop]) async throws -> ItineraryPatchResponse {
        struct Body: Encodable { let stops: [ItineraryStop] }
        return try await send("assistant/itineraries/\(id)", method: "PATCH", body: Body(stops: stops))
    }

    func linkWalletStatus() async throws -> LinkWalletStatus {
        try await send("link/status")
    }

    func linkWalletConnect() async throws -> LinkConnectResponse {
        try await send("link/connect", method: "POST", body: ["": ""])
    }

    func linkWalletDisconnect() async throws {
        struct Ignored: Decodable { let ok: Bool }
        let _: Ignored = try await send("link/disconnect", method: "POST", body: ["": ""])
    }

    func syncLinkSpendRequest(id: String) async throws -> LinkSpendSyncResponse {
        try await send("link/spend-requests/\(id)/sync", method: "POST", body: ["": ""])
    }

    // MARK: - Transport

    private struct Refusal: Decodable { let error: String }

    private func send<Response: Decodable>(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200..<300:
            do {
                return try Self.decoder.decode(Response.self, from: data)
            } catch {
                throw APIError.transport(error)
            }
        case 400:
            throw APIError.invalidRequest(String(data: data, encoding: .utf8) ?? "bad request")
        case 401:
            throw APIError.unauthorized
        case 409, 503:
            // Named refusals carry {"error": "<code>"} (dry_run,
            // funding_unavailable, session_already_active, …).
            if let refusal = try? Self.decoder.decode(Refusal.self, from: data) {
                throw APIError.refused(code: refusal.error)
            }
            throw APIError.server(status: status)
        case 501:
            throw APIError.notImplemented
        default:
            throw APIError.server(status: status)
        }
    }

    // API.md: ISO 8601 with offset. The server may or may not include
    // fractional seconds, so decoding tries both. Date.ISO8601FormatStyle is
    // a Sendable struct, unlike ISO8601DateFormatter.
    private static let plainStyle = Date.ISO8601FormatStyle()
    private static let fractionalStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(plainStyle))
        }
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = (try? fractionalStyle.parse(raw)) ?? (try? plainStyle.parse(raw)) {
                return date
            }
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Unrecognized date: \(raw)"
            ))
        }
        return decoder
    }()
}
