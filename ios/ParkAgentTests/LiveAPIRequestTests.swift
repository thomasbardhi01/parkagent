import XCTest
@testable import ParkAgent

/// What LiveAPI actually puts on the wire. The regression this pins: query
/// strings were folded into the path, and `URL.appending(path:)` encodes
/// "?" — so GET /city, /providers/:id/link-status, /card/transactions?cursor
/// and /zones/near all reached the server as unmatched PATHS and 404'd on
/// every device. The mock never builds a URL, so only a test at this layer
/// can see it.
final class LiveAPIRequestTests: XCTestCase {
    private let api = LiveAPI(baseURL: URL(string: "https://api.test")!, apiKey: "test-key")

    override func setUp() {
        super.setUp()
        URLProtocol.registerClass(StubURLProtocol.self)
    }

    override func tearDown() {
        URLProtocol.unregisterClass(StubURLProtocol.self)
        super.tearDown()
    }

    /// The single request this test sent. The unit-test host is the app
    /// itself, which may make its own calls; only api.test is ours.
    private func sentRequest() throws -> URLRequest {
        let ours = StubURLProtocol.recorded.filter { $0.url?.host() == "api.test" }
        XCTAssertEqual(ours.count, 1, "expected exactly one request to api.test")
        return try XCTUnwrap(ours.last)
    }

    private func query(_ request: URLRequest) -> [String: String] {
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }

    /// A real GET /zones/near body, captured from the API against the dev
    /// database (Boylston St, radius 150, trimmed to two zones and three
    /// vertices each): fractional-second `at`, an unnumbered zone's empty
    /// providerZoneNumber, and GeoJSON [lng, lat] order.
    private static let nearbyZonesBody = #"""
    {"radiusM": 150, "at": "2026-09-24T15:44:09.605Z", "truncated": false, "zones": [{"zoneId": "bos-boylston-st-d-c-0cf971", "city": "bos", "providerZoneNumber": "456", "street": "BOYLSTON ST D-C", "rateFirstHourUsd": 3.75, "rateAdditionalHourUsd": 3.75, "maxStayMinutes": 120, "distanceM": 4.7, "enforcedNow": true, "todayHours": [{"start": "08:00", "end": "20:00"}], "hours": [{"end": "20:00", "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], "start": "08:00"}], "centerline": [[[-71.076681, 42.350198], [-71.076325, 42.350457], [-71.076148, 42.350331]]]}, {"zoneId": "bos-newbury-st-c-d-cf7f31", "city": "bos", "providerZoneNumber": "", "street": "NEWBURY ST C-D", "rateFirstHourUsd": 3.75, "rateAdditionalHourUsd": 3.75, "maxStayMinutes": 120, "distanceM": 85.8, "enforcedNow": true, "todayHours": [{"start": "08:00", "end": "20:00"}], "hours": [{"end": "20:00", "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], "start": "08:00"}], "centerline": [[[-71.077271, 42.351131], [-71.07715, 42.350968], [-71.076829, 42.351245]]]}]}
    """#

    func testNearbyZonesSendsARealQueryAndDecodesTheServerShape() async throws {
        StubURLProtocol.respond(json: Self.nearbyZonesBody)
        let response = try await api.nearbyZones(lat: 42.3503, lng: -71.081, radiusM: 249.6)

        let request = try sentRequest()
        XCTAssertEqual(request.url?.path(), "/zones/near")
        XCTAssertEqual(query(request), ["lat": "42.3503", "lng": "-71.081", "radius": "250"])
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-api-key"), "test-key")

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
}

/// Answers every request with one canned JSON body and records what was
/// sent. Registered only for the duration of a test.
final class StubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var body = Data("{}".utf8)
    nonisolated(unsafe) private static var requests: [URLRequest] = []

    static func respond(json: String) {
        lock.withLock {
            body = Data(json.utf8)
            requests = []
        }
    }

    static var recorded: [URLRequest] {
        lock.withLock { requests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = Self.lock.withLock {
            Self.requests.append(request)
            return Self.body
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
