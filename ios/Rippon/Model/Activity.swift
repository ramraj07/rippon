import Foundation

/// The SSH activity log. ssh failures are diagnosed from what the server said and
/// how long it took, so both are kept — even for successes, since a call that
/// usually takes 200ms and starts taking 8s is the warning sign.
@MainActor
final class ActivityLog: ObservableObject {
    static let shared = ActivityLog()

    enum Level: String { case info, ok, warn, error }

    struct Entry: Identifiable {
        let id: Int
        var at: Date
        let source: String
        let level: Level
        let text: String
        let ms: Int?
        let detail: String?
        /// Repeats of the identical line. The session poll runs every 5s, so
        /// without collapsing it would bury everything else within the hour.
        var count: Int = 1
    }

    @Published private(set) var entries: [Entry] = []
    private var seq = 0

    func add(_ source: String, _ level: Level, _ text: String, ms: Int? = nil, detail: String? = nil) {
        if var last = entries.last, last.source == source, last.level == level, last.text == text, last.detail == detail {
            last.count += 1
            last.at = Date()
            entries[entries.count - 1] = last
            return
        }
        seq += 1
        entries.append(Entry(id: seq, at: Date(), source: source, level: level, text: text, ms: ms, detail: detail))
        if entries.count > 500 { entries.removeFirst(entries.count - 500) }
    }

    func clear() { entries.removeAll() }

    /// For code off the main actor.
    nonisolated static func log(_ source: String, _ level: Level, _ text: String, ms: Int? = nil, detail: String? = nil) {
        Task { @MainActor in shared.add(source, level, text, ms: ms, detail: detail) }
    }
}
