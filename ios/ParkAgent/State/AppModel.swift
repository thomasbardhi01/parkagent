import CoreLocation
import Foundation
import Observation

/// Single source of app state. Screens read it via the environment; only its
/// methods talk to the APIClient.
@MainActor
@Observable
final class AppModel {
    private(set) var api: any APIClient
    /// Set when API_BASE_URL/API_KEY are missing from Config.xcconfig. The
    /// app stays on `UnconfiguredAPI` (every call fails with a real error)
    /// — there is no silent fallback to fixtures.
    private(set) var liveAPIUnavailable = false

    let detector = ParkDetector()
    let reporter = LocationReporter()

    /// Launch-time only (UI tests and previews); see LaunchOverrides.
    let useMockAPI: Bool

    var policyResponse: PolicyResponse?
    var policyLoadFailed = false

    /// Drives the Parking Detected sheet.
    var pendingParked: ParkedResponse?
    var isPaying = false
    var paymentError: APIError?
    /// Set when session/start answered free_period: the provider says the
    /// zone isn't charging right now. The parked sheet shows it; nothing
    /// was paid and no session exists.
    var freePeriodNotice: String?
    /// Extend/stop failures on the Active Session screen.
    var sessionActionError: APIError?
    /// True while an extend round-trip is in flight (button disables).
    private(set) var isExtending = false

    var activeSession: ActiveSession?
    var history: [SessionRecord] = []
    var todaySpendUsd: Double = 0

    /// Presents the provider link flow outside onboarding (parked-sheet
    /// routing, Settings re-link, the provider_relink push).
    var providerLinkPrompt: ProviderLinkPrompt?

    // MARK: - Assistant

    /// Presents the assistant sheet (Home button, Siri intent, deep link).
    var assistantPresented = false
    /// Prefilled question when Siri ("Ask ParkAgent") opened the sheet.
    var assistantInitialQuery: String?
    /// Signed-off days from the server; the first signed_off one drives
    /// Home's live day section.
    var itineraries: [ItinerarySummary] = []
    var linkWalletConnected = false

    var activeItinerary: ItinerarySummary? {
        itineraries.first { $0.status == "signed_off" }
    }

    func refreshItineraries() async {
        itineraries = (try? await api.itineraries())?.itineraries ?? []
    }

    func refreshLinkWalletStatus() async {
        linkWalletConnected = (try? await api.linkWalletStatus())?.connected ?? false
    }

    func openAssistant(query: String? = nil) {
        assistantInitialQuery = query
        assistantPresented = true
    }

    // MARK: - City

    /// City key from the last successful GET /city (or the city of the last
    /// parked candidate). Persisted so the Home chip survives a relaunch.
    var detectedCity: String? {
        didSet { UserDefaults.standard.set(detectedCity, forKey: "detectedCity") }
    }

    /// Settings override: "auto" follows detection; "nyc"/"bos"/"other" pin it.
    var cityOverride: String = "auto" {
        didSet { UserDefaults.standard.set(cityOverride, forKey: "cityOverride") }
    }

    var effectiveCity: String? {
        cityOverride == "auto" ? detectedCity : cityOverride
    }

    /// What the Home chip shows; nil when the city is unknown or unsupported.
    var cityDisplayName: String? {
        CityCatalog.displayName(effectiveCity)
    }

    /// One-shot city detection against the server; remembers the answer.
    func detectCity(lat: Double, lng: Double) async -> CityDetectResponse? {
        guard let response = try? await api.detectCity(lat: lat, lng: lng) else { return nil }
        if let city = response.city { detectedCity = city }
        return response
    }

    /// Onboarding's "Your city": detect from where the phone is now. The
    /// mock skips CoreLocation so the simulator and UI tests stay
    /// deterministic; nil means "couldn't tell — offer the manual choice".
    func detectCityFromCurrentLocation() async -> CityDetectResponse? {
        let coordinate = useMockAPI ? Self.fixtureCoordinate : await OneShotLocation.request()
        guard let coordinate else { return nil }
        return await detectCity(lat: coordinate.latitude, lng: coordinate.longitude)
    }

    /// Onboarding's budget step: PUT the caps and default stay back as a
    /// full policy replacement. False means the save failed (the step lets
    /// the user retry or continue with the server's values).
    func saveBudget(sessionCapUsd: Double, dailyCapUsd: Double, defaultStayMinutes: Int) async -> Bool {
        guard var policy = policyResponse?.policy else { return false }
        policy.sessionCapUsd = sessionCapUsd
        policy.dailyCapUsd = dailyCapUsd
        policy.defaultStayMinutes = defaultStayMinutes
        do {
            policyResponse = try await api.updatePolicy(policy)
            return true
        } catch {
            return false
        }
    }

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
    /// MOCK ONLY: the fixtures are built around this point, so UI tests and
    /// previews are deterministic. Nothing on a live launch may default to
    /// it (see CityCatalog.center for the city fallbacks).
    static let fixtureCoordinate = CLLocationCoordinate2D(latitude: 40.7784, longitude: -73.9818)

