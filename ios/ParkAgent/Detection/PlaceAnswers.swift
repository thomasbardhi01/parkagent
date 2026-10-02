import CoreLocation
import Foundation
import UIKit

/// The driver's own answer about a park's place (FR-54): sent to the
/// server first (POST /parked/:id/place, where it becomes the record the
/// classifier is scored against), and only then written to the phone's
/// place memory. An answer the server never got teaches the phone nothing:
/// the two can't disagree about what the driver said.
@MainActor
enum PlaceAnswers {
    /// True when the server recorded the answer.
    @discardableResult
    static func record(
        _ answer: ParkedNotice.PlaceAnswer,
        parkedEventId: String,
        at coordinate: CLLocationCoordinate2D?,
        api: any APIClient,
        memory: PlaceMemoryStore,
        now: Date = Date()
    ) async -> Bool {
        do {
            _ = try await api.answerPlace(parkedEventId: parkedEventId, placeClass: answer.rawValue, name: nil)
        } catch {
            return false
        }
        guard let coordinate else { return true }
        memory.update { places in
            switch answer {
            case .street: places.confirm(.street, at: coordinate, now: now)
            case .garage: places.confirm(.garage, at: coordinate, now: now)
            case .lot: places.confirm(.lot, at: coordinate, now: now)
            case .nopay: places.confirm(.nopay, at: coordinate, now: now)
            // Not a place: quiet the spot, learn nothing.
            case .notHere: places.notMyCar(at: coordinate, now: now)
            }
        }
        return true
    }
}

// MARK: - The park flow's place half

/// What AppModel does with a park's place: how a /parked answer is put in
/// front of the driver, a park with no fix at its spot, and the driver's
/// answers from the sheet and from a notification's buttons.
extension AppModel {
    /// A /parked answer, live or from the outbox: the sheet, and a
    /// notification when the app is in the background. `request` is what
    /// was sent, so a park reported from its entry fix is told apart.
    func presentPark(_ response: ParkedResponse, for request: ParkedRequest, fromOutbox: Bool = false) async {
        let coordinate = CLLocationCoordinate2D(latitude: request.lat, longitude: request.lng)
        let located = request.placeHint?.inputs.located != false
        let now = Date()
        let decision = ParkedNotice.decide(
            for: response, located: located, at: coordinate, memory: detector.placeMemory.memory,
            // A park that waited in the outbox is long past its stop.
            lastAutomotiveAt: fromOutbox ? nil : detector.lastAutomotiveAt, now: now
        )
        paymentError = nil
        // A real park is the freshest city signal there is.
        if let city = response.candidates.first?.city {
            detectedCity = city
        }
        if decision == .unlocated {
            // The answer is about the street at the entry fix, not the car.
            // Offline, the driver was already told when it was queued.
            if !fromOutbox { await ParkedNotice.postUnlocated(preciseOff: false) }
            return
        }
        // A park that waited offline was already announced from the phone's
        // own read (handleUnlocatedPark), with nothing to answer: now that
        // the server has it, the sheet can take the answer. No second
        // notification.
        let answerable = fromOutbox && decision == .silent(.askedToday)
        guard decision.showsSheet || answerable else { return }
        carCoordinate = coordinate
        pendingParked = response
        let prompt: ParkedNotice.Prompt
        var due: Date?
        switch decision {
        case .post(let posted):
            prompt = posted
        case .hold(let held, let until):
            prompt = held
            due = until
        case .silent, .unlocated:
            return
        }
        if prompt.isPlacePrompt {
            detector.placeMemory.update { $0.notePrompt(at: coordinate, now: now) }
        }
        // Backgrounded (the usual case: the driver just walked away), the
        // sheet waits unseen — say so with a notification. A held prompt
        // is scheduled either way: by the time it is due the app may be.
        if UIApplication.shared.applicationState != .active || due != nil {
            await ParkedNotice.post(prompt, parkedEventId: response.parkedEventId, at: coordinate, due: due, now: now)
        }
    }

    /// A park with nowhere to point: GPS gone at the spot (a garage), or
    /// Precise Location off. With an entry fix it is still reported, from
    /// there, and /parked answers for the place (never a street quote).
    func handleUnlocatedPark(preciseOff: Bool, outcome: ParkOutcome, place: PlaceClassification) async {
        guard !preciseOff, let entry = outcome.entryFix else {
            await ParkedNotice.postUnlocated(preciseOff: preciseOff)
            return
        }
        let report = await handleDetectedPark(
            coordinate: entry.coordinate, accuracy: entry.accuracy, signals: outcome.signals,
            detectedAt: outcome.stopAt, placeHint: PlaceHint(place)
        )
        switch report {
        case .answered:
            return
        case .refused:
            // The server won't take it: all that's left to say is the old
            // "couldn't tell where".
            await ParkedNotice.postUnlocated(preciseOff: false)
        case .queued:
            // No signal (the usual garage): the park waits in the outbox,
            // and there's no park on the server to answer about yet. Say
            // what the phone itself made of it.
            let prompt = ParkedNotice.offlinePrompt(for: place, preciseOff: false)
            let now = Date()
            let memory = detector.placeMemory.memory
            guard !prompt.isPlacePrompt
                    || !(place.inputs.memoryHit
                         || memory.isSuppressed(at: entry.coordinate, now: now)
                         || memory.promptedSameDay(at: entry.coordinate, now: now))
            else { return }
            var due: Date?
            if prompt.isPlacePrompt {
                detector.placeMemory.update { $0.notePrompt(at: entry.coordinate, now: now) }
                if let last = detector.lastAutomotiveAt {
                    let still = last.addingTimeInterval(ParkedNotice.stillFor)
                    if still > now { due = still }
                }
            }
            await ParkedNotice.post(prompt, parkedEventId: nil, at: entry.coordinate, due: due, now: now)
        }
    }

    /// The car drove on before a held place prompt was due: it was a
    /// pause (a ticket gate, a pickup), not a park. Take the prompt back.
    func drivingResumed() {
        guard let held = ParkedNotice.cancelHeld() else { return }
        let spot = CLLocationCoordinate2D(latitude: held.latitude, longitude: held.longitude)
        detector.placeMemory.update { $0.forgetPrompt(at: spot, since: held.notedAt) }
        if let id = held.parkedEventId, pendingParked?.parkedEventId == id {
            dismissParkedSheet()
        }
    }

    /// The driver says what the place is, from the sheet. False when the
    /// server never got it (the sheet stays up and says so).
    func answerPlace(_ answer: ParkedNotice.PlaceAnswer, for parked: ParkedResponse) async -> Bool {
        await PlaceAnswers.record(
            answer, parkedEventId: parked.parkedEventId, at: carCoordinate,
            api: api, memory: detector.placeMemory
        )
    }

    /// A button on a place notification, possibly with the app relaunched
    /// in the background for it.
    func handlePlaceAction(_ action: ParkedNotice.Action, parkedEventId: String, at coordinate: CLLocationCoordinate2D?) async {
        guard let answer = action.answer else {
            // "Not a garage": the app is opening; ask what it is.
            placeAskFor = parkedEventId
            selectedTab = .park
            return
        }
        let recorded = await PlaceAnswers.record(
            answer, parkedEventId: parkedEventId, at: coordinate ?? carCoordinate,
            api: api, memory: detector.placeMemory
        )
        // Answered: the sheet for this park has nothing left to ask. (A
        // "Street" button only exists where there is no quote to go on to;
        // with one, the street answer is tapping the notification itself.)
        if recorded, pendingParked?.parkedEventId == parkedEventId {
            dismissParkedSheet()
        }
    }
}
