import Foundation

struct Bookmark: Identifiable, Hashable {
    var title: String
    var url: String
    var id: String { url }

    init(title: String, url: String) {
        self.url = url
        self.title = title.isEmpty ? Bookmark.label(for: url) : title
    }

    init?(json: JSON) {
        guard let url = json["url"]?.string, url.lowercased().hasPrefix("http") else { return nil }
        self.init(title: json["title"]?.string ?? "", url: url)
    }

    var json: JSON { .object(["title": .string(title), "url": .string(url)]) }

    /// Something short and recognisable when a page gives us no usable title.
    static func label(for url: String) -> String {
        guard let u = URL(string: url), let host = u.host else { return url }
        let h = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        let tail = u.pathComponents.filter { $0 != "/" }.last
        return tail.map { "\(h)/\($0)" } ?? h
    }

    static func list(_ json: JSON?) -> [Bookmark] {
        var seen = Set<String>()
        return (json?.array ?? []).compactMap(Bookmark.init(json:)).filter { seen.insert($0.url).inserted }
    }
}
