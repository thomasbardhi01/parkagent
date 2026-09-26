#if DEBUG
import Foundation

/// UI tests' stand-in for the phone's permission state. The simulator can't
/// be told "While Using with Precise off" from inside a test, so a launch
/// argument pins the snapshot and scripts how the prompts would answer:
///
///   -capabilities "location=whileUsing,precise=off,motion=denied,
///                  notifications=denied,backgroundRefresh=denied,
///                  lowPower=on,services=off,alwaysPrompt=decline,
///                  whenAsked=whileUsing"
///
/// Every key is optional; an empty spec ("granted") is everything allowed.
/// `whenAsked` is what the location prompt answers (default While Using),
/// and `alwaysPrompt` how the Always upgrade goes: accept, decline, or
/// notShown (iOS skips it). Debug only, like every launch argument.
struct CapabilityOverride {
    enum AlwaysPrompt: String { case accept, decline, notShown }

    var capabilities = DetectionCapabilities(
        locationServicesEnabled: true,
        location: .always,
        preciseLocation: true,
        motion: .authorized,
        notifications: .authorized,
        backgroundRefresh: .available,
        lowPowerMode: false
    )
    var whenAsked: DetectionCapabilities.Location = .whileUsing
    var alwaysPrompt: AlwaysPrompt = .accept

    static func fromLaunchArguments() -> CapabilityOverride? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-capabilities"), index + 1 < args.count else { return nil }
        return parse(args[index + 1])
    }

    static func parse(_ spec: String) -> CapabilityOverride {
        var result = CapabilityOverride()
        for pair in spec.split(separator: ",") {
            let parts = pair.split(separator: "=", maxSplits: 1).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            guard parts.count == 2 else { continue }
            let (key, value) = (parts[0], parts[1])
            let on = value == "on" || value == "true"
            switch key {
            case "location":
                if let location = DetectionCapabilities.Location(rawValue: value) {
                    result.capabilities.location = location
                }
            case "precise": result.capabilities.preciseLocation = on
            case "services": result.capabilities.locationServicesEnabled = on
            case "motion":
                if let motion = DetectionCapabilities.Motion(rawValue: value) { result.capabilities.motion = motion }
            case "notifications":
                if let notifications = DetectionCapabilities.Notifications(rawValue: value) {
                    result.capabilities.notifications = notifications
                }
            case "backgroundRefresh":
                if let refresh = DetectionCapabilities.BackgroundRefresh(rawValue: value) {
                    result.capabilities.backgroundRefresh = refresh
                }
            case "lowPower": result.capabilities.lowPowerMode = on
            case "alwaysPrompt":
                if let prompt = AlwaysPrompt(rawValue: value) { result.alwaysPrompt = prompt }
            case "whenAsked":
                if let location = DetectionCapabilities.Location(rawValue: value) { result.whenAsked = location }
            default: continue
            }
        }
        return result
    }
}
#endif
