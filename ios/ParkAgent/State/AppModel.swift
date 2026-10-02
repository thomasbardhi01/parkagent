import CoreLocation
import Foundation
import Network
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

    let detector: ParkDetector
    let reporter = LocationReporter()
    /// The live permission state (see AppServices for who owns it).
    let permissions: PermissionsManager

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
    /// This user's own caps and default stay (GET /me/limits): what the
    /// budget step and Account → Spending limits show and save.
    var limitsResponse: UserLimitsResponse?
    var limitsLoadFailed = false

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
    /// The park whose sheet should ask what the place is (the "Not a
    /// garage" button on its notification).
    var placeAskFor: String?
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
    private(set) var isStopping = false

    /// Kept on disk: iOS ends a backgrounded app mid-session all the time,
    /// and a relaunch that forgot the session would stop reporting where
    /// the driver is, leaving the extension worker blind.
    var activeSession: ActiveSession? {
        didSet {
            guard activeSession != oldValue else { return }
            ActiveSession.store(activeSession)
        }
    }

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
    /// A saved conversation to open in the sheet (Activity links here).
    var assistantConversationId: String?
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

    func openAssistant(query: String? = nil, conversationId: String? = nil) {
        assistantInitialQuery = query
        assistantConversationId = conversationId
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

    /// Where the Home map's city answer stands, so the chip can say
    /// "finding you" or "couldn't" instead of quietly showing a default.
    enum CityDetection: Equatable {
        case idle
        /// Attempt n of `cityRetryDelays.count + 1`.
        case locating(attempt: Int)
        case detected
        /// No fix (location off or GPS silent): the map shows the saved
        /// city or the fallback center, and says so.
        case noLocation
        /// A fix, but the server didn't answer after every retry.
        case serverUnreachable
    }

    var cityDetection: CityDetection = .idle
    /// Backoff between attempts; the last failure stands until the next
    /// launch or a tap on Retry. Tests shorten it.
    var cityRetryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15), .seconds(30)]

    /// The phone's city, retried with backoff: a fix first (city-level
    /// accuracy is plenty), then GET /city. Returns the fix it used.
    @discardableResult
    func detectCityWithRetry(fix: @escaping () async -> CLLocationCoordinate2D?) async -> CLLocationCoordinate2D? {
        var attempt = 0
        while true {
            attempt += 1
            cityDetection = .locating(attempt: attempt)
            let coordinate = await fix()
            if let coordinate, await detectCity(lat: coordinate.latitude, lng: coordinate.longitude) != nil {
                cityDetection = .detected
                return coordinate
            }
            guard !Task.isCancelled, attempt <= cityRetryDelays.count else {
                if !Task.isCancelled { cityDetection = coordinate == nil ? .noLocation : .serverUnreachable }
                return coordinate
            }
            try? await Task.sleep(for: cityRetryDelays[attempt - 1])
            if Task.isCancelled { return nil }
        }
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

    /// Save this user's own limits (PUT /me/limits). nil when saved; else
    /// the sentence to show — the server's own for a refused value.
    func saveLimits(_ limits: SpendingLimits) async -> String? {
        do {
            limitsResponse = try await api.updateLimits(limits)
            return nil
        } catch {
            return LimitsCopy.saveFailure(error)
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

    init(authStore: AuthStore = AuthStore(), permissions: PermissionsManager = PermissionsManager()) {
        self.authStore = authStore
        self.permissions = permissions
        #if DEBUG
        detector = ParkDetector(simulated: LaunchOverrides.detectorSimulation)
        #else
        detector = ParkDetector()
        #endif
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
        activeSession = ActiveSession.restore()
        // The car pin belongs to a park being paid or a session running.
        // Anything else is a park the driver dismissed, and it used to pin
        // the map (and the city check) to that spot on every launch.
        if activeSession == nil, pendingParked == nil { carCoordinate = nil }

        permissions.onChange = { [weak self] capabilities in
            self?.detector.capabilitiesChanged(capabilities)
            self?.reporter.capabilitiesChanged(capabilities)
        }
        // onChange only reports changes; start from what's true now, or a
        // session paid before any change would report nothing.
        reporter.capabilitiesChanged(permissions.capabilities)
        detector.requestPrecise = { [weak permissions] in
            await permissions?.requestTemporaryPrecise() ?? false
        }
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
        pathMonitor?.cancel()
        pathMonitor = nil
        detector.disarm()
        Self.detectionArmed = false
        reporter.stop()
        activeSession = nil
        pendingParked = nil
        placeAskFor = nil
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
        limitsResponse = nil
        limitsLoadFailed = false
    }

    /// Called once the user is past onboarding. Wires the detector to the
    /// /parked report and starts push registration.
    func startBackgroundWork() {
        // UI tests drive parks through Home's test-only button; real motion,
        // location, and the notification permission prompt would only add
        // flakiness. The detector's own UI test opts back in.
        guard !LaunchOverrides.uiTesting || Self.detectorSimulation else { return }
        armDetection(reason: .arm)
        watchConnectivity()
        Task { await flushParkOutbox() }
        guard !LaunchOverrides.uiTesting else { return }
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
    }

    // MARK: - Detection

    /// Set once the user is past onboarding and cleared at sign-out: the
    /// app delegate re-arms detection at every launch while it is set,
    /// including a background relaunch for a location event.
    private static let detectionArmedKey = "detectionArmed"
    static var detectionArmed: Bool {
        get { UserDefaults.standard.bool(forKey: detectionArmedKey) }
        set { UserDefaults.standard.set(newValue, forKey: detectionArmedKey) }
    }

    #if DEBUG
    static var detectorSimulation: Bool { LaunchOverrides.detectorSimulation }
    #else
    static var detectorSimulation: Bool { false }
    #endif

    /// Launch (foreground or background): pick detection back up if this
    /// install had it on, without waiting for a screen to appear.
    func resumeDetectionIfArmed(reason: ParkDetector.WakeReason) {
        guard Self.detectionArmed, authStore.isSignedIn else { return }
        guard !LaunchOverrides.uiTesting || Self.detectorSimulation else { return }
        armDetection(reason: reason)
    }

    private func armDetection(reason: ParkDetector.WakeReason) {
        Self.detectionArmed = true
        detector.onPark = { [weak self] fix, signals, place in
            Task {
                await self?.handleDetectedPark(
                    coordinate: fix.coordinate, accuracy: fix.accuracy, signals: signals, detectedAt: fix.at,
                    placeHint: PlaceHint(place)
                )
            }
        }
        detector.onUnlocatedPark = { [weak self] preciseOff, outcome, place in
            Task { await self?.handleUnlocatedPark(preciseOff: preciseOff, outcome: outcome, place: place) }
        }
        detector.onDrivingResumed = { [weak self] in
            self?.drivingResumed()
        }
        // A button on a place notification (PushManager hands it over even
        // when iOS relaunched the app in the background for it).
        PushManager.shared.onPlaceAction = { [weak self] action, parkedEventId, coordinate in
            await self?.handlePlaceAction(action, parkedEventId: parkedEventId, at: coordinate)
        }
        // Garage and lot outlines for the place classifier, a 2 km cell at
        // a time as the car drives (FootprintCellCache).
        detector.footprintFetch = { [api] center, radiusM in
            let response = try await api.nearbyGarages(
                lat: center.latitude, lng: center.longitude, radiusM: radiusM, limit: LiveAPI.garagesMaxLimit
            )
            return FootprintCellCache.Fetched(footprints: response.garages, truncated: response.truncated)
        }
        reporter.onDistance = { [weak self] meters in
            self?.distanceFromCarMeters = meters
        }
        reporter.onSessionEnded = { [weak self] in
            self?.sessionEndedElsewhere()
        }
        detector.arm(capabilities: permissions.capabilities, reason: reason)
        reporter.capabilitiesChanged(permissions.capabilities)
        if activeSession != nil, !reporter.isRunning {
            reporter.start(api: api, carCoordinate: carCoordinate)
        }
    }

    /// The server has no active session for us (the worker expired it, or
    /// it was stopped from another device).
    private func sessionEndedElsewhere() {
        reporter.stop()
        activeSession = nil
        carCoordinate = nil
        distanceFromCarMeters = nil
        Task { await wallet.load(api: api) }
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

    func loadLimits() async {
        limitsLoadFailed = false
        do {
            limitsResponse = try await api.limits()
        } catch {
            guard !Task.isCancelled else { return }
            limitsLoadFailed = true
        }
    }

    // MARK: - Park flow

    /// What became of a park report.
    enum ParkReport: Equatable, Sendable {
        /// The server answered, and the answer was put in front of the driver.
        case answered
        /// No connection: it waits in the outbox.
        case queued
        /// The server won't take it, and a retry wouldn't change that.
        case refused
    }

    /// The real path: the detector saw a park (or a UI test simulated one),
    /// so report it and let the response drive the sheet.
    @discardableResult
    func handleDetectedPark(
        coordinate: CLLocationCoordinate2D,
        accuracy: Double,
        signals: [String],
        detectedAt: Date? = nil,
        placeHint: PlaceHint? = nil
    ) async -> ParkReport {
        // Priced at when the car stopped, not when the report got out: a
        // park confirmed by walking away (or replayed after a relaunch)
        // happened a minute or more before this call.
        let request = ParkedRequest(
            lat: coordinate.latitude,
            lng: coordinate.longitude,
            accuracy: accuracy,
            ts: detectedAt ?? AppClock.now,
            signals: signals,
            placeHint: placeHint,
            outcomes: ParkedRequest.shownOutcomes
        )
        // One key for this park, kept if it has to wait in the outbox, so
        // it's recorded once however many times it's delivered.
        let key = UUID().uuidString
        do {
            let response = try await api.parked(request, idempotencyKey: key)
            await presentPark(response, for: request)
            return .answered
        } catch {
            let failure = error as? APIError ?? .transport(error)
            carCoordinate = coordinate
            if ParkOutbox.isFinal(failure) {
                paymentError = failure
                return .refused
            }
            // No signal (a garage, a tunnel): keep the report and send
            // it when the connection is back — it used to be lost.
            await parkOutbox.enqueue(request, key: key)
            return .queued
        }
    }

    // MARK: - Offline outbox

    let parkOutbox = ParkOutbox()
    private var pathMonitor: NWPathMonitor?

    /// Send parks that waited for a connection. One still fresh gets the
    /// sheet as if it had just been detected; an old one is recorded on the
    /// server (its decision, its history) but not put in front of anyone.
    func flushParkOutbox() async {
        let api = self.api
        let delivered = await parkOutbox.flush { request, key in
            try await api.parked(request, idempotencyKey: key)
        }
        guard let latest = delivered.last,
              AppClock.now.timeIntervalSince(latest.item.request.ts) < ParkedNotice.freshFor
        else { return }
        await presentPark(latest.response, for: latest.item.request, fromOutbox: true)
    }

    /// Flush whenever the network comes back.
    private func watchConnectivity() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in await self?.flushParkOutbox() }
        }
        monitor.start(queue: DispatchQueue(label: "parkagent.connectivity"))
        pathMonitor = monitor
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
        // One payment at a time: "Save number and pay" could be tapped again
        // while the first start was still running.
        guard let parked = pendingParked, !isPaying else { return }
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
        placeAskFor = nil
        paymentError = nil
        freePeriodNotice = nil
        // Not paid here: the pin would outlive the park (see init).
        if activeSession == nil { carCoordinate = nil }
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
        guard let session = activeSession, !isStopping else { return }
        isStopping = true
        defer { isStopping = false }
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
