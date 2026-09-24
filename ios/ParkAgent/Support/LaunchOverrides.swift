import Foundation

/// Launch arguments the app honors, mainly for the UI test target:
///
///   -useMockAPI YES        run this launch on the mock API (never persisted;
///                          without it every build talks to the live server)
///   -skipOnboarding YES    land on Home instead of onboarding
///   -appearance dark       preset the appearance setting (system|light|dark)
///   -resetState YES        wipe UserDefaults before anything reads it
///   -mockScenario <name>   preset the mock /parked scenario
///   -cardScenario <name>   preset the mock Card tab state (see CardMockScenario)
///   -providerScenario <name>  preset the mock provider-account state
///   -cityScenario <name>   preset the mock GET /city answer (nyc|bos|none)
///   -assistantScenario <name>  preset the mock assistant (auto|singleSpot|itinerary|refuse|error)
///   -linkScenario <name>   preset the mock Link wallet (disconnected|connected|denies)
///   -speechScenario <name> script the assistant's dictation (scripted|denied|unavailable)
///   -paymentSource <raw>   preset the payment source (provider_card|issuing_card)
///   -issuingLive YES       the mock reports the ParkAgent card as live
///   -onboardingStep <n>    resume onboarding at step n (OnboardingStep raw)
///   -selectedCity <key>    preset onboarding's chosen city (nyc|bos|other)
///   -fixedNow <epoch>      freeze AppClock (see AppClock.swift)
///   -uiTesting YES         suppress detector/push side effects and expose
///                          the color-scheme probe label
///
/// `applyToDefaults()` copies the `-key value` pairs into the persistent
/// domain and then clears the volatile argument domain. Without that step the
/// argument domain would shadow every later write — a test that flips the
/// appearance picker would see the launch argument win forever.
enum LaunchOverrides {
    static let uiTesting: Bool = flagValue("-uiTesting") == "YES"

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
        CardMockScenario.defaultsKey,
        ProviderMockScenario.defaultsKey,
        CityMockScenario.defaultsKey,
        AssistantMockScenario.defaultsKey,
        LinkMockScenario.defaultsKey,
        SpeechMockScenario.defaultsKey,
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
        let cardScenario = argued[CardMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: CardMockScenario.defaultsKey) : nil
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
        let onboardingStep = argued[OnboardingStep.defaultsKey] != nil
            ? defaults.integer(forKey: OnboardingStep.defaultsKey) : nil
        let selectedCity = argued["selectedCity"] != nil
            ? defaults.string(forKey: "selectedCity") : nil

        defaults.setVolatileDomain([:], forName: UserDefaults.argumentDomain)

        if reset, let bundleId = Bundle.main.bundleIdentifier {
            defaults.removePersistentDomain(forName: bundleId)
        }
        // Scrub before the argument writes below, so UI-test launches still
        // get their scenario keys and everyone else starts clean.
        for key in mockDefaultsKeys {
            defaults.removeObject(forKey: key)
        }
        if skipOnboarding { defaults.set(true, forKey: "hasOnboarded") }
        if let appearance { defaults.set(appearance, forKey: AppearanceSetting.defaultsKey) }
        if let scenario { defaults.set(scenario, forKey: MockScenario.defaultsKey) }
        if let cardScenario { defaults.set(cardScenario, forKey: CardMockScenario.defaultsKey) }
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
        if let onboardingStep { defaults.set(onboardingStep, forKey: OnboardingStep.defaultsKey) }
        if let selectedCity { defaults.set(selectedCity, forKey: "selectedCity") }
    }

    private static func flagValue(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return args[index + 1]
    }
}
