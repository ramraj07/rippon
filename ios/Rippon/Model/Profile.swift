import Foundation

/// A host-side profile (`~/.rippon/profiles/<name>.json`), shared with the desktop app.
///
/// Held as raw JSON so everything the phone has no use for — tiled views, split
/// ratios, zoom, sidebar widths — is written back exactly as it was read. Every
/// accessor here touches only its own keys.
struct Profile: Equatable {
    static let version = 6
    static let defaultURL = "https://github.com/pulls"

    var json: JSON

    init(json: JSON) {
        self.json = json.object == nil ? Profile.fresh().json : json
    }

    /// The same starting point the desktop app seeds a new profile with.
    static func fresh() -> Profile {
        Profile(json: .object([
            "version": .number(Double(version)),
            "detachHidden": .bool(false),
            "views": .array([.object([
                "id": .string("view-main"),
                "name": .string("Main"),
                "type": .string("tabs-vertical"),
                "hidden": .array([]),
                "columns": .number(2),
                "tiles": .array([]),
                "sidebarWidth": .number(210),
                "zoom": .number(1)
            ])]),
            "activeViewId": .string("view-main"),
            "sessions": .object([:]),
            "bookmarks": .array([])
        ]))
    }

    // MARK: Bookmarks for every session

    var bookmarks: [Bookmark] {
        get { Bookmark.list(json["bookmarks"]) }
        set { json["bookmarks"] = .array(newValue.map(\.json)) }
    }

    // MARK: Per-session decoration

    func url(for session: String) -> String {
        json["sessions"]?[session]?["url"]?.string ?? Profile.defaultURL
    }

    func sessionBookmarks(_ session: String) -> [Bookmark] {
        Bookmark.list(json["sessions"]?[session]?["bookmarks"])
    }

    /// Edit one session's decoration, creating it with the desktop's defaults.
    private mutating func editSession(_ name: String, _ body: (inout JSON) -> Void) {
        var sessions = json["sessions"] ?? .object([:])
        var s = sessions[name] ?? .object([
            "url": .string(Profile.defaultURL),
            "splitRatio": .number(0.5),
            "showBrowser": .bool(false),
            "bookmarks": .array([])
        ])
        body(&s)
        sessions[name] = s
        json["sessions"] = sessions
    }

    mutating func setURL(_ url: String, for session: String) {
        editSession(session) { $0["url"] = .string(url) }
    }

    mutating func setSessionBookmarks(_ list: [Bookmark], for session: String) {
        editSession(session) { $0["bookmarks"] = .array(list.map(\.json)) }
    }

    mutating func ensureSession(_ name: String) {
        editSession(name) { _ in }
    }

    // MARK: Hidden sessions

    private var views: [JSON] {
        get { json["views"]?.array ?? [] }
        set { json["views"] = .array(newValue) }
    }

    /// The view whose hidden list the phone reads and edits: the active view when
    /// it is a tab view, otherwise the first tab view. Tiled views have no hidden
    /// list — they show what is in their tiles — so they are never used.
    private var phoneViewIndex: Int? {
        let active = json["activeViewId"]?.string
        let isTabs: (JSON) -> Bool = { ($0["type"]?.string ?? "tabs-vertical") != "tiled" }
        if let i = views.firstIndex(where: { $0["id"]?.string == active }), isTabs(views[i]) { return i }
        return views.firstIndex(where: isTabs)
    }

    var canHide: Bool { phoneViewIndex != nil }

    var hidden: [String] {
        guard let i = phoneViewIndex else { return [] }
        return (views[i]["hidden"]?.array ?? []).compactMap(\.string)
    }

    mutating func setHidden(_ name: String, _ hide: Bool) {
        guard let i = phoneViewIndex else { return }
        var list = hidden.filter { $0 != name }
        if hide { list.append(name) }
        var v = views
        v[i]["hidden"] = .array(list.map(JSON.string))
        if !hide { v[i]["activeSession"] = .string(name) }
        views = v
    }

    mutating func setActiveSession(_ name: String) {
        guard let i = phoneViewIndex else { return }
        var v = views
        v[i]["activeSession"] = .string(name)
        views = v
    }

    // MARK: Following tmux

    /// Mirror of the desktop's rename: the decoration, hidden lists, tiles and
    /// focus all follow the session to its new name.
    mutating func renameSession(from: String, to: String) {
        var sessions = json["sessions"]?.object ?? [:]
        if let moved = sessions.removeValue(forKey: from) { sessions[to] = moved }
        json["sessions"] = .object(sessions)
        if sessions[to] == nil { ensureSession(to) }
        views = views.map { view in
            var v = view
            v["hidden"] = .array((view["hidden"]?.array ?? []).map { $0.string == from ? .string(to) : $0 })
            v["tiles"] = .array((view["tiles"]?.array ?? []).map { $0.string == from ? .string(to) : $0 })
            if view["activeSession"]?.string == from { v["activeSession"] = .string(to) }
            return v
        }
    }

    /// Mirror of the desktop's kill: forget everything about the session.
    mutating func forgetSession(_ name: String) {
        var sessions = json["sessions"]?.object ?? [:]
        sessions.removeValue(forKey: name)
        json["sessions"] = .object(sessions)
        views = views.map { view in
            var v = view
            v["hidden"] = .array((view["hidden"]?.array ?? []).filter { $0.string != name })
            v["tiles"] = .array((view["tiles"]?.array ?? []).map { $0.string == name ? .null : $0 })
            if view["activeSession"]?.string == name { v["activeSession"] = nil }
            return v
        }
    }
}
