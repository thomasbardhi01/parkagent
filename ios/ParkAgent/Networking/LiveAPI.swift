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

    // MARK: - Transport

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
