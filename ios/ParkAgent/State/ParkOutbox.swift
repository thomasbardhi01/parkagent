import Foundation

/// Park reports that couldn't reach the server, kept on disk until they
/// can. Before this, a park detected in a garage or a tunnel was simply
/// lost: one POST /parked, one failure, and the detector had already moved
/// on — no sheet, no notification, no retry.
///
/// Each report keeps the idempotency key it was first sent with, so one
/// that did reach the server (the answer was what got lost) counts once
/// however many times it's delivered. Reports are sent in the order they
/// were made, when the connection comes back, the app returns to the
/// foreground, or detection starts; older than `maxAge` they're dropped —
/// the driver has long since paid or left.
actor ParkOutbox {
    struct Item: Codable, Equatable, Sendable {
        /// Also the Idempotency-Key.
        var key: String
        var request: ParkedRequest
        var queuedAt: Date
        var attempts: Int
    }

    /// What one delivery pass did.
    struct Delivery: Sendable {
        var item: Item
        var response: ParkedResponse
    }

    static let maxAge: TimeInterval = 12 * 60 * 60

    private let fileURL: URL
    private var items: [Item]

    init(fileURL: URL = ParkOutbox.defaultURL) {
        self.fileURL = fileURL
        self.items = (try? JSONDecoder.outbox.decode([Item].self, from: Data(contentsOf: fileURL))) ?? []
    }

    static var defaultURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appending(path: "park-outbox.json")
    }

    var pending: [Item] { items }

    func enqueue(_ request: ParkedRequest, key: String, at date: Date = Date()) {
        guard !items.contains(where: { $0.key == key }) else { return }
        items.append(Item(key: key, request: request, queuedAt: date, attempts: 0))
        save()
    }

    /// Send what's waiting, oldest first. A report the server answered (or
    /// refused outright — a 4xx won't change on retry) leaves the queue; a
    /// network failure stops the pass, still offline, and keeps the rest.
    func flush(
        now: Date = Date(),
        send: @Sendable (ParkedRequest, String) async throws -> ParkedResponse
    ) async -> [Delivery] {
        items.removeAll { now.timeIntervalSince($0.queuedAt) > Self.maxAge }
        var delivered: [Delivery] = []
        while let item = items.first {
            do {
                let response = try await send(item.request, item.key)
                items.removeFirst()
                delivered.append(Delivery(item: item, response: response))
            } catch let error as APIError where Self.isFinal(error) {
                items.removeFirst()
            } catch {
                items[0].attempts += 1
                break
            }
        }
        save()
        return delivered
    }

    /// A verdict, not the network: retrying can't change it.
    static func isFinal(_ error: APIError) -> Bool {
        switch error {
        case .transport, .server, .cancelled: false
        case .refused(let code): code != "request_in_progress"
        default: true
        }
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try JSONEncoder.outbox.encode(items).write(to: fileURL, options: [.atomic])
        } catch {
            // Best effort: the in-memory queue still delivers this launch.
        }
    }
}

private extension JSONEncoder {
    static let outbox: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private extension JSONDecoder {
    static let outbox: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
