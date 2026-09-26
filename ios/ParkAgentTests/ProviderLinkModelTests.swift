import XCTest
@testable import ParkAgent

/// The link flow against a server that answers POST link at once with a
/// job: the app follows the job's real steps, says a provider's failure in
/// plain words and retries the same sign-in, goes back to the provider's
/// page only when the sign-in itself was the problem, and hands the
/// outcome to a push when the user moves on or the polls stop getting
/// through.
@MainActor
final class ProviderLinkModelTests: XCTestCase {
    private let cookies = [ProviderCookie(name: "sid", value: "v1", domain: ".bostonma.ppprk.com", path: "/")]

    /// A model signed in to ParkBoston's page, ready for its cookies.
    private func signedIn(_ api: ScriptedLinkAPI) async -> ProviderLinkModel {
        let link = ProviderLinkModel(providerId: "passport")
        link.pollInterval = .milliseconds(5)
        link.consentCardSetup = false
        await link.load(api: api)
        XCTAssertEqual(link.stage, .intro)
        link.startSignIn(api: api)
        return link
    }

    func testFollowsTheJobToDoneAndShowsTheCardReadAfterLinking() async {
        let api = ScriptedLinkAPI(statuses: [
            LinkStatusResponse(phase: "queued", linked: false, queuePosition: 1),
            LinkStatusResponse(phase: "verifying", linked: false),
            LinkStatusResponse(phase: "reading_card", linked: true),
            LinkStatusResponse(phase: "done", linked: true, cardBrand: "Visa", cardLast4: "1234"),
        ])
        let link = await signedIn(api)
        await link.cookiesCaptured(cookies, api: api)

        XCTAssertEqual(link.stage, .done(dryRun: false))
        XCTAssertEqual(link.providerCard, "Visa ••1234")
        XCTAssertEqual(api.linkCalls, 1)
        XCTAssertEqual(api.phasesServed, ["queued", "verifying", "reading_card", "done"])
        XCTAssertEqual(api.notifyCalls, [], "Watching to the end needs no push")
    }

    /// The provider was slow, not the sign-in: plain words, and Retry
    /// sends the same cookies again instead of reopening the login page.
    func testProviderTimeoutSaysSoAndRetrySendsTheSameSignIn() async {
        let api = ScriptedLinkAPI(statuses: [
            LinkStatusResponse(phase: "verifying", linked: false),
            LinkStatusResponse(phase: "failed", reason: "timeout", retrySafe: true, linked: false),
            LinkStatusResponse(phase: "done", linked: true),
        ])
        let link = await signedIn(api)
        await link.cookiesCaptured(cookies, api: api)

        XCTAssertEqual(
            link.stage,
            .failed(reason: "ParkBoston took too long to answer. Try again in a minute.", canRetrySetup: false)
        )
        await link.retry(api: api)
        XCTAssertEqual(api.submittedCookies, [cookies, cookies])
        XCTAssertEqual(link.stage, .done(dryRun: false))
    }

    /// The captured cookies weren't a session: back to the provider's own
    /// page, where fresher cookies resubmit on their own.
    func testExpiredSignInGoesBackToTheProvidersPage() async {
        let api = ScriptedLinkAPI(statuses: [
            LinkStatusResponse(phase: "failed", reason: "auth_expired", retrySafe: false, linked: false),
        ])
        let link = await signedIn(api)
        await link.cookiesCaptured(cookies, api: api)
        XCTAssertEqual(link.stage, .signIn)
    }

    /// Linked, but the chained ParkAgent-card setup failed: Retry re-runs
    /// the setup, not the link.
    func testLinkedButCardSetupFailedOffersSetupRetry() async {
        let api = ScriptedLinkAPI(statuses: [
            LinkStatusResponse(phase: "adding_card", linked: true),
            LinkStatusResponse(phase: "failed", reason: "network", retrySafe: true, linked: true),
        ])
        let link = await signedIn(api)
        await link.cookiesCaptured(cookies, api: api)
        guard case .failed(_, let canRetrySetup) = link.stage else {
            return XCTFail("Expected a failure, got \(link.stage)")
        }
        XCTAssertTrue(canRetrySetup)
    }

    /// "Continue — we'll let you know": the push is asked for, and the app
    /// stops polling a job nobody is watching.
    func testContinueAsksForAPushAndStopsPolling() async throws {
        let api = ScriptedLinkAPI(statuses: [LinkStatusResponse(phase: "verifying", linked: false)], repeatLast: true)
        let link = await signedIn(api)
        let running = Task { await link.cookiesCaptured(cookies, api: api) }
        while api.pollCount < 3 { try await Task.sleep(for: .milliseconds(5)) }

        await link.continueInBackground(api: api)
        await running.value
        XCTAssertEqual(link.stage, .continuingInBackground)
        XCTAssertEqual(api.notifyCalls, ["job-1"])
        let polls = api.pollCount
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(api.pollCount, polls, "Still polling after the user moved on")
    }

