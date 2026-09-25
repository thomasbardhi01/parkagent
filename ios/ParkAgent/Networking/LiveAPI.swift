import Foundation

/// URLSession client for the Fastify server. Auth is the signed-in user's
/// 15-minute access token as `Authorization: Bearer …`; a 401 triggers one
/// silent refresh through the AuthStore and a single retry. See
/// server/API.md for the contract.
struct LiveAPI: APIClient {
    let baseURL: URL
    /// Supplies the current access token and performs the refresh. Weakly
    /// captured by the app so the client stays a value type.
    let tokens: TokenSource

    /// The AuthStore seam, as plain closures so LiveAPI stays Sendable.
    struct TokenSource: Sendable {
        var current: @Sendable () async -> String?
        var refresh: @Sendable (String?) async -> String?

        /// Sign-in calls and the mock need no tokens.
        static let none = TokenSource(current: { nil }, refresh: { _ in nil })
    }

    static func fromConfig(tokens: TokenSource) -> LiveAPI? {
        guard let url = AppConfig.apiBaseURL else { return nil }
        return LiveAPI(baseURL: url, tokens: tokens)
    }

    // MARK: - Identity

    func authMethods() async throws -> AuthMethods {
        try await send("auth/methods", authenticated: false)
    }

    func signInWithApple(
        identityToken: String,
        deviceId: String,
        fullName: (given: String?, family: String?)?
    ) async throws -> AuthSession {
        struct Name: Encodable {
            let givenName: String?
            let familyName: String?
        }
        struct Body: Encodable {
            let identityToken: String
            let deviceId: String
            let fullName: Name?
        }
        return try await send(
            "auth/apple",
            method: "POST",
            body: Body(
                identityToken: identityToken,
                deviceId: deviceId,
                fullName: fullName.map { Name(givenName: $0.given, familyName: $0.family) }
            ),
            authenticated: false
        )
    }

    func signInWithGoogle(idToken: String, deviceId: String) async throws -> AuthSession {
        try await send(
            "auth/google",
            method: "POST",
            body: ["idToken": idToken, "deviceId": deviceId],
            authenticated: false
        )
    }

    func startEmailSignIn(email: String) async throws {
        struct Ignored: Decodable {}
        let _: Ignored = try await send(
            "auth/email/start",
            method: "POST",
            body: ["email": email],
            authenticated: false
        )
    }

    func verifyEmailSignIn(email: String, code: String, deviceId: String) async throws -> AuthSession {
        try await send(
            "auth/email/verify",
            method: "POST",
            body: ["email": email, "code": code, "deviceId": deviceId],
            authenticated: false
        )
    }

    /// The rotation itself. Not on the APIClient protocol: only AuthStore
    /// calls it, through a bare client, so it can never recurse into the
    /// token source it is refreshing.
    ///
    /// The distinction matters: `.rejected` means the refresh token is
    /// genuinely dead (rotated away, revoked, expired, wrong device) and the
    /// user must sign in again; `.unreachable` means the server couldn't
    /// give a verdict right now, which must leave the session alone so a
    /// subway ride doesn't sign anyone out. Classified on the raw status,
    /// not through `perform`: that maps a JSON-bodied 429 or 503 to
    /// `.refused`, indistinguishable from a verdict — and the per-IP token
    /// limit (429) would then sign a phone out for refreshing too eagerly.
    func refreshSession(refreshToken: String, deviceId: String) async -> RefreshOutcome {
        var request = URLRequest(url: Self.url(base: baseURL, path: "auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? Self.encoder.encode(["refreshToken": refreshToken, "deviceId": deviceId])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            return .unreachable
        }
        switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200..<300:
            // A 200 we can't read is not a verdict on the token; the next
            // attempt presents the rotated-away token and gets a real one.
            guard let session = try? Self.decoder.decode(AuthSession.self, from: data) else {
                return .unreachable
            }
            return .refreshed(session)
        case 400, 401, 403:
            return .rejected
        default:
            // 429, 5xx (auth_not_configured included), the edge's HTML
            // error pages: no verdict.
            return .unreachable
        }
    }

    enum RefreshOutcome: Sendable {
        case refreshed(AuthSession)
        /// The token is dead; sign out.
        case rejected
        /// Could not ask; keep the session and try again later.
        case unreachable
    }

    func logout(refreshToken: String) async throws {
        struct Ignored: Decodable {}
        let _: Ignored = try await send(
            "auth/logout",
            method: "POST",
            body: ["refreshToken": refreshToken],
            authenticated: false
        )
    }

    func me() async throws -> MeResponse {
        try await send("me")
    }

    func updateMe(name: String?, phone: String?) async throws -> AuthUser {
        struct Body: Encodable {
            let name: String?
            let phone: String?
        }
        struct Response: Decodable {
            let user: AuthUser
        }
        let response: Response = try await send(
            "me",
            method: "PATCH",
            body: Body(name: name, phone: phone)
        )
        return response.user
    }

