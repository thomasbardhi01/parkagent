import Foundation

/// The one answer to "what is this signed-in user still missing?" — which
/// onboarding step to resume at, or nil for Home. RootView gathers the
/// facts (the OS for permissions, this phone for the city, the server for
/// the account's car and provider link) and asks here; nothing else
/// decides it. Pure, so the rules are unit-tested without a UI.
///
/// Sign-in is not a step: the welcome screen sits in front of this gate,
/// and a user without a valid session never reaches it.
enum OnboardingGate {
    struct Facts: Equatable {
        /// Everything detection needs is granted, or the user has seen
        /// plainly what won't work and chosen to go on (see below).
        var permissionsOK: Bool
        /// Whether the ACCOUNT has a car — the plate the executor types at
        /// the provider lives on the server now. nil when the server didn't
        /// answer in time.
        var serverHasVehicle: Bool?
        /// A plausible plate in this phone's defaults: the fallback when
        /// the server is unreachable, so a network blip can't send someone
        /// back to retype their car.
        var localVehicleOK: Bool
        /// The city chosen on this phone ("nyc" | "bos" | "other").
        var city: String?
        /// Provider ids whose link is usable (linked or expiring). nil when
        /// the server didn't answer in time.
        var usableProviders: Set<String>?
    }

    /// The permissions step is done when nothing is missing, or when the
    /// user read the "what won't work" summary and continued anyway. Later
    /// changes (a revoke in Settings) are Home's banner's job, not a
    /// reason to send anyone back through setup on every launch.
    static func permissionsOK(_ capabilities: DetectionCapabilities, acknowledgedLimited: Bool) -> Bool {
        capabilities.fullyGranted || acknowledgedLimited
    }

    static let limitedDetectionKey = "limitedDetectionAcknowledged"
    static var limitedDetectionAcknowledged: Bool {
        get { UserDefaults.standard.bool(forKey: limitedDetectionKey) }
        set { UserDefaults.standard.set(newValue, forKey: limitedDetectionKey) }
    }

    static func firstMissingStep(_ facts: Facts) -> OnboardingStep? {
        guard facts.permissionsOK else { return .permissions }
        guard facts.serverHasVehicle ?? facts.localVehicleOK else { return .vehicle }
        guard let city = facts.city,
              city == "other" || CityCatalog.all.contains(city)
        else { return .city }
        // "Somewhere else": the flow finishes without a provider to link.
        guard let providerId = CityCatalog.providerId(for: city) else { return nil }
        // Unreachable or slow server → Home, where the connectivity error
        // is shown; never trap anyone in onboarding over a network blip.
        guard let usable = facts.usableProviders else { return nil }
        return usable.contains(providerId) ? nil : .linkProvider
    }

    /// The loose plate check onboarding's vehicle step applies: plates vary
    /// wildly, so 2–8 characters and a two-letter state is enough.
    static func localVehicleOK(_ defaults: UserDefaults = .standard) -> Bool {
        let plate = (defaults.string(forKey: "vehicle.plate") ?? "").trimmingCharacters(in: .whitespaces)
        let state = (defaults.string(forKey: "vehicle.state") ?? "").trimmingCharacters(in: .whitespaces)
        return (2...8).contains(plate.count) && state.count == 2
    }

    /// How long the launch gate waits on the server before giving up and
    /// landing on Home. URLSession's own timeout is 60 s — on one bar of
    /// signal in a garage that was a minute of spinner.
    static let serverTimeout: Duration = .seconds(4)

    /// The server's half of the facts: the account's cars and provider
    /// links, fetched concurrently inside ONE bounded wait. Either half is
    /// nil if its call failed or the window closed first.
    static func serverFacts(
        api: any APIClient,
        timeout: Duration = serverTimeout
    ) async -> (hasVehicle: Bool?, usableProviders: Set<String>?) {
        async let vehicles = firstWithin(timeout) {
            try? await api.vehicles()
        }
        async let providers = firstWithin(timeout) {
            try? await api.providersStatus()
        }
        let (cars, status) = await (vehicles, providers)
        return (
            cars.map { !$0.isEmpty },
            status.map { Set($0.providers.filter(\.isLinked).map(\.id)) }
        )
    }

    /// The work's answer, or nil if it takes longer than `timeout`.
    private static func firstWithin<T: Sendable>(
        _ timeout: Duration,
        _ work: @escaping @Sendable () async -> T?
    ) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask { await work() }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}
