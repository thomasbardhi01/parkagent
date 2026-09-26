import Foundation

/// Launch arguments the app honors, mainly for the UI test target:
///
///   -useMockAPI YES        run this launch on the mock API (never persisted;
///                          without it every build talks to the live server)
///   -skipOnboarding YES    land on Home instead of onboarding
///   -appearance dark       preset the appearance setting (system|light|dark)
///   -resetState YES        wipe UserDefaults before anything reads it
///   -mockScenario <name>   preset the mock /parked scenario
///   -walletScenario <name> preset the mock Wallet (see WalletMockScenario:
///                          providerCard|linkActive|linkNotConfigured|
///                          parkagentSandbox|empty)
///   -providerScenario <name>  preset the mock provider-account state
///   -cityScenario <name>   preset the mock GET /city answer (nyc|bos|none)
///   -assistantScenario <name>  preset the mock assistant (auto|singleSpot|itinerary|refuse|error)
///   -linkScenario <name>   preset the mock Link wallet (disconnected|connected|denies)
///   -speechScenario <name> script the assistant's dictation (scripted|denied|unavailable)
///   -paymentSource <raw>   preset the payment source (provider_card|link_wallet|parkagent_card)
///   -issuingLive YES       the mock reports the ParkAgent card as live
///   -parkAgentSandbox YES  preset Diagnostics' ParkAgent-card sandbox toggle
///   -policyReadOnly YES    the mock policy isn't editable by this user
///   -authScenario <name>   preset the mock sign-in (returning|newUser|badCode|appleFails)
///   -signedIn YES          seed a mock session so the app starts past the
///                          welcome screen (most tests want this)
///   -seedSession <json>    DEBUG: seed a REAL session ({accessToken,
///                          refreshToken, deviceId} from create:fr-throwaway)
///                          for live-path checks against a local API
///   -authMethods <csv>     the mock server's switched-on sign-in methods
///                          (default "apple"; e.g. "apple,email,google")
///   -googleSignIn YES      the app can do Google sign-in (the SDK flag); the
///                          button still needs the server to report it on
///   -onboardingStep <n>    resume onboarding at step n (OnboardingStep raw)
///   -selectedCity <key>    preset onboarding's chosen city (nyc|bos|other)
///   -fixedNow <epoch>      freeze AppClock (see AppClock.swift)
///   -uiTesting YES         suppress detector/push side effects and expose
///                          the color-scheme probe label
///   -capabilities <spec>   pin the permission state (CapabilityOverride)
///   -detectorSignalLogEnabled YES  turn on the signal log (Diagnostics' switch)
///   -detectorSimulation YES  run the REAL detector in a UI test, with motion
///                          derived from the simulated location's speed (the
///                          simulator has no motion coprocessor)
///
/// `applyToDefaults()` copies the `-key value` pairs into the persistent
/// domain and then clears the volatile argument domain. Without that step the
/// argument domain would shadow every later write — a test that flips the
/// appearance picker would see the launch argument win forever.
///
/// All of it is DEBUG-only. A Release build honors no launch argument at
/// all: `uiTesting` and `useMockAPI` are the constant `false`, and nothing
/// here — the argument names, the scenario keys, the session seeding — is
/// compiled into it (ParkAgentReleaseTests checks the binary).
enum LaunchOverrides {
    #if DEBUG
    static let uiTesting: Bool = flagValue("-uiTesting") == "YES"
    static let detectorSimulation: Bool = flagValue("-detectorSimulation") == "YES"

    /// The mock API is a launch-time decision, never persisted: the UI tests
    /// pass `-useMockAPI YES`; every other launch — Debug and Release alike —
    /// talks to the live server. SwiftUI previews also get the mock so they
    /// render without a network; previews never install on a phone.
    static let useMockAPI: Bool =
        flagValue("-useMockAPI") == "YES"
        || ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"

    /// Every persisted key that only exists to steer the mock. Older builds
    /// persisted `useMockAPI` (defaulting ON under DEBUG) plus the UI-test
    /// scenario keys, so a phone installed from Xcode could quietly run on
    /// fixtures forever. Normal launches scrub all of them; UI-test launches
    /// re-write theirs from the arguments right after.
    private static let mockDefaultsKeys = [
        "useMockAPI",
        "issuingLive",
        MockScenario.defaultsKey,
        WalletMockScenario.defaultsKey,
        ProviderMockScenario.defaultsKey,
        CityMockScenario.defaultsKey,
        AssistantMockScenario.defaultsKey,
        LinkMockScenario.defaultsKey,
        SpeechMockScenario.defaultsKey,
        AuthMockScenario.defaultsKey,
        MockAPI.authMethodsKey,
        MockAPI.policyReadOnlyKey,
    ]

