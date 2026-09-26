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

    /// A body captured from the real route (local API over an isolated DB,
    /// 2026-09-25): the transcript, the plan with its server-attached street
    /// facts and assumptions, and the confirmed option.
    func testOpenDecodesTheCapturedServerBody() async throws {
        StubURLProtocol.respond(json: #"""
        {"id":"conv_fr_local","title":"Find me a parking spot at Seaport at 7 PM near Lola 42 for three hours","createdAt":"2026-09-26T01:12:17.217Z","updatedAt":"2026-09-26T01:12:17.217Z","messages":[{"at":"2026-09-26T00:10:00.000Z","role":"user","text":"Find me a parking spot at Seaport at 7 PM near Lola 42 for three hours"},{"at":"2026-09-26T00:10:05.000Z","role":"assistant","text":"Here are your options (7:00–10:00 PM, near LoLa 42, Seaport) — tap one to go ahead.","planId":"fr-local-plan"}],"plans":[{"planId":"fr-local-plan","plan":{"kind":"single_spot","options":[{"id":"street-1","type":"street","label":"Seaport Blvd","detail":"","zoneId":"bos-seaport-blvd-de413d-01","priceUsd":0,"recommended":true,"streetState":"free","streetSummary":"Free after 6 PM on Seaport Blvd — 4 min walk","durationMinutes":180}],"assumptions":"7:00–10:00 PM, near LoLa 42, Seaport","destination":{"lat":42.35458,"lng":-71.04526,"label":"LoLa 42, Seaport"}},"confirmedAt":"2026-09-26T01:12:17.257Z","confirmedOptionId":"street-1"}],"outcome":{"kind":"street","label":"Street — Seaport Blvd","amountUsd":0,"planId":"fr-local-plan","at":"2026-09-26T01:12:17.257Z"}}
        """#)
        let detail = try await api.conversation(id: "conv 1")
        XCTAssertEqual(try lastRequest().url?.path(percentEncoded: true), "/assistant/conversations/conv%201")
        XCTAssertEqual(detail.messages.map(\.role), ["user", "assistant"])
        XCTAssertEqual(detail.messages.last?.planId, "fr-local-plan")
        XCTAssertEqual(detail.plans.first?.confirmedOptionId, "street-1")
        XCTAssertNotNil(detail.plans.first?.confirmedAt)
        guard case .singleSpot(let plan)? = detail.plans.first?.plan else {
            return XCTFail("expected the single-spot plan")
        }
        XCTAssertEqual(plan.assumptions, "7:00–10:00 PM, near LoLa 42, Seaport")
        XCTAssertEqual(plan.options.first?.streetSummary, "Free after 6 PM on Seaport Blvd — 4 min walk")
        XCTAssertEqual(detail.outcome?.label, "Street — Seaport Blvd")
    }

    /// Activity's plan row, captured from the same run: it names the
    /// conversation it came from.
    func testActivityPlanRowCarriesItsConversation() async throws {
        StubURLProtocol.respond(json: #"""
        {"items":[{"id":"plan:fr-local-plan","kind":"plan","at":"2026-09-26T01:12:17.257Z","createdAt":"2026-09-26T01:12:17.257Z","planId":"fr-local-plan","planKind":"street","label":"Seaport Blvd","totalUsd":0,"explanation":"Chosen in the assistant — it pays when you park there.","conversationId":"conv_fr_local"}],"nextCursor":null}
        """#)
        let page = try await api.walletActivity(cursor: nil)
        let item = try XCTUnwrap(page.items.first)
        XCTAssertEqual(item.kind, "plan")
        XCTAssertEqual(item.planKind, "street")
        XCTAssertEqual(item.conversationId, "conv_fr_local")
        XCTAssertEqual(WalletCopy.place(item), "Seaport Blvd")
        XCTAssertEqual(WalletCopy.statusLabel(item), "Pays when you park")
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
