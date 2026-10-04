import CoreLocation
import XCTest
@testable import ParkAgent

/// What LiveAPI actually puts on the wire. The regression this pins: query
/// strings were folded into the path, and `URL.appending(path:)` encodes
/// "?" — so GET /city, /providers/:id/link-status, /card/transactions?cursor
/// (now /wallet/activity?cursor) and /zones/near all reached the server as
/// unmatched PATHS and 404'd on
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

    /// A GET /garages/near body in the server's shape (routes/garages.ts,
    /// pinned in garagesRoute.test.ts): a deck with a hole, an outline of a
    /// kind this build has never heard of, and one row that isn't a garage
    /// at all.
    private static let nearbyGaragesBody = #"""
    {"radiusM": 1416, "limit": 1000, "truncated": true, "attribution": "© OpenStreetMap contributors", "garages": [{"id": "bos-fixture-deck-0a1b2c", "city": "bos", "name": "Fixture Deck", "operator": "Fixture Parking Co", "kind": "multi_storey", "fee": true, "access": "customers", "capacity": 420, "website": "https://example.com/deck", "polygon": [[-71.0704, 42.3497], [-71.0696, 42.3497], [-71.0696, 42.3503], [-71.0704, 42.3503], [-71.0704, 42.3497]], "holes": [[[-71.0701, 42.3499], [-71.0699, 42.3499], [-71.0699, 42.3501], [-71.0701, 42.3501], [-71.0701, 42.3499]]], "entrances": [[-71.0696, 42.35]], "source": "osm", "sourceVersion": "2026-09-30T12:00:00Z", "containsPoint": true, "distanceM": 0, "nearestEntranceM": 20}, {"id": "bos-fixture-lot-3d4e5f", "city": "bos", "name": null, "operator": null, "kind": "carousel", "fee": null, "access": null, "capacity": null, "website": null, "polygon": [[-71.0714, 42.3497], [-71.0706, 42.3497], [-71.0706, 42.3503], [-71.0714, 42.3497]], "entrances": [], "source": "osm", "sourceVersion": "2026-09-30T12:00:00Z", "containsPoint": false, "distanceM": 12.4, "nearestEntranceM": null}, {"id": 7}]}
    """#

    /// The footprint cache's fetch: one 2 km cell is a 1,416 m circle
    /// around its center and up to the route's 1,000 outlines.
    func testNearbyGaragesAsksForAWholeCellAndDecodesTheServerShape() async throws {
        StubURLProtocol.respond(json: Self.nearbyGaragesBody)
        let response = try await api.nearbyGarages(lat: 42.3503, lng: -71.081, radiusM: 1415.3, limit: 1_000)

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path(), "/garages/near")
        // Rounded up: a radius rounded down would miss the cell's corners.
        XCTAssertEqual(query(request), ["lat": "42.3503", "lng": "-71.081", "radius": "1416", "limit": "1000"])
        XCTAssertEqual(bearer(request), "Bearer access-1")

        XCTAssertTrue(response.truncated)
        XCTAssertEqual(response.attribution, "© OpenStreetMap contributors")
        // The row that isn't a garage is skipped, not the whole cell.
        XCTAssertEqual(response.garages.map(\.id), ["bos-fixture-deck-0a1b2c", "bos-fixture-lot-3d4e5f"])
        let deck = response.garages[0]
        XCTAssertEqual(deck.name, "Fixture Deck")
        XCTAssertEqual(deck.kind, .multiStorey)
        XCTAssertEqual(deck.fee, true)
        XCTAssertEqual(deck.access, "customers")
        XCTAssertEqual(deck.entrances, [[-71.0696, 42.35]])
        XCTAssertEqual(deck.holes?.count, 1)
        // GeoJSON is [lng, lat]: inside the deck, but not in its hole.
        XCTAssertTrue(deck.contains(CLLocationCoordinate2D(latitude: 42.34985, longitude: -71.0703)))
        XCTAssertFalse(deck.contains(CLLocationCoordinate2D(latitude: 42.35, longitude: -71.07)))
        let lot = response.garages[1]
        XCTAssertEqual(lot.kind, .unknown, "a kind this build doesn't know is unknown, not a failure")
        XCTAssertNil(lot.fee)
        XCTAssertNil(lot.name)
        XCTAssertNil(lot.holes)
    }

    /// The radius is the route's to cap (1,500 m): a caller asking for more
    /// is sent as asking for the cap, never refused with a 400.
    func testNearbyGaragesNeverAsksPastTheRoutesLimits() async throws {
        StubURLProtocol.respond(json: #"{"radiusM": 1500, "limit": 1000, "truncated": false, "attribution": "", "garages": []}"#)
        _ = try await api.nearbyGarages(lat: 42.35, lng: -71.08, radiusM: 9_000, limit: 5_000)
        let sent = query(try sentRequest())
        XCTAssertEqual(sent["radius"], "1500")
        XCTAssertEqual(sent["limit"], "1000")
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

    // MARK: - Timeouts, retries, idempotency keys

    private static let extendBody = #"{"sessionId": "s1", "expiresAt": "2026-09-26T16:00:00.000Z", "amountUsd": 1.65}"#

    /// The regression: a payment waited out URLSession's 60 s idle default,
    /// then said "Could not reach the server" while the server finished it.
    func testPaymentsGetRoomReadsFailFast() async throws {
        StubURLProtocol.respond(json: Self.extendBody)
        _ = try await api.extendSession(sessionId: "s1", minutes: 30)
        _ = try? await api.policy()
        let sent = sentRequests()
        XCTAssertEqual(sent.first?.timeoutInterval, LiveAPI.CallPolicy.payment.attemptTimeout)
        XCTAssertEqual(sent.last?.timeoutInterval, LiveAPI.CallPolicy.read.attemptTimeout)
    }

    /// The answer to an extension was lost; the retry carries the same key,
    /// so the server answers it with the first result instead of extending
    /// again.
    func testALostAnswerIsAskedForAgainUnderTheSameKey() async throws {
        StubURLProtocol.respond(sequence: [(StubURLProtocol.timedOut, ""), (200, Self.extendBody)])
        let response = try await api.extendSession(sessionId: "s1", minutes: 30)
        XCTAssertEqual(response.amountUsd, 1.65)

        let sent = sentRequests()
        XCTAssertEqual(sent.count, 2)
        let keys = sent.map { $0.value(forHTTPHeaderField: "Idempotency-Key") }
        XCTAssertNotNil(keys[0])
        XCTAssertEqual(keys[0], keys[1], "a retry must reuse its key, or the server runs it again")
    }

    /// Still running server-side (the first attempt outlived the phone's
    /// wait): ask again until it's done, never run it twice.
    func testAPaymentStillRunningIsWaitedFor() async throws {
        StubURLProtocol.respond(sequence: [
            (409, #"{"error": "request_in_progress", "retryAfterSeconds": 2}"#),
            (200, Self.extendBody),
        ])
        let response = try await api.extendSession(sessionId: "s1", minutes: 30)
        XCTAssertEqual(response.amountUsd, 1.65)
        XCTAssertEqual(sentRequests().count, 2)
    }

    /// Two separate taps are two actions: two keys.
    func testEachCallHasItsOwnKey() async throws {
        StubURLProtocol.respond(json: Self.extendBody)
        _ = try await api.extendSession(sessionId: "s1", minutes: 30)
        _ = try await api.extendSession(sessionId: "s1", minutes: 30)
        let keys = sentRequests().compactMap { $0.value(forHTTPHeaderField: "Idempotency-Key") }
        XCTAssertEqual(Set(keys).count, 2)
    }

    /// Reads retry a gateway error; a verdict is never retried.
    func testReadsRetryGatewayErrorsButNotVerdicts() async throws {
        StubURLProtocol.respond(sequence: [(503, "<html>upstream</html>"), (200, Self.limitsBody)])
        _ = try await api.limits()
        XCTAssertEqual(sentRequests().count, 2)

        StubURLProtocol.respond(sequence: [(400, #"{"error": "invalid_limits", "issues": []}"#), (200, Self.limitsBody)])
        _ = try? await api.updateLimits(SpendingLimits(sessionCapUsd: 1, dailyCapUsd: 1, defaultStayMinutes: 15))
        XCTAssertEqual(sentRequests().count, 1, "a 400 is an answer, not a network problem")
    }

    /// Sign-in isn't keyed (there's no user yet for the server to hold a
    /// key against, and Apple's and email codes are single-use), so it
    /// never retries — nor does a card reveal, whose answer isn't stored.
    func testSignInAndCardRevealAreNeverRetried() async throws {
        StubURLProtocol.respond(sequence: [(StubURLProtocol.connectionLost, ""), (200, Self.sessionBody)])
        await XCTAssertThrowsAsync(try await api.verifyEmailSignIn(email: "a@b.co", code: "123456", deviceId: "device-1"))
        XCTAssertEqual(sentRequests().count, 1)
        XCTAssertNil(sentRequests()[0].value(forHTTPHeaderField: "Idempotency-Key"))

        StubURLProtocol.respond(sequence: [(StubURLProtocol.connectionLost, ""), (200, "{}")])
        await XCTAssertThrowsAsync(try await api.revealLinkCard(spendRequestId: "lsrq_1"))
        XCTAssertEqual(sentRequests().count, 1)
        XCTAssertNil(sentRequests()[0].value(forHTTPHeaderField: "Idempotency-Key"))
    }

    /// A cancelled task stops at once and says it was cancelled — not
    /// "Could not reach the server".
    func testCancellationIsNotAFailure() async throws {
        StubURLProtocol.respond(json: Self.limitsBody)
        let api = self.api
        let task = Task { () -> String in
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                _ = try await api.limits()
                return "succeeded"
            } catch APIError.cancelled {
                return "cancelled"
            } catch {
                return "failed: \(error)"
            }
        }
        let outcome = await task.value
        XCTAssertEqual(outcome, "cancelled")
        XCTAssertTrue(sentRequests().isEmpty)
    }

    // MARK: - Parked

    private static let parkedResponseBody = #"""
    {"action": "unknown_zone", "candidates": [], "quote": null, "rule": "unknown_zone", "dryRun": true, "provider": null, "needsZoneNumber": false, "parkedEventId": "pe1", "decisionId": "d1"}
    """#

    /// The phone's place classification rides in the /parked body (FR-53;
    /// the server reads it from #179 on). A park with no classification
    /// sends no placeHint key at all, exactly as before.
    func testParkedCarriesThePlaceHint() async throws {
        StubURLProtocol.respond(json: Self.parkedResponseBody)
        let hint = PlaceHint(
            placeClass: "garage", confidence: 0.95,
            runnerUp: PlaceHint.Scored(placeClass: "nopay", confidence: 0.3),
            garageId: "fixture-garage",
            entryFix: PlaceHint.EntryFix(lat: 42.35, lng: -71.07, accuracy: 9, ts: Date(timeIntervalSince1970: 1_790_000_000)),
            inputs: PlaceHint.Inputs(
                located: false, memoryHit: false, footprintId: "fixture-garage", containsPoint: true,
                nearestEntranceM: 8, gpsLoss: true, baroDeltaM: 6.5, crawl: true
            )
        )
        let at = Date(timeIntervalSince1970: 1_790_000_060)
        _ = try await api.parked(
            ParkedRequest(lat: 42.35, lng: -71.07, accuracy: 9, ts: at, signals: ["motion_stop"], placeHint: hint),
            idempotencyKey: "park-1"
        )
        let sent = try body(try sentRequest())
        let placeHint = try XCTUnwrap(sent["placeHint"] as? [String: Any])
        XCTAssertEqual(placeHint["class"] as? String, "garage")
        XCTAssertEqual(placeHint["confidence"] as? Double, 0.95)
        XCTAssertEqual(placeHint["garageId"] as? String, "fixture-garage")
        XCTAssertEqual((placeHint["runnerUp"] as? [String: Any])?["class"] as? String, "nopay")
        let entry = try XCTUnwrap(placeHint["entryFix"] as? [String: Any])
        XCTAssertEqual(entry["ts"] as? String, "2026-09-21T14:13:20Z")
        XCTAssertEqual((placeHint["inputs"] as? [String: Any])?["gpsLoss"] as? Bool, true)

        StubURLProtocol.respond(json: Self.parkedResponseBody)
        _ = try await api.parked(ParkedRequest(lat: 42.35, lng: -71.07, accuracy: 9, ts: at, signals: []), idempotencyKey: "park-2")
        XCTAssertNil(try body(try sentRequest())["placeHint"])
    }

    /// What /parked answers for a garage (server routes/parked.ts, pinned
    /// in parkedPlace.test.ts): the new action, `place`, and the street's
    /// candidates still there.
    private static let garageResponseBody = #"""
    {"action": "garage", "candidates": [], "quote": null, "rule": "place_garage", "dryRun": true, "needsZoneNumber": false, "provider": null, "place": {"class": "garage", "confidence": 0.9, "runnerUp": {"class": "street", "confidence": 0.6}, "garageId": "bos-fixture-deck-0a1b2c", "garageName": "Fixture Deck", "source": "footprint", "attribution": "© OpenStreetMap contributors"}, "parkedEventId": "pe1", "decisionId": "d1"}
    """#

    // MARK: - The street session lifecycle (FR-55)

    func testAHeldParkIsReadFromParked() async throws {
        StubURLProtocol.respond(json: Self.parkedResponseBody.replacingOccurrences(
            of: #""parkedEventId""#, with: #""awaitsWalkAway": true, "parkedEventId""#
        ))
        let held = try await api.parked(
            ParkedRequest(lat: 42.35, lng: -71.07, accuracy: 9, ts: Date(), signals: [], outcomes: ParkedRequest.shownOutcomes),
            idempotencyKey: "park-held"
        )
        XCTAssertEqual(held.awaitsWalkAway, true)
        // A server from before the lifecycle says nothing, and nothing is held.
        StubURLProtocol.respond(json: Self.parkedResponseBody)
        let plain = try await api.parked(ParkedRequest(lat: 42.35, lng: -71.07, accuracy: 9, ts: Date(), signals: []), idempotencyKey: "park-plain")
        XCTAssertNil(plain.awaitsWalkAway)
    }

    func testAFixCarriesWhatTheAppSawAndReadsThePromptBack() async throws {
        StubURLProtocol.respond(json: #"""
        {"ok": true, "park": {"parkedEventId": "pe1", "status": "prompted"}, "decisionId": "d9", "prompt": {"kind": "confirm", "parkedEventId": "pe1", "title": "Pay $3.65 for zone 417371?", "body": "1 h 30 m on 30th Ave · ends 3:31 PM", "zoneId": "nyc-417371", "zoneNumber": "417371", "amountUsd": 3.65, "minutes": 90, "endsAt": "2026-01-05T20:31:00.000Z", "quote": {"zoneId": "nyc-417371", "providerZoneNumber": "417371", "stayMinutes": 90, "chargedMinutes": 90, "meterUsd": 3.5, "feeUsd": 0.15, "totalUsd": 3.65}, "dryRun": true}}
        """#)
        let answer = try await api.reportParkLocation(LocationReport(
            lat: 40.7790, lng: -73.9819, accuracy: 8, ts: Date(timeIntervalSince1970: 1_790_000_000), event: "left_car"
        ))
        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/location")
        XCTAssertEqual(try body(request)["event"] as? String, "left_car")

        XCTAssertEqual(answer.park, LocationResponse.Park(parkedEventId: "pe1", status: "prompted"))
        let prompt = try XCTUnwrap(answer.prompt)
        XCTAssertTrue(prompt.payable)
        XCTAssertEqual(prompt.title, "Pay $3.65 for zone 417371?")
        XCTAssertEqual(prompt.amountUsd, 3.65)
        XCTAssertEqual(prompt.quote?.totalUsd, 3.65)
        XCTAssertEqual(prompt.endsAt, Date(timeIntervalSince1970: 1_767_645_060))

        // With nothing seen, no event key is sent; an ended session reads back.
        StubURLProtocol.respond(json: #"{"ok": true, "sessionId": "s1", "ended": {"reason": "returned", "stopped": false}}"#)
        let ended = try await api.reportParkLocation(LocationReport(lat: 40.7784, lng: -73.9819, accuracy: 8, ts: Date()))
        XCTAssertNil(try body(try sentRequest())["event"])
        XCTAssertEqual(ended.ended, LocationResponse.Ended(reason: "returned", stopped: false))
        XCTAssertNil(ended.prompt)
    }

    func testTheTapSendsTheSideAndTheTotalShownUnderAKey() async throws {
        StubURLProtocol.respond(json: #"{"status": "started", "sessionId": "s1", "expiresAt": "2026-01-05T20:31:00.000Z", "amountUsd": 3.65}"#)
        let outcome = try await api.confirmPark(parkedEventId: "pe1", zoneId: "nyc-417371", shownTotalUsd: 3.65)
        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/parked/pe1/confirm")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"), "a retried tap must be answered once")
        let sent = try body(request)
        XCTAssertEqual(sent["zoneId"] as? String, "nyc-417371")
        XCTAssertEqual(sent["shownTotalUsd"] as? Double, 3.65)
        guard case .started(let started) = outcome else { return XCTFail("expected a started session") }
        XCTAssertEqual(started.sessionId, "s1")
        XCTAssertEqual(started.amountUsd, 3.65)

        // Tapped at the car: kept, nothing paid.
        StubURLProtocol.respond(json: #"{"status": "confirmed", "startsAt": "walk_away", "zoneId": "nyc-417371"}"#)
        let early = try await api.confirmPark(parkedEventId: "pe1", zoneId: nil, shownTotalUsd: nil)
        guard case .waitingForWalkAway = early else { return XCTFail("expected the confirmation to wait") }
        XCTAssertTrue(try body(try sentRequest()).isEmpty, "no side and no total: an empty body, not nulls")
    }

    func testARefusedTapIsANamedRefusalAndNotNowIsItsOwnCall() async throws {
        StubURLProtocol.respond(sequence: [(409, #"{"error": "park_closed", "status": "cancelled"}"#)])
        do {
            _ = try await api.confirmPark(parkedEventId: "pe1", zoneId: nil, shownTotalUsd: 3.65)
            XCTFail("a closed park must not read as paid")
        } catch let error as APIError {
            guard case .refused(let code) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(code, "park_closed")
            XCTAssertFalse(error.paymentOutcomeUnknown, "the server answered: nothing was paid")
        }

        StubURLProtocol.respond(json: #"{"status": "declined"}"#)
        try await api.declinePark(parkedEventId: "pe1")
        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/parked/pe1/decline")
    }

    /// FR-54: the app says which place outcomes it can show, and reads the
    /// place back. A server from before FR-54 sends no `place`, and its
    /// answer still decodes.
    func testParkedListsTheOutcomesItShowsAndReadsThePlace() async throws {
        StubURLProtocol.respond(json: Self.garageResponseBody)
        let at = Date(timeIntervalSince1970: 1_790_000_060)
        let response = try await api.parked(
            ParkedRequest(lat: 42.35, lng: -71.07, accuracy: 9, ts: at, signals: [], outcomes: ParkedRequest.shownOutcomes),
            idempotencyKey: "park-1"
        )
        let sent = try body(try sentRequest())
        XCTAssertEqual(sent["outcomes"] as? [String], ["garage", "nopay", "walk_away"])

        XCTAssertEqual(response.action, .garage)
        XCTAssertEqual(response.rule, "place_garage")
        let place = try XCTUnwrap(response.place)
        XCTAssertEqual(place.placeClass, "garage")
        XCTAssertEqual(place.confidence, 0.9)
        XCTAssertEqual(place.runnerUp?.placeClass, "street")
        XCTAssertEqual(place.garageId, "bos-fixture-deck-0a1b2c")
        XCTAssertEqual(place.garageName, "Fixture Deck")
        XCTAssertEqual(place.source, "footprint")
        XCTAssertEqual(place.attribution, "© OpenStreetMap contributors")

        StubURLProtocol.respond(json: Self.parkedResponseBody)
        let old = try await api.parked(ParkedRequest(lat: 42.35, lng: -71.07, accuracy: 9, ts: at, signals: []), idempotencyKey: "park-2")
        XCTAssertNil(old.place)
        XCTAssertNil(try body(try sentRequest())["outcomes"], "a park queued by the previous build lists none")

        StubURLProtocol.respond(json: #"{"action": "nopay", "candidates": [], "quote": null, "rule": "place_nopay", "dryRun": true, "needsZoneNumber": false, "provider": null, "place": {"class": "nopay", "confidence": 0.95, "runnerUp": null, "garageId": null, "garageName": null, "source": "memory", "attribution": null}, "parkedEventId": "pe2", "decisionId": "d2"}"#)
        let silent = try await api.parked(ParkedRequest(lat: 42.35, lng: -71.07, accuracy: 9, ts: at, signals: []), idempotencyKey: "park-3")
        XCTAssertEqual(silent.action, .nopay)
        XCTAssertNil(silent.place?.garageName)
        // A stored park survives a relaunch with its place.
        let restored = try JSONDecoder().decode(ParkedResponse.self, from: JSONEncoder().encode(response))
        XCTAssertEqual(restored.place, response.place)
    }

    /// The driver's answer about a place: one keyed POST per answer.
    func testThePlaceAnswerIsAKeyedPost() async throws {
        let answered = #"{"ok": true, "parkedEventId": "pe 1", "class": "garage", "name": "Work", "was": {"class": "unknown", "confidence": 0, "source": "none", "garageId": null, "garageName": null}, "changed": true, "decisionId": "d9"}"#
        StubURLProtocol.respond(json: answered)
        let response = try await api.answerPlace(parkedEventId: "pe 1", placeClass: "garage", name: "Work")
        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(percentEncoded: false), "/parked/pe 1/place")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
        let sent = try body(request)
        XCTAssertEqual(sent["class"] as? String, "garage")
        XCTAssertEqual(sent["name"] as? String, "Work")
        XCTAssertEqual(response.placeClass, "garage")
        XCTAssertEqual(response.decisionId, "d9")
        XCTAssertTrue(response.changed)

        StubURLProtocol.respond(json: answered)
        _ = try await api.answerPlace(parkedEventId: "pe1", placeClass: "not_here", name: nil)
        let bare = try body(try sentRequest())
        XCTAssertEqual(bare["class"] as? String, "not_here")
        XCTAssertNil(bare["name"], "no name is no key, not a null")
    }

    // MARK: - Limits

    /// The server's own shape (routes/limits.ts, pinned in limits.test.ts).
    private static let limitsBody = #"""
    {"limits": {"sessionCapUsd": 20, "dailyCapUsd": 40, "defaultStayMinutes": 60}, "saved": {"sessionCapUsd": 20, "dailyCapUsd": 40, "defaultStayMinutes": null}, "defaults": {"sessionCapUsd": 45, "dailyCapUsd": 60, "defaultStayMinutes": 90}, "ceilings": {"sessionCapUsd": 45, "dailyCapUsd": 60}, "bounds": {"minCapUsd": 1, "stayMinutes": {"min": 15, "max": 240}}, "clamped": []}
    """#

    /// The app's limit screens save the user's own limits — never the
    /// operator's whole policy document (the old PUT /policy, admin-only).
    func testLimitsSaveToTheUsersOwnEndpoint() async throws {
        StubURLProtocol.respond(json: Self.limitsBody)
        let saved = try await api.updateLimits(SpendingLimits(sessionCapUsd: 20, dailyCapUsd: 40, defaultStayMinutes: 60))

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path(), "/me/limits")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        let sent = try body(request)
        XCTAssertEqual(sent["sessionCapUsd"] as? Double, 20)
        XCTAssertEqual(sent["dailyCapUsd"] as? Double, 40)
        XCTAssertEqual(sent["defaultStayMinutes"] as? Int, 60)
        XCTAssertEqual(saved.limits, SpendingLimits(sessionCapUsd: 20, dailyCapUsd: 40, defaultStayMinutes: 60))
        XCTAssertNil(saved.saved.defaultStayMinutes)
        XCTAssertEqual(saved.ceilings.dailyCapUsd, 60)
    }

    /// A refusal carries the server's sentences; they reach the screen as is.
    func testALimitsRefusalCarriesTheServersSentences() async throws {
        StubURLProtocol.respond(sequence: [(400, #"""
        {"error": "invalid_limits", "issues": [{"field": "sessionCapUsd", "code": "session_above_daily", "message": "Per stop can't be more than per day ($20.00).", "limit": 20}]}
        """#)])
        do {
            _ = try await api.updateLimits(SpendingLimits(sessionCapUsd: 30, dailyCapUsd: 20, defaultStayMinutes: 90))
            XCTFail("expected a refusal")
        } catch let rejected as LimitsRejected {
            XCTAssertEqual(rejected.errorDescription, "Per stop can't be more than per day ($20.00).")
            XCTAssertEqual(rejected.issues.first?.code, "session_above_daily")
        }
    }

    /// The cursor is an ISO timestamp; a "+hh:mm" offset must survive, and
    /// the server reads a bare "+" as a space.
    func testActivityCursorKeepsItsPlus() async throws {
        StubURLProtocol.respond(json: #"{"items": [], "nextCursor": null}"#)
        _ = try await api.walletActivity(cursor: "2026-09-24T11:44:09.605+04:00")

        let request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/wallet/activity")
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

    func testAppleSignInPostsTheIdentityTokenCodeAndName() async throws {
        StubURLProtocol.respond(json: Self.sessionBody)
        let session = try await api.signInWithApple(
            identityToken: "apple-jwt",
            authorizationCode: "apple-code",
            deviceId: "device-1",
            fullName: (given: "Pat", family: "Driver")
        )

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/auth/apple")
        XCTAssertNil(bearer(request), "sign-in must not carry a stale access token")
        let sent = try body(request)
        XCTAssertEqual(sent["identityToken"] as? String, "apple-jwt")
        // What the server exchanges for the token it revokes on delete.
        XCTAssertEqual(sent["authorizationCode"] as? String, "apple-code")
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

    // MARK: - Wallet

    /// A real GET /wallet body, captured from the server's own route (a
    /// ParkAgent-card user in sandbox with one captured hold): every field
    /// the Wallet, Account row, and onboarding read must decode from it.
    private static let walletBody = #"""
    {"activeSource":"parkagent_card","dryRun":true,"options":[{"source":"provider_card","availability":"available","needs":null,"sandbox":false},{"source":"link_wallet","availability":"coming_soon","needs":null,"sandbox":false},{"source":"parkagent_card","availability":"available","needs":null,"sandbox":true}],"providerCard":{"cards":[{"provider":"passport","displayName":"ParkBoston","city":"bos","brand":"Visa","last4":"1234"}]},"link":{"configured":false,"connected":false,"paymentMethod":null,"pendingApprovals":[],"manageUrl":"https://app.link.com","covers":"plans_and_garages"},"parkagentCard":{"live":false,"sandboxSelectable":true,"fundingMethods":[{"id":"fm1","brand":"Visa","last4":"4242","wallet":"apple_pay","expMonth":12,"expYear":2031,"isDefault":true}],"card":{"stripeCardId":"ic_u1","last4":"4444","brand":"Visa","status":"active","expMonth":8,"expYear":2030,"cardholderName":"Thomas"}},"providers":[{"id":"parknyc","city":"nyc","cityDisplayName":"New York City","displayName":"ParkNYC","status":"unlinked","paysWith":null,"attention":"connect"},{"id":"passport","city":"bos","cityDisplayName":"Boston","displayName":"ParkBoston","status":"linked","paysWith":{"source":"parkagent_card","brand":"Visa","last4":"4444"},"attention":null}],"spending":{"todayUsd":4.1,"dailyCapUsd":60,"sessionCapUsd":45,"monthUsd":4.1,"byCity":[{"city":"bos","cityDisplayName":"Boston","monthUsd":4.1},{"city":"nyc","cityDisplayName":"New York City","monthUsd":0}],"linkMonthUsd":0},"activity":{"items":[{"id":"session:s1","kind":"session","at":"2026-01-05T19:00:00.000Z","createdAt":"2026-01-05T19:00:00.000Z","sessionId":"s1","city":"bos","cityDisplayName":"Boston","providerDisplayName":"ParkBoston","zoneNumber":"456","street":null,"durationMinutes":60,"meterUsd":3.75,"feeUsd":0.35,"totalUsd":4.1,"status":"stopped","dryRun":false,"paymentSource":"parkagent_card","explanation":"Paid with the ParkAgent card — $4.10 taken from your card, the rest of the hold released.","startedAt":"2026-01-05T19:00:00.000Z","expiresAt":null,"stoppedAt":null,"lat":42.3495,"lng":-71.0798,"receipt":{"providerConfirmation":"PB-1","decisionId":null,"holds":[{"leg":"start","heldUsd":6.1,"capturedUsd":4.1,"status":"captured","paymentIntentId":"pi_seed_1"}]},"timeline":[{"kind":"hold_placed","at":"2026-01-05T19:00:00.000Z","minutes":null,"amountUsd":6.1,"code":null},{"kind":"started","at":"2026-01-05T19:00:00.000Z","minutes":60,"amountUsd":4.1,"code":null},{"kind":"hold_captured","at":"2026-01-05T19:01:00.000Z","minutes":null,"amountUsd":4.1,"code":null}]}],"nextCursor":null}}
    """#

    func testWalletDecodesTheServerShape() async throws {
        StubURLProtocol.respond(json: Self.walletBody)
        let wallet = try await api.wallet()

        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path(), "/wallet")
        XCTAssertEqual(bearer(request), "Bearer access-1")

        XCTAssertEqual(wallet.activeSource, .parkagentCard)
        XCTAssertEqual(wallet.options.map(\.source), [.providerCard, .linkWallet, .parkagentCard])
        XCTAssertEqual(wallet.option(.linkWallet)?.availability, "coming_soon")
        XCTAssertEqual(wallet.option(.parkagentCard)?.sandbox, true)
        XCTAssertEqual(wallet.parkagentCard.defaultFundingMethod?.wallet, "apple_pay")
        XCTAssertEqual(wallet.parkagentCard.card?.last4, "4444")
        XCTAssertEqual(wallet.providers.first { $0.id == "passport" }?.paysWith?.source, .parkagentCard)
        XCTAssertEqual(wallet.spending.byCity.map(\.city), ["bos", "nyc"])
        XCTAssertEqual(wallet.spending.linkMonthUsd, 0)
        let item = try XCTUnwrap(wallet.activity.items.first)
        XCTAssertEqual(item.kind, "session")
        XCTAssertEqual(item.receipt?.holds?.first?.capturedUsd, 4.1)
        XCTAssertEqual(item.timeline?.map(\.kind), ["hold_placed", "started", "hold_captured"])
    }

    func testSetWalletSourceSendsSandboxAndConsentOnlyWhenTrue() async throws {
        StubURLProtocol.respond(json: #"{"activeSource": "parkagent_card", "setupJobs": [{"provider": "passport", "jobId": "j1"}], "decisionId": "d1"}"#)
        let result = try await api.setWalletSource(.parkagentCard, sandbox: true, consent: true)
        var request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path(), "/wallet/source")
        let sent = try body(request)
        XCTAssertEqual(sent["source"] as? String, "parkagent_card")
        XCTAssertEqual(sent["sandbox"] as? Bool, true)
        XCTAssertEqual(sent["consentReplacePaymentMethod"] as? Bool, true)
        XCTAssertEqual(result.setupJobs.first?.jobId, "j1")

        StubURLProtocol.respond(json: #"{"activeSource": "provider_card", "setupJobs": [], "decisionId": "d2"}"#)
        _ = try await api.setWalletSource(.providerCard, sandbox: false, consent: false)
        request = try sentRequest()
        // A Release build never claims sandbox; nothing agreed, nothing sent.
        XCTAssertEqual(try body(request).keys.sorted(), ["source"])
    }

    func testSavingACardIsTwoCalls() async throws {
        StubURLProtocol.respond(json: #"{"setupIntentId": "seti_1", "clientSecret": "seti_1_secret", "customerId": "cus_1", "merchantId": "merchant.com.thomasbardhi.parkagent"}"#)
        let intent = try await api.walletSetupIntent(sandbox: false)
        var request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/wallet/setup-intent")
        XCTAssertEqual(intent.merchantId, "merchant.com.thomasbardhi.parkagent")

        StubURLProtocol.respond(json: #"{"fundingMethod": {"id": "fm1", "brand": "Visa", "last4": "4242", "wallet": null, "expMonth": 12, "expYear": 2031, "isDefault": true}}"#)
        let saved = try await api.addFundingMethod(setupIntentId: "seti_1")
        request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/wallet/funding-methods")
        XCTAssertEqual(try body(request) as? [String: String], ["setupIntentId": "seti_1"])
        XCTAssertEqual(saved.fundingMethod.last4, "4242")
    }

    func testLinkCardRevealPostsToTheSpendRequest() async throws {
        StubURLProtocol.respond(json: #"{"spendRequestId": "lsrq_1", "brand": "visa", "number": "4000009990001984", "cvc": "100", "expMonth": 6, "expYear": 2029, "validUntil": "2026-09-25T02:00:00.000Z"}"#)
        let card = try await api.revealLinkCard(spendRequestId: "lsrq_1")
        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/link/spend-requests/lsrq_1/card")
        XCTAssertEqual(card.expYear, 2029)
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

    /// #131: the card's live price is the server's. A body captured from
    /// the real route (server test app, a lengthened stop and a cleared
    /// time), decoded as the app sees it; the card's stops go up as sent.
    func testItineraryPriceOnTheWire() async throws {
        StubURLProtocol.respond(json: #"""
        {"planId":"plan1","stops":[{"id":"s1","label":"Coffee","address":"1 Main St","lat":40.77,"lng":-73.92,"arrival":"2026-01-05T10:00:00-05:00","durationMinutes":90,"choice":"street","costUsd":30.15,"zoneId":"nyc-417371"},{"id":"s2","label":"Museum","address":"2 Main St","lat":40.77,"lng":-73.92,"arrival":null,"durationMinutes":60,"choice":"street","costUsd":5,"zoneId":"nyc-417371","estimate":true}],"totalUsd":35.15,"capUsd":60,"spentTodayUsd":0,"remainingUsd":60,"fitsCap":true}
        """#)
        let stop = ItineraryStop(
            id: "s1", label: "Coffee", address: "1 Main St", lat: 40.77, lng: -73.92,
            arrival: "2026-01-05T10:00:00-05:00", durationMinutes: 90, choice: "street",
            costUsd: 5, zoneId: "nyc-417371", garageOptionId: nil, deepLink: nil,
            sessionId: nil, paymentSource: nil, garageLinkPushedAt: nil
        )
        let priced = try await api.priceItinerary(planId: "plan1", stops: [stop])
        let request = try sentRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/assistant/plans/plan1/price")
        XCTAssertEqual(bearer(request), "Bearer access-1")
        let sent = try XCTUnwrap(try body(request)["stops"] as? [[String: Any]])
        XCTAssertEqual(sent.first?["durationMinutes"] as? Int, 90)

        XCTAssertEqual(priced.stops.map(\.costUsd), [30.15, 5])
        XCTAssertNil(priced.stops[0].estimate)
        XCTAssertEqual(priced.stops[1].estimate, true)
        XCTAssertNil(priced.stops[1].arrival, "a cleared time decodes as no set time")
        XCTAssertEqual(priced.totalUsd, 35.15)
        XCTAssertEqual(priced.capUsd, 60)
        XCTAssertTrue(priced.fitsCap)

        // Sign-off carries the card's stops with it.
        StubURLProtocol.respond(json: #"{"kind": "itinerary_signed_off", "itineraryId": "day-1", "totalUsd": 35.15}"#)
        _ = try await api.confirmPlan(planId: "plan1", optionId: nil, stops: [stop])
        let confirm = try sentRequest()
        XCTAssertEqual(confirm.url?.path(), "/assistant/confirm")
        let confirmBody = try body(confirm)
        XCTAssertEqual(confirmBody["planId"] as? String, "plan1")
        XCTAssertEqual((confirmBody["stops"] as? [[String: Any]])?.first?["id"] as? String, "s1")
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

    /// A scripted status below zero is a network failure, not an answer.
    static let timedOut = -1
    static let connectionLost = -2

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
        if next.status < 0 {
            let code: URLError.Code = next.status == Self.timedOut ? .timedOut : .networkConnectionLost
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
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

/// XCTAssertThrowsError for async expressions.
func XCTAssertThrowsAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("expected an error", file: file, line: line)
    } catch {}
}