    /// Call once, before any UserDefaults key is read (ParkAgentApp.init).
    static func applyToDefaults() {
        let defaults = UserDefaults.standard
        let argued = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
        // Read through UserDefaults while the argument domain is still up so
        // "YES"/"NO" strings coerce to Bool properly.
        let reset = argued["resetState"] != nil && defaults.bool(forKey: "resetState")
        let skipOnboarding = argued["skipOnboarding"] != nil && defaults.bool(forKey: "skipOnboarding")
        let appearance = argued[AppearanceSetting.defaultsKey] != nil
            ? defaults.string(forKey: AppearanceSetting.defaultsKey) : nil
        let scenario = argued[MockScenario.defaultsKey] != nil
            ? defaults.string(forKey: MockScenario.defaultsKey) : nil
        let walletScenario = argued[WalletMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: WalletMockScenario.defaultsKey) : nil
        let providerScenario = argued[ProviderMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: ProviderMockScenario.defaultsKey) : nil
        let cityScenario = argued[CityMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: CityMockScenario.defaultsKey) : nil
        let assistantScenario = argued[AssistantMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: AssistantMockScenario.defaultsKey) : nil
        let linkScenario = argued[LinkMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: LinkMockScenario.defaultsKey) : nil
        let speechScenario = argued[SpeechMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: SpeechMockScenario.defaultsKey) : nil
        let paymentSource = argued[PaymentSource.defaultsKey] != nil
            ? defaults.string(forKey: PaymentSource.defaultsKey) : nil
        let issuingLive = argued["issuingLive"] != nil ? defaults.bool(forKey: "issuingLive") : nil
        let policyReadOnly = argued[MockAPI.policyReadOnlyKey] != nil
            && defaults.bool(forKey: MockAPI.policyReadOnlyKey)
        let parkAgentSandbox = argued[FeatureFlags.parkAgentSandboxKey] != nil
            ? defaults.bool(forKey: FeatureFlags.parkAgentSandboxKey) : nil
        let onboardingStep = argued[OnboardingStep.defaultsKey] != nil
            ? defaults.integer(forKey: OnboardingStep.defaultsKey) : nil
        let selectedCity = argued["selectedCity"] != nil
            ? defaults.string(forKey: "selectedCity") : nil
        let authScenario = argued[AuthMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: AuthMockScenario.defaultsKey) : nil
        let authMethods = argued[MockAPI.authMethodsKey] != nil
            ? defaults.string(forKey: MockAPI.authMethodsKey) : nil
        let signedIn = argued["signedIn"] != nil && defaults.bool(forKey: "signedIn")
        // Raw argv, not the argument domain: UserDefaults parses argument
        // values as property lists, and a JSON object doesn't survive that.
        let seededSession = flagValue("-seedSession")
        let googleSignIn = argued["googleSignIn"] != nil
            ? defaults.bool(forKey: "googleSignIn") : nil
        let signalLog = argued[SignalLog.enabledKey] != nil
            ? defaults.bool(forKey: SignalLog.enabledKey) : nil

        defaults.setVolatileDomain([:], forName: UserDefaults.argumentDomain)

        if reset, let bundleId = Bundle.main.bundleIdentifier {
            defaults.removePersistentDomain(forName: bundleId)
            // UserDefaults resets don't reach the Keychain, and a session
            // left over from the previous test would skip the welcome
            // screen the next one is trying to exercise.
            Keychain.clearAll()
            AuthUser.clearCache()
            // A stop the previous test left pending would fire in this one.
            DetectorStore.clearDefault()
        }
        // Scrub before the argument writes below, so UI-test launches still
        // get their scenario keys and everyone else starts clean.
        for key in mockDefaultsKeys {
            defaults.removeObject(forKey: key)
        }
        // A seeded session: tests that aren't about signing in start inside
        // the app (mock tokens), and live-path checks start with a real one.
        if signedIn { Keychain.seedTestSession() }
        if let seededSession, let data = seededSession.data(using: .utf8),
           let seed = try? JSONDecoder().decode([String: String].self, from: data),
           let access = seed["accessToken"], let refresh = seed["refreshToken"],
           let deviceId = seed["deviceId"] {
            Keychain.seedSession(access: access, refresh: refresh, deviceId: deviceId)
        }
        if skipOnboarding { defaults.set(true, forKey: "hasOnboarded") }
        if let appearance { defaults.set(appearance, forKey: AppearanceSetting.defaultsKey) }
        if let scenario { defaults.set(scenario, forKey: MockScenario.defaultsKey) }
        if let walletScenario { defaults.set(walletScenario, forKey: WalletMockScenario.defaultsKey) }
        if let providerScenario {
            defaults.set(providerScenario, forKey: ProviderMockScenario.defaultsKey)
        }
        if let cityScenario { defaults.set(cityScenario, forKey: CityMockScenario.defaultsKey) }
        if let assistantScenario {
            defaults.set(assistantScenario, forKey: AssistantMockScenario.defaultsKey)
        }
        if let linkScenario { defaults.set(linkScenario, forKey: LinkMockScenario.defaultsKey) }
        if let speechScenario { defaults.set(speechScenario, forKey: SpeechMockScenario.defaultsKey) }
        if let paymentSource { defaults.set(paymentSource, forKey: PaymentSource.defaultsKey) }
        if let issuingLive { defaults.set(issuingLive, forKey: "issuingLive") }
        if let parkAgentSandbox { defaults.set(parkAgentSandbox, forKey: FeatureFlags.parkAgentSandboxKey) }
        if policyReadOnly { defaults.set(true, forKey: MockAPI.policyReadOnlyKey) }
        if let onboardingStep { defaults.set(onboardingStep, forKey: OnboardingStep.defaultsKey) }
        if let selectedCity { defaults.set(selectedCity, forKey: "selectedCity") }
        if let authScenario { defaults.set(authScenario, forKey: AuthMockScenario.defaultsKey) }
        if let authMethods { defaults.set(authMethods, forKey: MockAPI.authMethodsKey) }
        if let googleSignIn { defaults.set(googleSignIn, forKey: FeatureFlags.googleSignInKey) }
        if let signalLog { defaults.set(signalLog, forKey: SignalLog.enabledKey) }
    }

    private static func flagValue(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return args[index + 1]
    }
    #else
    static let uiTesting = false
    static let useMockAPI = false
    static func applyToDefaults() {}
    #endif
}
