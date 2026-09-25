import CoreLocation
import Foundation
import Observation
import UIKit

/// Single source of app state. Screens read it via the environment; only its
/// methods talk to the APIClient.
@MainActor
@Observable
final class AppModel {
    private(set) var api: any APIClient
    /// Set when API_BASE_URL is missing from Config.xcconfig. The app stays
    /// on `UnconfiguredAPI` (every call fails with a real error) — there is
    /// no silent fallback to fixtures. Only a signed-in screen shows it as a
    /// banner; signed out, the welcome screen's sign-in failure says it.
    private(set) var liveAPIUnavailable = false

    let detector = ParkDetector()
    let reporter = LocationReporter()

    #if DEBUG
    /// Launch-time only (UI tests and previews); see LaunchOverrides.
    let useMockAPI: Bool
    #else
    /// Never in Release. Computed, not stored, so not even the property's
    /// name ships (stored properties carry reflection metadata).
    var useMockAPI: Bool { false }
    #endif

    var policyResponse: PolicyResponse?
    var policyLoadFailed = false

    /// Drives the Parking Detected sheet. Kept on disk while it's fresh
    /// (ParkedNotice.store), so a notification tap after iOS ended the app
    /// still finds its sheet; cleared → the notification is withdrawn too.
    var pendingParked: ParkedResponse? {
        didSet {
            guard pendingParked?.parkedEventId != oldValue?.parkedEventId else { return }
            ParkedNotice.store(pendingParked)
            if pendingParked == nil { ParkedNotice.withdraw() }
        }
    }
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

    /// How the user pays and what they've spent — one instance, read by the
    /// Wallet tab, the Account sheet, onboarding, and Home's "today" bar,
    /// so none of them can disagree.
    let wallet = WalletModel()

    /// The tab bar's selection: the Wallet's "See all", the Account sheet's
    /// "How you pay", and the card_declined push move between tabs.
    var selectedTab: AppTab = .park

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
        #if DEBUG
        let coordinate = useMockAPI ? MockFixtures.fixtureCoordinate : await OneShotLocation.request()
        #else
        let coordinate = await OneShotLocation.request()
        #endif
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

    /// Supplies the access token to LiveAPI and performs silent refresh.
    private let authStore: AuthStore

    init(authStore: AuthStore = AuthStore()) {
        self.authStore = authStore
        #if DEBUG
        useMockAPI = LaunchOverrides.useMockAPI
        let mockAPI: (any APIClient)? = useMockAPI ? MockAPI() : nil
        #else
        let mockAPI: (any APIClient)? = nil
        #endif
        if let mockAPI {
            api = mockAPI
        } else if let live = LiveAPI.fromConfig(tokens: Self.tokenSource(authStore)) {
            api = live
        } else {
            // No API_BASE_URL is an error the user sees (Home banner via
            // liveAPIUnavailable, or the welcome screen's sign-in failure),
            // never a quiet switch onto fixtures.
            api = UnconfiguredAPI()
            liveAPIUnavailable = true
        }

        let defaults = UserDefaults.standard
        detectedCity = defaults.string(forKey: "detectedCity")
        cityOverride = defaults.string(forKey: "cityOverride") ?? "auto"
        if let lat = defaults.object(forKey: "carLat") as? Double,
           let lng = defaults.object(forKey: "carLng") as? Double {
            carCoordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
        }
        // A park detected before iOS ended the app; stale ones are dropped.
        pendingParked = ParkedNotice.restore()
    }

    /// LiveAPI's view of the AuthStore: the current access token, and the
    /// single-flight refresh a 401 hands back.
    private static func tokenSource(_ authStore: AuthStore) -> LiveAPI.TokenSource {
        LiveAPI.TokenSource(
            current: { await authStore.accessToken() },
            refresh: { used in await authStore.refreshAfterUnauthorized(usedToken: used) }
        )
    }