    /// A tunnel: five polls in a row don't get through. The job runs on
    /// server-side regardless, so the outcome is handed to a push rather
    /// than the old "Lost track of the card setup" dead end.
    func testDroppedPollsHandTheOutcomeToAPush() async {
        let api = ScriptedLinkAPI(statuses: [], pollsFail: true)
        let link = await signedIn(api)
        await link.cookiesCaptured(cookies, api: api)
        XCTAssertEqual(link.stage, .continuingInBackground)
        XCTAssertEqual(api.pollCount, 5)
        XCTAssertEqual(api.notifyCalls, ["job-1"])
    }

    // MARK: - The step, in plain words

    func testProgressCopy() {
        let name = "ParkBoston"
        func step(_ status: LinkStatusResponse?) -> String {
            LinkProgressCopy.step(status, providerName: name, addingCard: false)
        }
        XCTAssertEqual(step(nil), "Checking your ParkBoston sign-in…")
        XCTAssertEqual(step(LinkStatusResponse(phase: "queued", queuePosition: 0)), "Checking your ParkBoston sign-in…")
        XCTAssertEqual(step(LinkStatusResponse(phase: "queued", queuePosition: 2)), "Waiting for a free spot…")
        XCTAssertEqual(step(LinkStatusResponse(phase: "verifying")), "Checking your ParkBoston sign-in…")
        XCTAssertEqual(step(LinkStatusResponse(phase: "reading_card")), "Reading your card…")
        XCTAssertEqual(step(LinkStatusResponse(phase: "retrying")), "ParkBoston is slow — trying again…")
        XCTAssertEqual(LinkProgressCopy.step(nil, providerName: name, addingCard: true), "Adding your ParkAgent card…")

        XCTAssertEqual(
            LinkProgressCopy.detail(LinkStatusResponse(phase: "queued", queuePosition: 2), providerName: name),
            "2 ahead of you."
        )
        XCTAssertEqual(
            LinkProgressCopy.detail(LinkStatusResponse(phase: "retrying", attempt: 1, maxAttempts: 3), providerName: name),
            "Attempt 2 of 3 starts shortly."
        )
        XCTAssertNil(LinkProgressCopy.detail(LinkStatusResponse(phase: "verifying"), providerName: name))
    }

    func testLinkFailureReasonsInPlainWords() {
        XCTAssertEqual(
            ProviderLinkModel.plainLinkReason("provider_unavailable", providerName: "ParkBoston"),
            "ParkBoston isn't responding right now. Try again in a few minutes."
        )
        XCTAssertEqual(
            ProviderLinkModel.plainLinkReason("busy", providerName: "ParkBoston"),
            "ParkAgent was busy with other parking accounts. Try again in a minute."
        )
    }
}

/// POST link answers with a job; link-status serves the scripted phases in
/// order (the last one repeats when asked); everything else hangs.
private final class ScriptedLinkAPI: HangingAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var statuses: [LinkStatusResponse]
    private let repeatLast: Bool
    private let pollsFail: Bool
    private var jobs = 0
    private var _submitted: [[ProviderCookie]] = []
    private var _served: [String] = []
    private var _polls = 0
    private var _notify: [String] = []

    init(statuses: [LinkStatusResponse], repeatLast: Bool = false, pollsFail: Bool = false) {
        self.statuses = statuses
        self.repeatLast = repeatLast
        self.pollsFail = pollsFail
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var linkCalls: Int { locked { jobs } }
    var submittedCookies: [[ProviderCookie]] { locked { _submitted } }
    var phasesServed: [String] { locked { _served } }
    var pollCount: Int { locked { _polls } }
    var notifyCalls: [String] { locked { _notify } }

    override func providersStatus() async throws -> ProvidersStatusResponse {
        ProvidersStatusResponse(providers: [MockFixtures.providerStatus(id: "passport", status: "unlinked", cardAdded: false)])
    }

    override func vehicles() async throws -> [VehicleSummary] { [] }
    override func me() async throws -> MeResponse { throw APIError.transport(CancellationError()) }

    override func linkProvider(
        _ providerId: String,
        cookies: [ProviderCookie],
        setUpCard: Bool,
        consent: Bool
    ) async throws -> ProviderLinkResponse {
        let id = locked {
            jobs += 1
            _submitted.append(cookies)
            return "job-\(jobs)"
        }
        return ProviderLinkResponse(status: "verifying", phase: "queued", jobId: id)
    }

    override func linkStatus(providerId: String, jobId: String) async throws -> LinkStatusResponse {
        let next: LinkStatusResponse? = locked {
            _polls += 1
            if pollsFail { return nil }
            let status = statuses.count > 1 || !repeatLast ? statuses.removeFirst() : statuses[0]
            _served.append(status.phase)
            return status
        }
        guard let next else { throw APIError.transport(URLError(.notConnectedToInternet)) }
        return next
    }

    override func notifyLinkJob(providerId: String, jobId: String) async throws -> LinkNotifyResponse {
        locked { _notify.append(jobId) }
        return LinkNotifyResponse(ok: true, phase: "verifying", notify: true)
    }
}