    init() {
        let mock = LaunchOverrides.useMockAPI
        useMockAPI = mock
        if mock {
            api = MockAPI()
        } else if let live = LiveAPI.fromConfig() {
            api = live
        } else {
            // Missing Config.xcconfig values are an error the user sees
            // (Home banner via liveAPIUnavailable), never a quiet switch
            // onto fixtures.
            api = UnconfiguredAPI()
            liveAPIUnavailable = true
        }
        if mock { seedMockHistory() }

        let defaults = UserDefaults.standard
        detectedCity = defaults.string(forKey: "detectedCity")
        cityOverride = defaults.string(forKey: "cityOverride") ?? "auto"
        if let lat = defaults.object(forKey: "carLat") as? Double,
           let lng = defaults.object(forKey: "carLng") as? Double {
            carCoordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
        }
    }

    // MARK: - Background plumbing

    /// Called once the user is past onboarding. Wires the detector to the
    /// /parked report and starts push registration.
    func startBackgroundWork() {
        // UI tests drive parks through the Debug menu; real motion, location,
        // and the notification permission prompt would only add flakiness.
        guard !LaunchOverrides.uiTesting else { return }
        detector.onPark = { [weak self] coordinate, accuracy, signals in
            Task { await self?.handleDetectedPark(coordinate: coordinate, accuracy: accuracy, signals: signals) }
        }
        reporter.onDistance = { [weak self] meters in
            self?.distanceFromCarMeters = meters
        }
        detector.start()
        PushManager.shared.activate(api: api)
        // A provider_relink push routes straight into the link flow.
        PushManager.shared.onProviderRelink = { [weak self] providerId in
            self?.providerLinkPrompt = ProviderLinkPrompt(providerId: providerId)
        }
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
            ts: AppClock.now,
            signals: signals
        )
        do {
            let response = try await api.parked(request)
            carCoordinate = coordinate
            paymentError = nil
            pendingParked = response
            // A real park is the freshest city signal there is.
            if let city = response.candidates.first?.city {
                detectedCity = city
            }
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
    /// no quote-by-zone-number endpoint yet: the mock fabricates a fixture
    /// quote so the flow stays walkable in UI tests. The live sheet doesn't
    /// offer entry at all; the guard stays so nothing can ever put a
    /// fabricated price in front of a real payment.
    func quoteForManualZone(zoneNumber: String) {
        guard useMockAPI else {
            paymentError = .notImplemented
            return
        }
        pendingParked = MockFixtures.singleQuote(zoneNumber: zoneNumber)
    }

    func pay(candidate: Candidate) async {
        guard let parked = pendingParked else { return }
        isPaying = true
        paymentError = nil
        Haptics.light()
        do {
            let outcome = try await api.startSession(SessionStartRequest(
                parkedEventId: parked.parkedEventId,
                zoneId: candidate.zoneId,
                minutes: candidate.quote.stayMinutes
            ))
            guard case .started(let response) = outcome else {
                if case .freePeriod(let notice) = outcome {
                    // Free, not failed: the sheet says so; no session, no
                    // charge, no retry invitation.
                    freePeriodNotice = notice ?? "Meters here are free right now."
                }
                isPaying = false
                return
            }
            let autoExtendPolicy = policyResponse?.policy.autoExtend
            activeSession = ActiveSession(
                sessionId: response.sessionId,
                zoneNumber: candidate.providerZoneNumber,
                zoneLabel: "Zone \(candidate.providerZoneNumber)",
                startedAt: AppClock.now,
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
            Haptics.success()
        } catch {
            paymentError = error as? APIError ?? .transport(error)
        }
        isPaying = false
    }

    func dismissParkedSheet() {
        pendingParked = nil
        paymentError = nil
        freePeriodNotice = nil
    }

    /// The needsZoneNumber flow: store the number the driver read off the
    /// meter so this block (and everyone's next park here) is automatic.
    /// nil → the report didn't reach the server; nothing was charged. The
    /// response's `number` is what the server APPLIED (import/verified
    /// precedence can outrank the report) — pay with that, not the input.
    func reportZoneNumber(zoneId: String, number: String) async -> ZoneNumberReportResponse? {
        guard let response = try? await api.reportZoneNumber(zoneId: zoneId, number: number),
              response.ok else { return nil }
        return response
    }

    // MARK: - Session actions

    func extendSession() async {
        guard var session = activeSession, session.canExtend, !isExtending else { return }
        isExtending = true
        defer { isExtending = false }
        let minutes = policyResponse?.policy.autoExtend.maxMinutesEach ?? 60
        Haptics.light()
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
                status: .paid,
                lat: carCoordinate?.latitude,
                lng: carCoordinate?.longitude
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
        let now = AppClock.now
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now) ?? now
        let lastWeek = calendar.date(byAdding: .day, value: -3, to: now) ?? now
        history = [
            SessionRecord(
                id: "mock-history-1",
                zoneNumber: "110212",
                zoneLabel: "Zone 110212",
                startedAt: yesterday,
                endedAt: yesterday.addingTimeInterval(90 * 60),
                amountUsd: 9.28,
                status: .paid,
                lat: 40.7813,
                lng: -73.9787
            ),
            SessionRecord(
                id: "mock-history-2",
                zoneNumber: "110888",
                zoneLabel: "Zone 110888",
                startedAt: lastWeek,
                endedAt: lastWeek.addingTimeInterval(45 * 60),
                amountUsd: 0,
                status: .failed,
                lat: 40.7942,
                lng: -73.9722
            ),
        ]
    }

    // MARK: - Debug helpers (Settings > Developer)

    #if DEBUG
    func debugMakeSessionExpiring() {
        activeSession?.expiresAt = AppClock.now.addingTimeInterval(8 * 60)
    }

    func debugMarkMaxStayReached() {
        activeSession?.maxStayReached = true
    }
    #endif
}
