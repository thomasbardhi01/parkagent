import UIKit
import Vision

/// On-device text recognition for the parking-sign reader (Issue N). The
/// photos never leave the phone for this: Vision reads them here, and only
/// the text goes to the server, plus one photo when the reading was unsure
/// (`SignPhotoRule`).
struct SignTextReading: Equatable, Sendable {
    /// The lines Vision found, top of the sign first.
    var text: String
    /// Mean confidence over the recognized characters, 0 when nothing read.
    var confidence: Float
}

enum SignTextReader {
    /// Reads every photo, in order; one photo's lines, then the next's.
    static func read(_ images: [UIImage]) async -> [SignTextReading] {
        var readings: [SignTextReading] = []
        for image in images {
            readings.append(await read(image))
        }
        return readings
    }

    static func read(_ image: UIImage) async -> SignTextReading {
        guard let cgImage = image.cgImage else { return SignTextReading(text: "", confidence: 0) }
        let orientation = CGImagePropertyOrientation(image.imageOrientation)
        return await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            // Signs are abbreviations and numbers ("2 HR", "8AM-6PM"):
            // language correction "fixes" them into words.
            request.usesLanguageCorrection = false
            request.recognitionLanguages = ["en-US"]
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation)
            do {
                try handler.perform([request])
            } catch {
                return SignTextReading(text: "", confidence: 0)
            }
            let lines = (request.results ?? [])
                // Vision's origin is bottom-left: higher on the sign first.
                .sorted { $0.boundingBox.minY > $1.boundingBox.minY }
                .compactMap { $0.topCandidates(1).first }
            return reading(of: lines.map { ($0.string, $0.confidence) })
        }.value
    }

    /// The reading of recognized lines: their text, and their confidence
    /// weighted by length (a long line read well outweighs a stray mark).
    static func reading(of lines: [(text: String, confidence: Float)]) -> SignTextReading {
        let kept = lines.filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        let chars = kept.reduce(0) { $0 + $1.text.count }
        guard chars > 0 else { return SignTextReading(text: "", confidence: 0) }
        let weighted = kept.reduce(Float(0)) { $0 + $1.confidence * Float($1.text.count) }
        return SignTextReading(text: kept.map(\.text).joined(separator: "\n"), confidence: weighted / Float(chars))
    }

    /// The photo as the server takes it: a JPEG no longer than 1600 px on
    /// its long side and under `maxBytes` (the route's limit is 1.5 MB of
    /// base64, about 1.1 MB of JPEG). Nil if it can't get that small.
    static func uploadJPEG(_ image: UIImage, maxBytes: Int = 1_000_000) -> Data? {
        let longSide = max(image.size.width * image.scale, image.size.height * image.scale)
        let scale = longSide > 1600 ? 1600 / longSide : 1
        let size = CGSize(
            width: (image.size.width * image.scale * scale).rounded(),
            height: (image.size.height * image.scale * scale).rounded()
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        for quality in [0.7, 0.5, 0.35, 0.2] {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= maxBytes {
                return data
            }
        }
        return nil
    }
}

/// When a photo goes with the text: only when the recognition was unsure,
/// and then just the one it was least sure of. Every photo's text goes
/// regardless — the server grounds a reading on the text, never on a
/// photo alone.
enum SignPhotoRule {
    /// Below this mean confidence a reading is unsure.
    static let minConfidence: Float = 0.5
    /// Fewer characters than this is too little to be a sign.
    static let minCharacters = 8

    /// The index of the photo to send, or nil when every reading was sure.
    static func photoToSend(_ readings: [SignTextReading]) -> Int? {
        let unsure = readings.indices.filter { i in
            readings[i].confidence < minConfidence
                || readings[i].text.filter { !$0.isWhitespace }.count < minCharacters
        }
        return unsure.min { readings[$0].confidence < readings[$1].confidence }
    }

    /// Every photo's text, in order, blank readings left out.
    static func combinedText(_ readings: [SignTextReading]) -> String {
        readings.map(\.text).filter { !$0.isEmpty }.joined(separator: "\n")
    }
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