    func deleteAccount() async throws {
        struct Ignored: Decodable {}
        let _: Ignored = try await send("me", method: "DELETE")
    }

    // MARK: - Vehicles

    func vehicles() async throws -> [VehicleSummary] {
        struct Response: Decodable {
            let vehicles: [VehicleSummary]
        }
        let response: Response = try await send("me/vehicles")
        return response.vehicles
    }

    func addVehicle(plate: String, state: String, label: String?) async throws -> VehicleSummary {
        struct Body: Encodable {
            let plate: String
            let state: String
            let label: String?
        }
        struct Response: Decodable {
            let vehicle: VehicleSummary
        }
        let response: Response = try await send(
            "me/vehicles",
            method: "POST",
            body: Body(plate: plate, state: state, label: label)
        )
        return response.vehicle
    }

    func updateVehicle(
        id: String,
        plate: String?,
        state: String?,
        label: String?
    ) async throws -> VehicleSummary {
        struct Body: Encodable {
            let plate: String?
            let state: String?
            let label: String?
        }
        struct Response: Decodable {
            let vehicle: VehicleSummary
        }
        let response: Response = try await send(
            "me/vehicles/\(id)",
            method: "PATCH",
            body: Body(plate: plate, state: state, label: label)
        )
        return response.vehicle
    }

