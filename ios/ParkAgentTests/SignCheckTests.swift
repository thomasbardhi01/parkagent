import UIKit
import XCTest
@testable import ParkAgent

/// "Check the signs" (Issue N) on the phone: when a photo goes with the
/// text, what is sent, the four verdicts in words, and the one thing a
/// driver can take from a check, a shorter stay, taken once.
@MainActor
final class SignCheckTests: XCTestCase {
    // MARK: - The photo rule

    private func reading(_ text: String, _ confidence: Float) -> SignTextReading {
        SignTextReading(text: text, confidence: confidence)
    }

    func testSureReadingsSendNoPhoto() {
        XCTAssertNil(SignPhotoRule.photoToSend([
            reading("2 HOUR PARKING 8AM-8PM", 0.95),
            reading("PAY AT METER", 0.9),
        ]))
    }

    func testTheLeastSureUnsureReadingIsTheOnePhotoSent() {
        let readings = [
            reading("2 HOUR PARKING 8AM-8PM", 0.95),
            reading("N0 PARK1NG", 0.42),
            reading("TOW Z0NE 4-6", 0.31),
        ]
        XCTAssertEqual(SignPhotoRule.photoToSend(readings), 2)
    }

    func testTooLittleTextIsUnsureHoweverConfident() {
        XCTAssertEqual(SignPhotoRule.photoToSend([reading("P 2", 0.99)]), 0)
        XCTAssertEqual(SignPhotoRule.photoToSend([reading("", 0)]), 0)
    }

    func testEveryPhotosTextGoesInOrderBlanksLeftOut() {
        let text = SignPhotoRule.combinedText([reading("1 HOUR PARKING", 0.9), reading("", 0), reading("8AM - 6PM", 0.9)])
        XCTAssertEqual(text, "1 HOUR PARKING\n8AM - 6PM")
    }

    func testConfidenceIsWeightedByLength() {
        let r = SignTextReader.reading(of: [("2 HOUR PARKING", 0.9), ("x", 0.1), ("  ", 0)])
        XCTAssertEqual(r.text, "2 HOUR PARKING\nx")
        XCTAssertEqual(r.confidence, (0.9 * 14 + 0.1) / 15, accuracy: 1e-5)
    }

    // MARK: - On-device reading and the upload

    /// The real Vision reading of a rendered sign, as the UI test feeds it.
    func testVisionReadsARenderedSign() async {
        let r = await SignTextReader.read(SignFixtureImage.oneHourLimit())
        let text = r.text.uppercased()
        XCTAssertTrue(text.contains("1 HOUR"), "read \"\(r.text)\"")
        XCTAssertTrue(text.contains("PARKING"), "read \"\(r.text)\"")
        XCTAssertGreaterThan(r.confidence, SignPhotoRule.minConfidence)
    }

    func testTheUploadIsShrunkToTheRoutesLimit() throws {
        // A 4000 × 3000 phone photo of noise, the worst case for JPEG.
        let size = CGSize(width: 4000, height: 3000)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let noisy = UIGraphicsImageRenderer(size: size, format: format).image { context in
            for x in stride(from: 0, to: 4000, by: 20) {
                for y in stride(from: 0, to: 3000, by: 20) {
                    UIColor(hue: CGFloat((x * 7 + y * 13) % 360) / 360, saturation: 1, brightness: 1, alpha: 1)
                        .setFill()
                    context.fill(CGRect(x: x, y: y, width: 20, height: 20))
                }
            }
        }
        let data = try XCTUnwrap(SignTextReader.uploadJPEG(noisy))
        XCTAssertLessThanOrEqual(data.count, 1_000_000)
        XCTAssertLessThanOrEqual(data.base64EncodedString().count, 1_500_000, "over the route's base64 limit")
        let back = try XCTUnwrap(UIImage(data: data))
        XCTAssertEqual(max(back.size.width, back.size.height), 1600)
    }

    // MARK: - The wire shapes

