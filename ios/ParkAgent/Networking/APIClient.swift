import Foundation

/// The app's whole view of the server. `MockAPI` serves fixtures for the
/// simulator and previews; `LiveAPI` talks to the Fastify server. Nothing
/// outside Networking/ should construct URLRequests.
protocol APIClient: Sendable {
    func parked(_ request: ParkedRequest) async throws -> ParkedResponse
    func policy() async throws -> PolicyResponse
    func startSession(_ request: SessionStartRequest) async throws -> SessionStartResponse
    func stopSession(sessionId: String) async throws -> SessionStopResponse
    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse
    func reportLocation(_ report: LocationReport) async throws
    func registerDevice(_ registration: DeviceRegistration) async throws
}

enum APIError: Error, LocalizedError {
    /// API_BASE_URL or API_KEY missing from Config.xcconfig.
    case notConfigured
    case unauthorized
    case invalidRequest(String)
    /// 501 — the session and location endpoints are Phase 5 stubs.
    case notImplemented
    case server(status: Int)
    case transport(Error)
    /// Mock-only until Phase 5 wires real payment failures through.
    case paymentFailed

    var errorDescription: String? {
        switch self {
        case .notConfigured: "The live API is not configured. Add API_BASE_URL and API_KEY to Config.xcconfig."
        case .unauthorized: "The server rejected this API key."
        case .invalidRequest(let detail): "The server rejected the request: \(detail)"
        case .notImplemented: "This part of the server is not built yet."
        case .server(let status): "The server returned an error (\(status))."
        case .transport: "Could not reach the server."
        case .paymentFailed: "The payment did not go through."
        }
    }
}
