import CoreLocation
import Foundation
import Observation

/// Single source of app state. Screens read it via the environment; only its
/// methods talk to the APIClient.
@MainActor
@Observable
final class AppModel {
    private(set) var api: any APIClient
    /// Set when the mock is active because the live API is unconfigured
    /// rather than chosen.
    private(set) var liveAPIUnavailable = false

    let detector = ParkDetector()
    let reporter = LocationReporter()

    var useMockAPI: Bool {
        didSet {
            UserDefaults.standard.set(useMockAPI, forKey: "useMockAPI")
            rebuildAPI()
        }
    }

    var policyResponse: PolicyResponse?
    var policyLoadFailed = false

    /// Drives the Parking Detected sheet.
    var pendingParked: ParkedResponse?
    var isPaying = false
    var paymentError: APIError?
    /// Extend/stop failures on the Active Session screen.
    var sessionActionError: APIError?

    var activeSession: ActiveSession?
    var history: [SessionRecord] = []
    var todaySpendUsd: Double = 0

    /// Persisted so the pin survives a relaunch while the car is parked.
    var carCoordinate: CLLocationCoordinate2D? {
        didSet {
            let defaults = UserDefaults.standard
            if let carCoordinate {
                defaults.set(carCoordinate.latitude, forKey: "carLat")
                defaults.set(carCoordinate.longitude, forKey: "carLng")
            } else {
                defaults.removeObject(forKey: "carLat")
                defaults.removeObject(forKey: "carLng")
            }
        }
    }
    var distanceFromCarMeters: Double?

    /// Columbus Ave near W 81st St — the worked example in server/API.md.
    static let fixtureCoordinate = CLLocationCoordinate2D(latitude: 40.7784, longitude: -73.9818)

    init() {
        #if DEBUG
        let mock = UserDefaults.standard.object(forKey: "useMockAPI") as? Bool ?? true
        #else
        let mock = false
        #endif
        useMockAPI = mock
        if mock {
            api = MockAPI()
        } else if let live = LiveAPI.fromConfig() {
            api = live
        } else {
            api = MockAPI()
            liveAPIUnavailable = true
        }
        if mock { seedMockHistory() }

        let defaults = UserDefaults.standard
        if let lat = defaults.object(forKey: "carLat") as? Double,
           let lng = defaults.object(forKey: "carLng") as? Double {
            carCoordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
        }
    }

    private func rebuildAPI() {
        liveAPIUnavailable = false
        if useMockAPI {
            api = MockAPI()
        } else if let live = LiveAPI.fromConfig() {
            api = live
        } else {
            api = MockAPI()
            liveAPIUnavailable = true
        }
        PushManager.shared.activate(api: api)
    }

    // MARK: - Background plumbing

    /// Called once the user is past onboarding. Wires the detector to the
    /// /parked report and starts push registration.
    func startBackgroundWork() {
        detector.onPark = { [weak self] coordinate, accuracy, signals in
            Task { await self?.handleDetectedPark(coordinate: coordinate, accuracy: accuracy, signals: signals) }
        }
        reporter.onDistance = { [weak self] meters in
            self?.distanceFromCarMeters = meters
        }
        detector.start()
        PushManager.shared.activate(api: api)
        if activeSession != nil {
            reporter.start(api: api, carCoordinate: carCoordinate)
        }
    }

    // MARK: - Policy

    func loadPolicy() async {
        policyLoadFailed = false
        do {
            policyResponse = try await api.policy()
        } catch {
            policyLoadFailed = true
        }
    }

    // MARK: - Park flow

    /// The real path: the detector saw a park (or the Debug menu simulated
    /// one), so report it and let the response drive the sheet.
    func handleDetectedPark(coordinate: CLLocationCoordinate2D, accuracy: Double, signals: [String]) async {
        let request = ParkedRequest(
            lat: coordinate.latitude,
            lng: coordinate.longitude,
            accuracy: accuracy,
            ts: .now,
            signals: signals
        )
        do {
            let response = try await api.parked(request)
            carCoordinate = coordinate
            paymentError = nil
            pendingParked = response
        } catch {
            paymentError = error as? APIError ?? .transport(error)
        }
    }

