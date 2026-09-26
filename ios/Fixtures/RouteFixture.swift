import Foundation

/// The detector's test route (Fixtures/drive-park-walk.gpx, written by
/// Tools/make-route.py), read by the unit and UI test targets alike. Each
/// point is one second apart and names its phase: drive, light, park,
/// walk_away, far, walk_back, back.
struct RouteFixture {
    struct Point {
        let latitude: Double
        let longitude: Double
        /// Seconds from the route's start.
        let offset: TimeInterval
        let phase: String
    }

    let points: [Point]

    static func load(from bundle: Bundle, named name: String = "drive-park-walk") throws -> RouteFixture {
        guard let url = bundle.url(forResource: name, withExtension: "gpx") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return parse(try Data(contentsOf: url))
    }

    static func parse(_ data: Data) -> RouteFixture {
        let reader = Reader()
        let parser = XMLParser(data: data)
        parser.delegate = reader
        parser.parse()
        guard let start = reader.points.first?.time else { return RouteFixture(points: []) }
        return RouteFixture(points: reader.points.map {
            Point(latitude: $0.lat, longitude: $0.lng, offset: $0.time.timeIntervalSince(start), phase: $0.phase)
        })
    }

    func points(in phase: String) -> [Point] {
        points.filter { $0.phase == phase }
    }

    func firstIndex(of phase: String) -> Int? {
        points.firstIndex { $0.phase == phase }
    }

    private final class Reader: NSObject, XMLParserDelegate {
        var points: [(lat: Double, lng: Double, time: Date, phase: String)] = []
        private var lat = 0.0, lng = 0.0
        private var element = ""
        private var text = ""
        private var time: Date?
        private var phase = ""
        private let formatter = ISO8601DateFormatter()

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String] = [:]) {
            element = name
            text = ""
            if name == "trkpt" {
                lat = Double(attributes["lat"] ?? "") ?? 0
                lng = Double(attributes["lon"] ?? "") ?? 0
                time = nil
                phase = ""
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            text += string
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            switch name {
            case "time": time = formatter.date(from: value)
            case "type": phase = value
            case "trkpt":
                if let time { points.append((lat, lng, time, phase)) }
            default: break
            }
            text = ""
        }
    }
}