    func testAVerdictThisBuildDoesntKnowReadsAsUnreadable() throws {
        let json = #"{"checkId":"c1","verdict":"maybe","rules":[],"confidence":0.5,"reasons":[],"offer":null,"zone":null,"photoKept":false,"advisory":true,"decisionId":"d1"}"#
        let check = try JSONDecoder().decode(SignCheckResponse.self, from: Data(json.utf8))
        XCTAssertEqual(check.verdict, .unreadable)
    }

    func testMeFromAnOlderServerHasNoReader() throws {
        let json = #"{"user":{"id":"u1","name":"A","email":null,"emailVerified":false,"phone":null,"phoneVerified":false,"appleLinked":true,"googleLinked":false},"paymentSource":"provider_card","issuingLive":false}"#
        let me = try JSONDecoder().decode(MeResponse.self, from: Data(json.utf8))
        XCTAssertNil(me.signReader)
    }

    // MARK: - The words

    func testEveryVerdictHasItsOwnHeadline() {
        let all: [SignVerdict] = [.agrees, .stricter, .conflicts, .unreadable]
        XCTAssertEqual(Set(all.map(SignCopy.headline)).count, all.count)
    }

    /// Advisory: no sentence may claim the signs paid, extended or charged.
    func testNoSentenceClaimsAMoneyAction() {
        let checks = [SignVerdict.agrees, .stricter, .conflicts, .unreadable].map { verdict in
            response(verdict, offer: verdict == .stricter ? 45 : nil)
        }
        let words = checks.map(SignCopy.detail) + checks.map { SignCopy.headline($0.verdict) }
            + [SignCopy.intro, SignCopy.advisory, SignCopy.accept(45), SignCopy.accepted(45)]
        for sentence in words {
            for claim in ["paid", "extended", "charged", "refund"] {
                XCTAssertFalse(sentence.lowercased().contains(claim), "\"\(sentence)\" says \(claim)")
            }
        }
    }

    func testAStricterCheckSaysTheOfferedStay() {
        XCTAssertTrue(SignCopy.detail(response(.stricter, offer: 35)).contains("35 min"))
        XCTAssertEqual(SignCopy.accept(60), "Hold this park to 1 hr")
    }

    func testARuleReadsAsOneShortLine() {
        let rule = SignRule(kind: "time_limit", days: ["mon", "tue", "wed", "thu", "fri", "sat"], start: "08:00",
                            end: "20:00", limitMinutes: 120, permitZone: nil, exceptions: [])
        XCTAssertEqual(SignCopy.rule(rule), "2 hr limit · Mon–Sat · 08:00–20:00")
        XCTAssertEqual(SignCopy.days(["fri", "mon", "wed"]), "Mon, Wed, Fri")
        XCTAssertEqual(SignCopy.days(["tue"]), "Tue")
    }

    func testEveryServerReasonHasWords() {
        let codes = ["no_parking", "no_stopping", "tow_zone", "street_cleaning", "permit_only",
                     "street_cleaning_later", "tow_zone_later", "time_limit_shorter", "time_limit_longer",
                     "meter_where_free"]
        for code in codes { XCTAssertNotNil(SignCopy.reason(code), code) }
        XCTAssertNil(SignCopy.reason("something_new"))
    }

    // MARK: - The model

    private func response(_ verdict: SignVerdict, offer: Int? = nil) -> SignCheckResponse {
        SignCheckResponse(
            checkId: "c1", verdict: verdict, rules: [], confidence: 0.9, reasons: [],
            offer: offer.map(SignOffer.init), zone: nil, photoKept: false, advisory: true, decisionId: "d1"
        )
    }

    private final class SignAPI: HangingAPI, @unchecked Sendable {
        var answer: Result<SignCheckResponse, APIError>
        var sent: [SignCheckRequest] = []
        var accepts: [String] = []
        init(_ answer: Result<SignCheckResponse, APIError>) { self.answer = answer }

        override func checkSigns(parkedEventId: String, request: SignCheckRequest) async throws -> SignCheckResponse {
            sent.append(request)
            return try answer.get()
        }