    /// Home-sheet convenience (DEBUG + mock): a park at the API.md fixture.
    func simulatePark() async {
        await handleDetectedPark(
            coordinate: Self.fixtureCoordinate,
            accuracy: 12.5,
            signals: ["simulated"]
        )
    }

    /// Manual zone-number entry from the unknown-zone state. The server has
    /// no quote-by-zone-number endpoint yet, so this fabricates a fixture
    /// quote; the live path needs a Phase 5+ endpoint.
    func quoteForManualZone(zoneNumber: String) {
        pendingParked = MockFixtures.singleQuote(zoneNumber: zoneNumber)
    }

    func pay(candidate: Candidate) async {
        guard let parked = pendingParked else { return }
        isPaying = true
        paymentError = nil
        do {
            let response = try await api.startSession(SessionStartRequest(
                parkedEventId: parked.parkedEventId,
                zoneId: candidate.zoneId,
                minutes: candidate.quote.stayMinutes
            ))
            let autoExtendPolicy = policyResponse?.policy.autoExtend
            activeSession = ActiveSession(
                sessionId: response.sessionId,
                zoneNumber: candidate.parknycZoneNumber,
                zoneLabel: "Zone \(candidate.parknycZoneNumber)",
                startedAt: .now,
                expiresAt: response.expiresAt,
                amountUsd: response.amountUsd,
                extendCount: 0,
                maxExtendCount: autoExtendPolicy?.maxCount ?? 2,
                maxStayReached: false,
                autoExtend: autoExtendPolicy?.enabled ?? true
            )
            todaySpendUsd += response.amountUsd
            distanceFromCarMeters = useMockAPI ? 120 : nil
            pendingParked = nil
            reporter.start(api: api, carCoordinate: carCoordinate)
        } catch {
            paymentError = error as? APIError ?? .transport(error)
        }
        isPaying = false
    }

    func dismissParkedSheet() {
        pendingParked = nil
        paymentError = nil
    }

    // MARK: - Session actions

    func extendSession() async {
        guard var session = activeSession, session.canExtend else { return }
        let minutes = policyResponse?.policy.autoExtend.maxMinutesEach ?? 60
        do {
            let response = try await api.extendSession(sessionId: session.sessionId, minutes: minutes)
            session.expiresAt = response.expiresAt
            session.amountUsd += response.amountUsd
            session.extendCount += 1
            todaySpendUsd += response.amountUsd
            activeSession = session
        } catch {
            sessionActionError = error as? APIError ?? .transport(error)
        }
    }

    func stopSession() async {
        guard let session = activeSession else { return }
        do {
            let response = try await api.stopSession(sessionId: session.sessionId)
            history.insert(SessionRecord(
                id: session.sessionId,
                zoneNumber: session.zoneNumber,
                zoneLabel: session.zoneLabel,
                startedAt: session.startedAt,
                endedAt: response.stoppedAt,
                amountUsd: session.amountUsd,
                status: .paid
            ), at: 0)
            activeSession = nil
            carCoordinate = nil
            distanceFromCarMeters = nil
            reporter.stop()
        } catch {
            sessionActionError = error as? APIError ?? .transport(error)
        }
    }

    // MARK: - Fixtures

    private func seedMockHistory() {
        let calendar = Calendar.current
        let yesterday = calendar.date(byAdding: .day, value: -1, to: .now) ?? .now
        let lastWeek = calendar.date(byAdding: .day, value: -3, to: .now) ?? .now
        history = [
            SessionRecord(
                id: "mock-history-1",
                zoneNumber: "110212",
                zoneLabel: "Zone 110212",
                startedAt: yesterday,
                endedAt: yesterday.addingTimeInterval(90 * 60),
                amountUsd: 9.28,
                status: .paid
            ),
            SessionRecord(
                id: "mock-history-2",
                zoneNumber: "110888",
                zoneLabel: "Zone 110888",
                startedAt: lastWeek,
                endedAt: lastWeek.addingTimeInterval(45 * 60),
                amountUsd: 0,
                status: .failed
            ),
        ]
    }

    // MARK: - Debug helpers (Settings > Developer)

    #if DEBUG
    func debugMakeSessionExpiring() {
        activeSession?.expiresAt = .now.addingTimeInterval(8 * 60)
    }

    func debugMarkMaxStayReached() {
        activeSession?.maxStayReached = true
    }
    #endif
}
