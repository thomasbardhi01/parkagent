import XCTest
@testable import ParkAgent

/// Saved conversations on the wire (server/API.md "Saved conversations"):
/// the paths, methods, and cursor query LiveAPI sends, and the server's own
/// bodies decoding as the app reads them. The mock never builds a URL, so
/// only this layer can see a wrong one.
final class ConversationWireTests: XCTestCase {
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

    private func lastRequest() throws -> URLRequest {
        try XCTUnwrap(StubURLProtocol.recorded.last { $0.url?.host() == "api.test" })
    }

    func testListSendsTheCursorAsAQueryAndDecodesTheServerShape() async throws {
        // The shape GET /assistant/conversations answers (assistantHistory.test.ts).
        StubURLProtocol.respond(json: #"""
        {"conversations":[{"id":"conv_1","title":"garage near the museum","createdAt":"2026-01-05T16:00:00.000Z","updatedAt":"2026-01-05T16:00:00.000Z","messageCount":2,"outcome":{"kind":"garage","label":"Garage — Underground Deck","amountUsd":18,"planId":"p1","at":"2026-01-05T16:00:00.000Z"}}],"nextCursor":"2026-01-05T16:00:00.000Z","retentionDays":90}
        """#)
        let page = try await api.conversations(cursor: "2026-01-05T17:00:00.000Z")
        let request = try lastRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path(), "/assistant/conversations")
        let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "cursor" }?.value
        XCTAssertEqual(cursor, "2026-01-05T17:00:00.000Z")
        XCTAssertEqual(page.conversations.first?.title, "garage near the museum")
        XCTAssertEqual(page.conversations.first?.outcome?.label, "Garage — Underground Deck")
        XCTAssertEqual(page.retentionDays, 90)
        XCTAssertEqual(page.nextCursor, "2026-01-05T16:00:00.000Z")
    }

    func testOpenDecodesMessagesAndStoredPlans() async throws {
        StubURLProtocol.respond(json: #"""
        {"id":"conv_1","title":"garage near the museum","createdAt":"2026-01-05T16:00:00.000Z","updatedAt":"2026-01-05T16:00:00.000Z","messages":[{"role":"user","text":"garage near the museum","at":"2026-01-05T16:00:00.000Z"},{"role":"assistant","text":"Here are your options — tap one to go ahead.","at":"2026-01-05T16:00:00.000Z","planId":"p1"}],"plans":[{"planId":"p1","plan":{"kind":"single_spot","options":[{"id":"garage-g1","type":"garage","label":"Underground Deck","detail":"","priceUsd":18,"durationMinutes":120,"garageOptionId":"g1","recommended":true}]},"confirmedAt":"2026-01-05T16:01:00.000Z","confirmedOptionId":"garage-g1"}],"outcome":null}
        """#)
        let detail = try await api.conversation(id: "conv 1")
        XCTAssertEqual(try lastRequest().url?.path(percentEncoded: true), "/assistant/conversations/conv%201")
        XCTAssertEqual(detail.messages.map(\.role), ["user", "assistant"])
        XCTAssertEqual(detail.messages.last?.planId, "p1")
        XCTAssertEqual(detail.plans.first?.confirmedOptionId, "garage-g1")
        XCTAssertNotNil(detail.plans.first?.confirmedAt)
    }

    func testDeletesAreDeletes() async throws {
        StubURLProtocol.respond(json: #"{"deleted": 1}"#)
        try await api.deleteConversation(id: "conv_1")
        var request = try lastRequest()
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path(), "/assistant/conversations/conv_1")
        // A bodyless DELETE carries no JSON content type (the server refuses
        // an empty JSON body).
        XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))

        StubURLProtocol.respond(json: #"{"deleted": 3}"#)
        let deleted = try await api.deleteAllConversations()
        request = try lastRequest()
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path(), "/assistant/conversations")
        XCTAssertEqual(deleted, 3)
    }
}
