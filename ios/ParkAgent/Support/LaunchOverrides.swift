import Foundation

/// Launch arguments the app honors, mainly for the UI test target:
///
///   -useMockAPI YES        force the mock API on (or NO for live)
///   -skipOnboarding YES    land on Home instead of onboarding
///   -appearance dark       preset the appearance setting (system|light|dark)
///   -resetState YES        wipe UserDefaults before anything reads it
///   -mockScenario <name>   preset the mock /parked scenario
///   -cardScenario <name>   preset the mock Card tab state (see CardMockScenario)
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

    /// Call once, before any UserDefaults key is read (ParkAgentApp.init).
    static func applyToDefaults() {
        let defaults = UserDefaults.standard
        let argued = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
        // Read through UserDefaults while the argument domain is still up so
        // "YES"/"NO" strings coerce to Bool properly.
        let reset = argued["resetState"] != nil && defaults.bool(forKey: "resetState")
        let skipOnboarding = argued["skipOnboarding"] != nil && defaults.bool(forKey: "skipOnboarding")
        let mock = argued["useMockAPI"] != nil ? defaults.bool(forKey: "useMockAPI") : nil
        let appearance = argued[AppearanceSetting.defaultsKey] != nil
            ? defaults.string(forKey: AppearanceSetting.defaultsKey) : nil
        let scenario = argued[MockScenario.defaultsKey] != nil
            ? defaults.string(forKey: MockScenario.defaultsKey) : nil
        let cardScenario = argued[CardMockScenario.defaultsKey] != nil
            ? defaults.string(forKey: CardMockScenario.defaultsKey) : nil

        defaults.setVolatileDomain([:], forName: UserDefaults.argumentDomain)

        if reset, let bundleId = Bundle.main.bundleIdentifier {
            defaults.removePersistentDomain(forName: bundleId)
        }
        if skipOnboarding { defaults.set(true, forKey: "hasOnboarded") }
        if let mock { defaults.set(mock, forKey: "useMockAPI") }
        if let appearance { defaults.set(appearance, forKey: AppearanceSetting.defaultsKey) }
        if let scenario { defaults.set(scenario, forKey: MockScenario.defaultsKey) }
        if let cardScenario { defaults.set(cardScenario, forKey: CardMockScenario.defaultsKey) }
    }

    private static func flagValue(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return args[index + 1]
    }
}
