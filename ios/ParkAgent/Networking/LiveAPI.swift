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

    func startSession(_ request: SessionStartRequest) async throws -> SessionStartResponse {
        try await send("session/start", method: "POST", body: request)
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
