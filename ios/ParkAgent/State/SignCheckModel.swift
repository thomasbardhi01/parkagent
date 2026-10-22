import Observation
import UIKit

/// One "Check the signs" for one park (Issue N): up to three photos, read
/// on the phone, then one call to the server, then the driver's choice to
/// take a stricter check's shorter stay. Advisory throughout: nothing here
/// pays, extends, or prices.
@MainActor
@Observable
final class SignCheckModel {
    enum Phase: Equatable {
        case capturing
        case reading
        case checking
        case done(SignCheckResponse)
        case failed(String)
    }

    static let maxPhotos = 3

    let parkedEventId: String
    private(set) var photos: [UIImage] = []
    private(set) var phase: Phase = .capturing
    /// The driver's opt-in to keep a sent photo for the review queue.
    var storePhoto = false
    private(set) var accepted: SignAcceptResponse?
    private(set) var accepting = false
    private(set) var acceptError: String?

    @ObservationIgnored private let api: any APIClient
    @ObservationIgnored private let fix: () -> SignFix?
    @ObservationIgnored private let reader: ([UIImage]) async -> [SignTextReading]

    init(
        parkedEventId: String,
        api: any APIClient,
        fix: @escaping () -> SignFix? = { nil },
        reader: @escaping ([UIImage]) async -> [SignTextReading] = { await SignTextReader.read($0) }
    ) {
        self.parkedEventId = parkedEventId
        self.api = api
        self.fix = fix
        self.reader = reader
    }

    var canAddPhoto: Bool { phase == .capturing && photos.count < Self.maxPhotos }
    var canRead: Bool { phase == .capturing && !photos.isEmpty }

    func add(_ image: UIImage) {
        guard canAddPhoto else { return }
        photos.append(image)
    }

    func removePhoto(at index: Int) {
        guard phase == .capturing, photos.indices.contains(index) else { return }
        photos.remove(at: index)
    }

    /// Read the photos here, then ask the server. The text always goes; a
    /// photo only when the reading was unsure, and only the least sure one.
    func check() async {
        guard canRead else { return }
        phase = .reading
        let readings = await reader(photos)
        var photo: SignPhoto?
        if let index = SignPhotoRule.photoToSend(readings) {
            let image = photos[index]
            // A 12 MP render and up to four encodes: not on the main actor.
            let encoded = await Task.detached(priority: .userInitiated) {
                SignTextReader.uploadJPEG(image)?.base64EncodedString()
            }.value
            if let encoded { photo = SignPhoto(mediaType: "image/jpeg", data: encoded) }
        }
        let request = SignCheckRequest(
            text: SignPhotoRule.combinedText(readings),
            fix: fix(),
            photo: photo,
            storePhoto: photo != nil && storePhoto ? true : nil
        )
        phase = .checking
        do {
            phase = .done(try await api.checkSigns(parkedEventId: parkedEventId, request: request))
        } catch {
            phase = .failed((error as? APIError)?.errorDescription ?? "The signs couldn't be checked. Try again.")
        }
    }

    /// Take a stricter check's shorter stay. Once; the server only ever
    /// tightens, so a second tap could change nothing anyway.
    func accept() async {
        guard case .done(let check) = phase, check.verdict == .stricter, check.offer != nil,
              accepted == nil, !accepting else { return }
        accepting = true
        acceptError = nil
        defer { accepting = false }
        do {
            accepted = try await api.acceptSignStay(parkedEventId: parkedEventId, checkId: check.checkId)
        } catch {
            acceptError = (error as? APIError)?.errorDescription ?? "That didn't go through. Try again."
        }
    }

    /// Where the phone is, for the check: a fix under 2 minutes old and
    /// within 50 m, else nil and the server uses where the park was
    /// reported.
    nonisolated static func usableFix(_ fix: ParkFix?, now: Date) -> SignFix? {
        guard let fix, fix.accuracy >= 0, fix.accuracy <= 50,
              now.timeIntervalSince(fix.at) < 120 else { return nil }
        return SignFix(lat: fix.latitude, lng: fix.longitude, accuracy: fix.accuracy)
    }

    func startOver() {
        photos = []
        phase = .capturing
        storePhoto = false
        accepted = nil
        acceptError = nil
    }
}
