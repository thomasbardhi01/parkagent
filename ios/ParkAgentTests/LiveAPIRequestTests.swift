import XCTest
@testable import ParkAgent

/// What LiveAPI actually puts on the wire. The regression this pins: query
/// strings were folded into the path, and `URL.appending(path:)` encodes
/// "?" — so GET /city, /providers/:id/link-status, /card/transactions?cursor
/// and /zones/near all reached the server as unmatched PATHS and 404'd on
/// every device. The mock never builds a URL, so only a test at this layer
/// can see it.
///
/// The identity and account calls are here for the same reason: the
/// welcome screen and the Account sheet only ever run on the mock in UI
/// tests, so a wrong path, method, or header would ship unseen.
final class LiveAPIRequestTests: XCTestCase {
    private let api = LiveAPI(
        baseURL: URL(string: "https://api.test")!,
        tokens: LiveAPI.TokenSource(current: { "access-1" }, refresh: { _ in "access-2" })
    )

    override func setUp() {
        super.setUp()
        URLProtocol.registerClass(StubURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(StubURLProtocol.self)
        super.tearDown()
    }

    /// The requests this test sent. The unit-test host is the app itself,
    /// which may make its own calls; only api.test is ours.
    private func sentRequests() -> [URLRequest] {
        StubURLProtocol.recorded.filter { $0.url?.host() == "api.test" }
    }

    /// The single request this test sent.
    private func sentRequest() throws -> URLRequest {
        let ours = sentRequests()
        XCTAssertEqual(ours.count, 1, "expected exactly one request to api.test")
        return try XCTUnwrap(ours.last)
    }

    private func query(_ request: URLRequest) -> [String: String] {
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }

    /// The JSON body as a dictionary. URLSession hands a URLProtocol the
    /// body as a stream, not `httpBody`.
    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let direct = request.httpBody {
            data = direct
        } else {
            let stream = try XCTUnwrap(request.httpBodyStream, "request has no body")
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            var collected = Data()
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                collected.append(buffer, count: read)
            }
            data = collected
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func bearer(_ request: URLRequest) -> String? {
        request.value(forHTTPHeaderField: "Authorization")
    }

    /// A real GET /zones/near body, captured from the API against the dev
    /// database (Boylston St, radius 150, trimmed to two zones and three
    /// vertices each): fractional-second `at`, an unnumbered zone's empty
    /// providerZoneNumber, and GeoJSON [lng, lat] order.
    private static let nearbyZonesBody = #"""
    {"radiusM": 150, "at": "2026-09-24T15:44:09.605Z", "truncated": false, "zones": [{"zoneId": "bos-boylston-st-d-c-0cf971", "city": "bos", "providerZoneNumber": "456", "street": "BOYLSTON ST D-C", "rateFirstHourUsd": 3.75, "rateAdditionalHourUsd": 3.75, "maxStayMinutes": 120, "distanceM": 4.7, "enforcedNow": true, "todayHours": [{"start": "08:00", "end": "20:00"}], "hours": [{"end": "20:00", "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], "start": "08:00"}], "centerline": [[[-71.076681, 42.350198], [-71.076325, 42.350457], [-71.076148, 42.350331]]]}, {"zoneId": "bos-newbury-st-c-d-cf7f31", "city": "bos", "providerZoneNumber": "", "street": "NEWBURY ST C-D", "rateFirstHourUsd": 3.75, "rateAdditionalHourUsd": 3.75, "maxStayMinutes": 120, "distanceM": 85.8, "enforcedNow": true, "todayHours": [{"start": "08:00", "end": "20:00"}], "hours": [{"end": "20:00", "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], "start": "08:00"}], "centerline": [[[-71.077271, 42.351131], [-71.07715, 42.350968], [-71.076829, 42.351245]]]}]}
    """#

    /// What /auth/* answer (server/API.md "Identity & sessions").
    private static let sessionBody = #"""
    {"accessToken": "new-access", "accessExpiresAt": "2026-09-24T16:00:00.000Z", "refreshToken": "new-refresh", "created": false, "user": {"id": "u1", "name": "Driver", "email": "driver@example.com", "emailVerified": true, "phone": null, "phoneVerified": false, "appleLinked": true, "googleLinked": false}}
    """#

    private static let userBody = #"""
    {"id": "u1", "name": "Driver", "email": "driver@example.com", "emailVerified": true, "phone": "6175550100", "phoneVerified": false, "appleLinked": true, "googleLinked": false}
    """#

    private static let vehicleBody = #"{"id": "v1", "plate": "ABC1234", "state": "MA", "label": null}"#

    // MARK: - Query strings

    func testNearbyZonesSendsARealQueryAndDecodesTheServerShape() async throws {
        StubURLProtocol.respond(json: Self.nearbyZonesBody)
        let response = try await api.nearbyZones(lat: 42.3503, lng: -71.081, radiusM: 249.6)

        let request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/zones/near")
        XCTAssertEqual(query(request), ["lat": "42.3503", "lng": "-71.081", "radius": "250"])
        XCTAssertEqual(bearer(request), "Bearer access-1")
        XCTAssertNil(request.value(forHTTPHeaderField: "x-api-key"), "the app carries no api key")

        XCTAssertEqual(response.zones.map(\.zoneId), ["bos-boylston-st-d-c-0cf971", "bos-newbury-st-c-d-cf7f31"])
        XCTAssertEqual(response.zones[1].providerZoneNumber, "")
        // GeoJSON is [lng, lat]; a swap would put Boston in the Indian Ocean.
        let first = try XCTUnwrap(response.zones[0].polylines.first?.first)
        XCTAssertEqual(first.latitude, 42.350198, accuracy: 1e-9)
        XCTAssertEqual(first.longitude, -71.076681, accuracy: 1e-9)
    }

    func testDetectCityQueriesTheCityRoute() async throws {
        StubURLProtocol.respond(json: #"{"city": null, "provider": null}"#)
        _ = try? await api.detectCity(lat: 40.7784, lng: -73.9818)

        let request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/city")
        XCTAssertEqual(query(request), ["lat": "40.7784", "lng": "-73.9818"])
    }

    func testLinkStatusCarriesTheJobIdAsAQuery() async throws {
        StubURLProtocol.respond(json: "{}")
        _ = try? await api.linkStatus(providerId: "passport", jobId: "job 1&2")

        let request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/providers/passport/link-status")
        XCTAssertEqual(query(request), ["jobId": "job 1&2"])
    }

    /// The cursor is an ISO timestamp; a "+hh:mm" offset must survive, and
    /// the server reads a bare "+" as a space.
    func testCardTransactionsCursorKeepsItsPlus() async throws {
        StubURLProtocol.respond(json: "{}")
        _ = try? await api.cardTransactions(cursor: "2026-09-24T11:44:09.605+04:00")

        let request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/card/transactions")
        XCTAssertEqual(request.url?.query(percentEncoded: true), "cursor=2026-09-24T11:44:09.605%2B04:00")
    }

    func testNoQueryLeavesThePathAlone() {
        let url = LiveAPI.url(base: URL(string: "https://api.test")!, path: "zones/bos-1/provider-number")
        XCTAssertEqual(url.absoluteString, "https://api.test/zones/bos-1/provider-number")
    }

    // MARK: - Silent refresh

    /// A 401 refreshes once and retries once with the NEW token — and the
    /// retry is the same request, query included. Rebuilding it from the
    /// path alone would drop the query and 404 the retry.
    func testUnauthorizedRefreshesAndRetriesTheSameRequestOnce() async throws {
        StubURLProtocol.respond(sequence: [
            (401, #"{"error": "unauthorized"}"#),
            (200, Self.nearbyZonesBody),
        ])
        let response = try await api.nearbyZones(lat: 42.3503, lng: -71.081, radiusM: 250)

        let requests = sentRequests()
        XCTAssertEqual(requests.count, 2, "one try, one retry")
        XCTAssertEqual(requests.map(bearer), ["Bearer access-1", "Bearer access-2"])
        XCTAssertEqual(requests.map { $0.url?.path() }, ["/zones/near", "/zones/near"])
        XCTAssertEqual(query(requests[1]), ["lat": "42.3503", "lng": "-71.081", "radius": "250"])
        XCTAssertEqual(response.zones.count, 2)
    }

    /// A second 401 after the refresh is final — no loop.
    func testASecondUnauthorizedIsFinal() async throws {
        StubURLProtocol.respond(sequence: [
            (401, #"{"error": "unauthorized"}"#),
            (401, #"{"error": "unauthorized"}"#),
            (200, "{}"),
        ])
        do {
            _ = try await api.me()
            XCTFail("expected unauthorized")
        } catch APIError.unauthorized {
            // expected
        }
        XCTAssertEqual(sentRequests().count, 2)
    }

    /// No refreshed token (the refresh itself was rejected) means no retry.
    func testNoRetryWhenRefreshFails() async throws {
        let api = LiveAPI(
            baseURL: URL(string: "https://api.test")!,
            tokens: LiveAPI.TokenSource(current: { "access-1" }, refresh: { _ in nil })
        )
        StubURLProtocol.respond(sequence: [(401, #"{"error": "unauthorized"}"#)])
        do {
            _ = try await api.vehicles()
            XCTFail("expected unauthorized")
        } catch APIError.unauthorized {
            // expected
        }
        XCTAssertEqual(sentRequests().count, 1)
    }

    // MARK: - Sign-in (no bearer: the credential is in the body)

    func testAuthMethodsIsAPublicGet() async throws {
        StubURLProtocol.respond(json: #"{"apple": true, "email": false, "google": false}"#)
        let methods = try await api.authMethods()

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path(), "/auth/methods")
        XCTAssertNil(bearer(request), "asked before anyone is signed in")
        XCTAssertEqual(methods, .appleOnly)
    }

    func testAppleSignInPostsTheIdentityTokenAndName() async throws {
        StubURLProtocol.respond(json: Self.sessionBody)
        let session = try await api.signInWithApple(
            identityToken: "apple-jwt",
            deviceId: "device-1",
            fullName: (given: "Pat", family: "Driver")
        )

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/auth/apple")
        XCTAssertNil(bearer(request), "sign-in must not carry a stale access token")
        let sent = try body(request)
        XCTAssertEqual(sent["identityToken"] as? String, "apple-jwt")
        XCTAssertEqual(sent["deviceId"] as? String, "device-1")
        XCTAssertEqual(
            sent["fullName"] as? [String: String],
            ["givenName": "Pat", "familyName": "Driver"]
        )
        XCTAssertEqual(session.refreshToken, "new-refresh")
        XCTAssertEqual(session.user.email, "driver@example.com")
    }

    func testGoogleSignInPostsTheIdToken() async throws {
        StubURLProtocol.respond(json: Self.sessionBody)
        _ = try await api.signInWithGoogle(idToken: "google-jwt", deviceId: "device-1")

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/auth/google")
        XCTAssertNil(bearer(request))
        XCTAssertEqual(try body(request) as? [String: String], ["idToken": "google-jwt", "deviceId": "device-1"])
    }

    func testEmailStartAndVerify() async throws {
        StubURLProtocol.respond(json: #"{"ok": true}"#)
        try await api.startEmailSignIn(email: "driver@example.com")
        var request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/auth/email/start")
        XCTAssertNil(bearer(request))
        XCTAssertEqual(try body(request) as? [String: String], ["email": "driver@example.com"])

        StubURLProtocol.respond(json: Self.sessionBody)
        _ = try await api.verifyEmailSignIn(email: "driver@example.com", code: "123456", deviceId: "device-1")
        request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/auth/email/verify")
        XCTAssertNil(bearer(request))
        XCTAssertEqual(
            try body(request) as? [String: String],
            ["email": "driver@example.com", "code": "123456", "deviceId": "device-1"]
        )
    }

    /// A wrong code's typed reason reaches the screen, not a generic 401.
    func testEmailVerifyRefusalKeepsItsReason() async throws {
        StubURLProtocol.respond(sequence: [(401, #"{"error": "invalid_code"}"#)])
        do {
            _ = try await api.verifyEmailSignIn(email: "d@example.com", code: "000000", deviceId: "device-1")
            XCTFail("expected a refusal")
        } catch APIError.refused(let code) {
            XCTAssertEqual(code, "invalid_code")
        }
        // A sign-in 401 is a verdict on the code, not on a session: never
        // "refresh and retry".
        XCTAssertEqual(sentRequests().count, 1)
    }

    // MARK: - Refresh and logout

    func testRefreshPostsTheRefreshTokenAndDeviceWithoutABearer() async throws {
        StubURLProtocol.respond(json: Self.sessionBody)
        let outcome = await api.refreshSession(refreshToken: "refresh-1", deviceId: "device-1")

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/auth/refresh")
        XCTAssertNil(bearer(request))
        XCTAssertEqual(try body(request) as? [String: String], ["refreshToken": "refresh-1", "deviceId": "device-1"])
        guard case .refreshed(let session) = outcome else {
            return XCTFail("expected .refreshed, got \(outcome)")
        }
        XCTAssertEqual(session.accessToken, "new-access")
    }

    /// Rejected means sign out; anything that isn't a verdict on the token
    /// must leave the session alone — the difference between a revoked
    /// family and a subway ride. The JSON-bodied 429 and 503 are the cases
    /// that used to sign people out: the generic transport turns them into
    /// named refusals.
    func testRefreshTellsARejectionFromAnOutage() async throws {
        for (status, body) in [
            (401, #"{"error": "token_reused"}"#),
            (401, #"{"error": "device_mismatch"}"#),
            (400, #"{"error": {}}"#),
        ] {
            StubURLProtocol.respond(sequence: [(status, body)])
            guard case .rejected = await api.refreshSession(refreshToken: "r", deviceId: "d") else {
                return XCTFail("\(status) \(body) is a verdict: must be .rejected")
            }
        }
        for (status, body) in [
            (429, #"{"error": "rate_limited"}"#),
            (503, #"{"error": "auth_not_configured"}"#),
            (500, #"{"error": "internal"}"#),
            (502, "<html>bad gateway</html>"),
            (200, "not json"),
        ] {
            StubURLProtocol.respond(sequence: [(status, body)])
            guard case .unreachable = await api.refreshSession(refreshToken: "r", deviceId: "d") else {
                return XCTFail("\(status) \(body) is no verdict: must be .unreachable, never a sign-out")
            }
        }
    }

    func testLogoutSendsTheRefreshToken() async throws {
        StubURLProtocol.respond(json: #"{"ok": true}"#)
        try await api.logout(refreshToken: "refresh-1")

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/auth/logout")
        XCTAssertEqual(try body(request) as? [String: String], ["refreshToken": "refresh-1"])
    }

    // MARK: - Account (bearer)

    func testMeReadEditAndDelete() async throws {
        StubURLProtocol.respond(json: #"{"user": \#(Self.userBody), "paymentSource": "provider_card", "issuingLive": false}"#)
        let me = try await api.me()
        var request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path(), "/me")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        XCTAssertEqual(me.user.id, "u1")

        StubURLProtocol.respond(json: #"{"user": \#(Self.userBody)}"#)
        let user = try await api.updateMe(name: "Driver", phone: "6175550100")
        request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path(), "/me")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        XCTAssertEqual(try body(request) as? [String: String], ["name": "Driver", "phone": "6175550100"])
        XCTAssertEqual(user.phone, "6175550100")

        StubURLProtocol.respond(json: #"{"ok": true}"#)
        try await api.deleteAccount()
        request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path(), "/me")
        XCTAssertEqual(bearer(request), "Bearer access-1")
    }

    func testVehiclesCrud() async throws {
        StubURLProtocol.respond(json: #"{"vehicles": [\#(Self.vehicleBody)]}"#)
        let cars = try await api.vehicles()
        var request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path(), "/me/vehicles")
        XCTAssertEqual(cars.map(\.plate), ["ABC1234"])

        StubURLProtocol.respond(json: #"{"vehicle": \#(Self.vehicleBody)}"#)
        _ = try await api.addVehicle(plate: "ABC1234", state: "MA", label: "Civic")
        request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/me/vehicles")
        XCTAssertEqual(try body(request) as? [String: String], ["plate": "ABC1234", "state": "MA", "label": "Civic"])

        StubURLProtocol.respond(json: #"{"vehicle": \#(Self.vehicleBody)}"#)
        _ = try await api.updateVehicle(id: "v1", plate: nil, state: nil, label: "Work car")
        request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path(), "/me/vehicles/v1")
        XCTAssertEqual(try body(request) as? [String: String], ["label": "Work car"])

        StubURLProtocol.respond(json: #"{"ok": true}"#)
        try await api.removeVehicle(id: "v1")
        request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path(), "/me/vehicles/v1")
        XCTAssertEqual(bearer(request), "Bearer access-1")
    }

    // MARK: - Assistant (bearer; the message route streams SSE)

    /// What the SSE route writes: a text delta, the plan as its own event,
    /// then `done` with the full payload.
    private static let sseBody = [
        "event: text",
        #"data: {"delta": "Street is cheapest."}"#,
        "",
        "event: plan",
        #"data: {"planId": "p1", "plan": {"kind": "single_spot", "options": [{"id": "s1", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.1, "durationMinutes": 60, "recommended": true}]}}"#,
        "",
        "event: done",
        #"data: {"conversationId": "conv_1", "reply": "Street is cheapest.", "plan": null}"#,
        "",
    ].joined(separator: "\n")

    /// Drain a stream into a readable trace of what it yielded.
    private func trace(_ stream: AsyncThrowingStream<AssistantEvent, Error>) async throws -> [String] {
        var events: [String] = []
        for try await event in stream {
            switch event {
            case .delta(let text): events.append("delta:\(text)")
            case .plan(let plan): events.append("plan:\(plan.planId)")
            case .done(let reply): events.append("done:\(reply.conversationId)")
            }
        }
        return events
    }

    private func ask(_ api: LiveAPI? = nil) -> AsyncThrowingStream<AssistantEvent, Error> {
        (api ?? self.api).assistantMessage(
            text: "parking near Newbury?",
            conversationId: "conv_1",
            location: (lat: 42.3503, lng: -71.0811)
        )
    }

    func testAssistantMessageStreamsOverTheSharedTransport() async throws {
        StubURLProtocol.respond(json: Self.sseBody)
        let events = try await trace(ask())

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/assistant/message")
        XCTAssertNil(request.url?.query(), "the message route takes no query")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let sent = try body(request)
        XCTAssertEqual(sent["text"] as? String, "parking near Newbury?")
        XCTAssertEqual(sent["conversation_id"] as? String, "conv_1")
        XCTAssertEqual(sent["location"] as? [String: Double], ["lat": 42.3503, "lng": -71.0811])

        XCTAssertEqual(events, ["delta:Street is cheapest.", "plan:p1", "done:conv_1"])
    }

    /// The access token lapsed while the user typed: the stream's first
    /// open is a 401, one silent refresh, and the SAME request again with
    /// the new token — the reply still streams.
    func testAssistantStreamRefreshesOnceAndRetriesTheSameRequest() async throws {
        StubURLProtocol.respond(sequence: [
            (401, #"{"error": "unauthorized"}"#),
            (200, Self.sseBody),
        ])
        let events = try await trace(ask())

        let requests = sentRequests()
        XCTAssertEqual(requests.map(bearer), ["Bearer access-1", "Bearer access-2"])
        XCTAssertEqual(requests.map { $0.url?.path() }, ["/assistant/message", "/assistant/message"])
        XCTAssertEqual(try requests.map { try body($0)["text"] as? String }, [
            "parking near Newbury?", "parking near Newbury?",
        ])
        XCTAssertEqual(events, ["delta:Street is cheapest.", "plan:p1", "done:conv_1"])
    }

    func testAssistantStreamSecondUnauthorizedIsFinal() async throws {
        StubURLProtocol.respond(sequence: [
            (401, #"{"error": "unauthorized"}"#),
            (401, #"{"error": "unauthorized"}"#),
            (200, Self.sseBody),
        ])
        do {
            _ = try await trace(ask())
            XCTFail("expected unauthorized")
        } catch APIError.unauthorized {
            // expected
        }
        XCTAssertEqual(sentRequests().count, 2, "one try, one retry, no loop")
    }

    func testAssistantStreamWithoutARefreshedTokenDoesNotRetry() async throws {
        let api = LiveAPI(
            baseURL: URL(string: "https://api.test")!,
            tokens: LiveAPI.TokenSource(current: { "access-1" }, refresh: { _ in nil })
        )
        StubURLProtocol.respond(sequence: [(401, #"{"error": "unauthorized"}"#)])
        do {
            _ = try await trace(ask(api))
            XCTFail("expected unauthorized")
        } catch APIError.unauthorized {
            // expected
        }
        XCTAssertEqual(sentRequests().count, 1)
    }

    /// Over the daily model-spend cap the server refuses before any model
    /// call; the stream must carry that CODE, not a bare "error 429".
    func testAssistantStreamKeepsANamedRefusal() async throws {
        StubURLProtocol.respond(sequence: [
            (429, #"{"error": "assistant_budget_exhausted", "spentUsd": 5.01, "capUsd": 5}"#),
        ])
        do {
            _ = try await trace(ask())
            XCTFail("expected a refusal")
        } catch APIError.refused(let code) {
            XCTAssertEqual(code, "assistant_budget_exhausted")
        }
        XCTAssertEqual(sentRequests().count, 1, "a refusal is not a reason to retry")
    }

    func testAssistantConfirmAndItineraryCalls() async throws {
        StubURLProtocol.respond(json: #"{"kind": "street_confirmed", "zoneId": "bos-1", "durationMinutes": 60}"#)
        _ = try await api.confirmPlan(planId: "p1", optionId: "s1")
        var request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/assistant/confirm")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        XCTAssertEqual(try body(request) as? [String: String], ["planId": "p1", "optionId": "s1"])

        StubURLProtocol.respond(json: #"{"itineraries": []}"#)
        _ = try await api.itineraries()
        request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path(), "/assistant/itineraries")
        XCTAssertEqual(bearer(request), "Bearer access-1")

        let stop = ItineraryStop(
            id: "stop-1", label: "Coffee", address: "1 Main St", lat: 42.35, lng: -71.08,
            arrival: "2026-01-05T09:00:00-05:00", durationMinutes: 60, choice: "street",
            costUsd: 4.1, zoneId: "bos-1", garageOptionId: nil, deepLink: nil,
            sessionId: nil, paymentSource: nil, garageLinkPushedAt: nil
        )
        StubURLProtocol.respond(json: #"{"id": "i 1", "stops": [], "totalUsd": 4.1, "capUsd": 60}"#)
        _ = try await api.patchItinerary(id: "i 1", stops: [stop])
        request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path(percentEncoded: true), "/assistant/itineraries/i%201")
        XCTAssertNil(request.url?.query())
        let stops = try XCTUnwrap(try body(request)["stops"] as? [[String: Any]])
        XCTAssertEqual(stops.first?["id"] as? String, "stop-1")
        XCTAssertEqual(stops.first?["arrival"] as? String, "2026-01-05T09:00:00-05:00")
    }
}

/// Answers each request with the next canned response and records what was
/// sent. Registered only for the duration of a test.
final class StubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var responses: [(status: Int, body: Data)] = []
    nonisolated(unsafe) private static var requests: [URLRequest] = []

    /// Every request gets this 200 body.
    static func respond(json: String) {
        respond(sequence: [(200, json)])
    }

    /// Responses in order; the last one repeats once the list runs out.
    static func respond(sequence: [(Int, String)]) {
        lock.withLock {
            responses = sequence.map { (status: $0.0, body: Data($0.1.utf8)) }
            requests = []
        }
    }

    static var recorded: [URLRequest] {
        lock.withLock { requests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let next = Self.lock.withLock { () -> (status: Int, body: Data) in
            // Only api.test consumes the script; the host app's own calls
            // get the current head without advancing it.
            let head = Self.responses.first ?? (status: 200, body: Data("{}".utf8))
            guard request.url?.host() == "api.test" else { return head }
            Self.requests.append(request)
            if Self.responses.count > 1 { Self.responses.removeFirst() }
            return head
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: next.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: next.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