    func removeVehicle(id: String) async throws {
        struct Ignored: Decodable {}
        let _: Ignored = try await send("me/vehicles/\(id)", method: "DELETE")
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

    // MARK: - Wallet

    func wallet() async throws -> WalletResponse {
        try await send("wallet")
    }

    func walletActivity(cursor: String?) async throws -> ActivityPage {
        try await send(
            "wallet/activity",
            query: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? []
        )
    }

    func setWalletSource(_ source: PaymentSource, sandbox: Bool, consent: Bool) async throws -> WalletSourceResponse {
        struct Body: Encodable {
            let source: PaymentSource
            let sandbox: Bool?
            let consentReplacePaymentMethod: Bool?
        }
        return try await send(
            "wallet/source",
            method: "PUT",
            body: Body(
                source: source,
                sandbox: sandbox ? true : nil,
                consentReplacePaymentMethod: consent ? true : nil
            )
        )
    }

    func walletSetupIntent(sandbox: Bool) async throws -> WalletSetupIntent {
        struct Body: Encodable { let sandbox: Bool? }
        return try await send("wallet/setup-intent", method: "POST", body: Body(sandbox: sandbox ? true : nil))
    }

    func addFundingMethod(setupIntentId: String) async throws -> FundingMethodResponse {
        try await send("wallet/funding-methods", method: "POST", body: ["setupIntentId": setupIntentId])
    }

    func setDefaultFundingMethod(id: String) async throws -> FundingMethodResponse {
        struct Empty: Encodable {}
        return try await send("wallet/funding-methods/\(id)/default", method: "PUT", body: Empty())
    }

    func removeFundingMethod(id: String) async throws -> FundingMethodRemoveResponse {
        try await send("wallet/funding-methods/\(id)", method: "DELETE")
    }

    func revealLinkCard(spendRequestId: String) async throws -> LinkCardDetails {
        struct Empty: Encodable {}
        return try await send("link/spend-requests/\(spendRequestId)/card", method: "POST", body: Empty())
    }

    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse {
        try await send("zones/near", query: [
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lng", value: String(lng)),
            URLQueryItem(name: "radius", value: String(Int(radiusM.rounded()))),
        ])
    }

    func health() async throws -> HealthResponse {
        try await send("health")
    }

    // MARK: - City & providers

    func detectCity(lat: Double, lng: Double) async throws -> CityDetectResponse {
        try await send("city", query: [
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lng", value: String(lng)),
        ])
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
        try await send(
            "providers/\(providerId)/link-status",
            query: [URLQueryItem(name: "jobId", value: jobId)]
        )
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
        let tokens = tokens
        let body = MessageBody(
            text: text,
            conversation_id: conversationId,
            location: location.map { MessageBody.Location(lat: $0.lat, lng: $0.lng) }
        )
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // The same URL and request builders every other call
                    // uses: no path-folded query, one bearer contract.
                    let url = Self.url(base: baseURL, path: "assistant/message")
                    let encoded = try Self.encoder.encode(body)
                    func open(_ token: String?) async throws -> (URLSession.AsyncBytes, Int) {
                        var request = Self.request(url, method: "POST", body: encoded, token: token)
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        do {
                            let (bytes, response) = try await URLSession.shared.bytes(for: request)
                            return (bytes, (response as? HTTPURLResponse)?.statusCode ?? 0)
                        } catch {
                            throw APIError.transport(error)
                        }
                    }
                    let token = await tokens.current()
                    var (bytes, status) = try await open(token)
                    // Same silent-refresh contract as the plain transport:
                    // one refresh, one retry. Auth is checked when the
                    // stream opens, so a token that expires (or is rotated
                    // by another request's refresh) mid-reply never cuts
                    // a stream that already started.
                    if status == 401 {
                        bytes.task.cancel() // the 401's body is never read
                        guard let refreshed = await tokens.refresh(token) else {
                            throw APIError.unauthorized
                        }
                        (bytes, status) = try await open(refreshed)
                    }
                    guard (200..<300).contains(status) else {
                        // A named refusal (assistant_budget_exhausted,
                        // rate_limited, conversation_not_found, …) keeps
                        // its code — it's the difference between "try
                        // again" and "come back tomorrow".
                        var data = Data()
                        for try await byte in bytes {
                            data.append(byte)
                            if data.count >= 16_384 { break }
                        }
                        throw Self.failure(status: status, data: data)
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
                            case "plan":
                                // The plan lands before the reply settles;
                                // a malformed one must not kill the stream.
                                if let plan = try? Self.decoder.decode(
                                    AssistantReply.ProposedPlan.self, from: data
                                ) {
                                    continuation.yield(.plan(plan))
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

    /// One round trip. `authenticated` requests carry the access token and,
    /// on a 401, refresh once and retry exactly once — the AuthStore makes
    /// concurrent refreshes collapse into a single rotation.
    private func send<Response: Decodable>(
        _ path: String,
        query: [URLQueryItem] = [],
        method: String = "GET",
        body: (any Encodable)? = nil,
        authenticated: Bool = true
    ) async throws -> Response {
        let encodedBody = try body.map { try Self.encoder.encode($0) }
        let token = authenticated ? await tokens.current() : nil
        let url = Self.url(base: baseURL, path: path, query: query)
        do {
            return try await perform(url, method: method, body: encodedBody, token: token)
        } catch APIError.unauthorized where authenticated {
            guard let refreshed = await tokens.refresh(token) else {
                throw APIError.unauthorized
            }
            return try await perform(url, method: method, body: encodedBody, token: refreshed)
        }
    }

    private func perform<Response: Decodable>(
        _ url: URL,
        method: String,
        body: Data?,
        token: String?
    ) async throws -> Response {
        let request = Self.request(url, method: method, body: body, token: token)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.failure(status: status, data: data) }
        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch {
            // A 200 with an empty body is normal for {ok:true} routes
            // the caller decodes as an empty struct.
            if let empty = EmptyResponse() as? Response, data.isEmpty { return empty }
            throw APIError.transport(error)
        }
    }

    /// The one request builder: bearer when there is a token, JSON body
    /// when there is one. The assistant stream builds on it too.
    static func request(_ url: URL, method: String, body: Data?, token: String?) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    /// A non-2xx answer as an APIError — shared by plain calls and the
    /// assistant stream so a named refusal reads the same on both.
    static func failure(status: Int, data: Data) -> APIError {
        switch status {
        case 400:
            return .invalidRequest(String(data: data, encoding: .utf8) ?? "bad request")
        case 401:
            // The sign-in routes answer 401 with a typed reason
            // (invalid_code, token_reused, …) worth showing the user.
            if let refusal = try? decoder.decode(Refusal.self, from: data),
               refusal.error != "unauthorized" {
                return .refused(code: refusal.error)
            }
            return .unauthorized
        case 403, 404, 409, 429, 502, 503:
            // Named refusals carry {"error": "<code>"} (dry_run,
            // funding_unavailable, assistant_budget_exhausted, …).
            if let refusal = try? decoder.decode(Refusal.self, from: data) {
                return .refused(code: refusal.error)
            }
            return .server(status: status)
        case 501:
            return .notImplemented
        default:
            return .server(status: status)
        }
    }

    /// The request URL. A query must come in as items, never folded into
    /// `path`: `appending(path:)` percent-encodes "?", so "city?lat=…"
    /// reached the server as the PATH "/city%3Flat=…" — a route 404 on every
    /// call. City detection, link-job polling, card-transaction paging, and
    /// the map's curb layer all failed that way on a device (the mock never
    /// builds a URL, so no simulator run could show it).
    static func url(base: URL, path: String, query: [URLQueryItem] = []) -> URL {
        assert(!path.contains("?"), "pass query parameters as `query`, not in the path")
        let url = base.appending(path: path)
        guard !query.isEmpty,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return url }
        components.percentEncodedQueryItems = query.map { item in
            URLQueryItem(
                name: item.name,
                value: item.value?.addingPercentEncoding(withAllowedCharacters: queryValueAllowed)
            )
        }
        return components.url ?? url
    }

    /// URLQueryItem leaves "+" alone, and the server's query parser reads a
    /// bare "+" as a space — which would turn a card-transactions cursor's
    /// "+00:00" offset into garbage. Encode it (and the pair delimiters).
    private static let queryValueAllowed: CharacterSet = {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "+&=")
        return allowed
    }()

    /// Stand-in for routes whose body the caller ignores.
    private struct EmptyResponse: Decodable {}

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