    /// Read the stored session and wire the refresh transport. Called once
    /// at launch, before anything makes a protected request.
    func restoreSession() {
        let baseURL = useMockAPI ? nil : AppConfig.apiBaseURL
        authStore.restore { refreshToken, deviceId in
            // Refresh is its own unauthenticated call, so it uses a bare
            // client rather than recursing through the token source. The
            // mock's sessions never expire, and an unconfigured app has
            // nowhere to ask — neither is a reason to sign anyone out.
            guard let baseURL else { return .unreachable }
            return await LiveAPI(baseURL: baseURL, tokens: .none)
                .refreshSession(refreshToken: refreshToken, deviceId: deviceId)
        }
        // Refresh the cached profile against the server, so a name or email
        // changed on another device shows up here.
        guard authStore.isSignedIn else { return }
        Task { [authStore, api] in
            if let me = try? await api.me() {
                authStore.update(user: me.user)
            }
        }
    }

    // MARK: - Background plumbing

    /// Sign-out: stop reporting location and detecting parks for an
    /// account that is no longer here, and drop its in-memory state.
    func stopBackgroundWork() {
        detector.stop()
        reporter.stop()
        activeSession = nil
        pendingParked = nil
        wallet.reset()
        selectedTab = .park
        carCoordinate = nil
        distanceFromCarMeters = nil
        itineraries = []
        linkWalletConnected = false
        detectedCity = nil
        cityOverride = "auto"
        // The policy is the account's own caps; the next sign-in loads its
        // own rather than inheriting these (or this one's load failure).
        policyResponse = nil
        policyLoadFailed = false
    }

    /// Called once the user is past onboarding. Wires the detector to the
    /// /parked report and starts push registration.
    func startBackgroundWork() {
        // UI tests drive parks through Home's test-only button; real motion,
        // location, and the notification permission prompt would only add
        // flakiness.
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
        // A card_declined push lands on the Wallet, where the card is fixed.
        PushManager.shared.onOpenWallet = { [weak self] in
            self?.selectedTab = .wallet
        }
        // Every other push is about the car: the Park tab.
        PushManager.shared.onOpenPark = { [weak self] in
            self?.selectedTab = .park
        }
        // A tap that launched the app before these were wired.
        PushManager.shared.replayPendingOpen()
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
            // Cancelled is not unreachable: whoever cancelled (a sign-out,
            // a view going away) owns what happens next.
            guard !Task.isCancelled else { return }
            policyLoadFailed = true
        }
    }

    // MARK: - Park flow

    /// The real path: the detector saw a park (or a UI test simulated one),
    /// so report it and let the response drive the sheet.
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
            // Backgrounded (the usual case: the driver just walked away),
            // the sheet waits unseen — say so with a notification.
            if UIApplication.shared.applicationState != .active {
                await ParkedNotice.post(for: response)
            }
            // A real park is the freshest city signal there is.
            if let city = response.candidates.first?.city {
                detectedCity = city
            }
        } catch {
            paymentError = error as? APIError ?? .transport(error)
        }
    }

    #if DEBUG
    /// UI tests only (Home's test-only button, mock API): a park at the
    /// API.md fixture point.
    func simulatePark() async {
        await handleDetectedPark(
            coordinate: MockFixtures.fixtureCoordinate,
            accuracy: 12.5,
            signals: ["simulated"]
        )
    }
    #endif

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
                paymentSource: wallet.activeSource == .parkagentCard ? .parkagentCard : .providerCard
            )
            // Today's spend and Activity come from the server.
            Task { await wallet.load(api: api) }
            #if DEBUG
            // The mock has no reporter behind it; give the session screen a
            // distance to show.
            distanceFromCarMeters = useMockAPI ? 120 : nil
            #else
            distanceFromCarMeters = nil
            #endif
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
            activeSession = session
            Task { await wallet.load(api: api) }
        } catch {
            sessionActionError = error as? APIError ?? .transport(error)
        }
    }

    func stopSession() async {
        guard let session = activeSession else { return }
        do {
            _ = try await api.stopSession(sessionId: session.sessionId)
            activeSession = nil
            carCoordinate = nil
            distanceFromCarMeters = nil
            reporter.stop()
            // The stopped session is in Activity now.
            Task { await wallet.load(api: api) }
        } catch {
            sessionActionError = error as? APIError ?? .transport(error)
        }
    }
}