        override func acceptSignStay(parkedEventId: String, checkId: String) async throws -> SignAcceptResponse {
            accepts.append(checkId)
            return SignAcceptResponse(accepted: true, maxStayMinutes: 60, sessionId: nil)
        }
    }

    private let photo = SignFixtureImage.oneHourLimit()

    private func model(
        _ api: SignAPI, readings: [SignTextReading], fix: SignFix? = nil
    ) -> SignCheckModel {
        SignCheckModel(parkedEventId: "pe1", api: api, fix: { fix }, reader: { _ in readings })
    }

    func testASureReadingSendsTheTextAndTheFixButNoPhoto() async throws {
        let api = SignAPI(.success(response(.agrees)))
        let fix = SignFix(lat: 42.35, lng: -71.08, accuracy: 6)
        let m = model(api, readings: [reading("2 HOUR PARKING 8AM-8PM", 0.95)], fix: fix)
        m.add(photo)
        m.storePhoto = true
        await m.check()
        let sent = try XCTUnwrap(api.sent.first)
        XCTAssertEqual(sent.text, "2 HOUR PARKING 8AM-8PM")
        XCTAssertEqual(sent.fix, fix)
        XCTAssertNil(sent.photo)
        XCTAssertNil(sent.storePhoto, "nothing to keep without a photo")
        XCTAssertEqual(m.phase, .done(response(.agrees)))
    }

    func testAnUnsureReadingSendsOnePhotoWithTheText() async throws {
        let api = SignAPI(.success(response(.unreadable)))
        let m = model(api, readings: [reading("2 HOUR PARKING", 0.9), reading("N0 PARK", 0.2)])
        m.add(photo)
        m.add(photo)
        await m.check()
        let sent = try XCTUnwrap(api.sent.first)
        XCTAssertEqual(sent.text, "2 HOUR PARKING\nN0 PARK", "the text always goes, with the photo")
        XCTAssertEqual(sent.photo?.mediaType, "image/jpeg")
        XCTAssertNotNil(Data(base64Encoded: try XCTUnwrap(sent.photo?.data)))
        XCTAssertNil(sent.storePhoto, "kept only on the driver's opt-in")
    }

    func testTheOptInKeepsASentPhoto() async throws {
        let api = SignAPI(.success(response(.unreadable)))
        let m = model(api, readings: [reading("", 0)])
        m.add(photo)
        m.storePhoto = true
        await m.check()
        XCTAssertEqual(api.sent.first?.storePhoto, true)
    }

    func testNoMoreThanThreePhotos() {
        let m = model(SignAPI(.success(response(.agrees))), readings: [])
        for _ in 0..<5 { m.add(photo) }
        XCTAssertEqual(m.photos.count, SignCheckModel.maxPhotos)
        XCTAssertFalse(m.canAddPhoto)
    }

    func testAStricterOfferIsTakenOnceAndOnlyFromAStricterCheck() async {
        let api = SignAPI(.success(response(.stricter, offer: 60)))
        let m = model(api, readings: [reading("1 HOUR PARKING 8AM-6PM", 0.95)])
        m.add(photo)
        await m.check()
        await m.accept()
        await m.accept()
        XCTAssertEqual(api.accepts, ["c1"])
        XCTAssertEqual(m.accepted?.maxStayMinutes, 60)

        let agreeing = SignAPI(.success(response(.agrees)))
        let other = model(agreeing, readings: [reading("2 HOUR PARKING", 0.95)])
        other.add(photo)
        await other.check()
        await other.accept()
        XCTAssertEqual(agreeing.accepts, [], "nothing to accept from a check without an offer")
    }

    func testAFailedCheckSaysWhyAndCanStartOver() async {
        let api = SignAPI(.failure(.refused(code: "park_closed")))
        let m = model(api, readings: [reading("2 HOUR PARKING", 0.95)])
        m.add(photo)
        await m.check()
        XCTAssertEqual(m.phase, .failed("That park is over, so there's nothing to check."))
        m.startOver()
        XCTAssertEqual(m.phase, .capturing)
        XCTAssertTrue(m.photos.isEmpty)
    }
}
