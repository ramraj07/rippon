import Foundation

/// One local port forward: `localhost:<localPort>` on the phone reaches
/// `<remoteHost>:<remotePort>` as seen from the host — `ssh -L`, held open inside
/// the app so the in-app browser can load a dev server running on the box.
struct Tunnel: Codable, Hashable, Identifiable {
    var localPort: Int
    var remoteHost: String = "localhost"
    var remotePort: Int
    var id: Int { localPort }

    var label: String { "localhost:\(localPort) → \(remoteHost.isEmpty ? "localhost" : remoteHost):\(remotePort)" }

    static func error(local: Int?, remoteHost: String, remote: Int?) -> String? {
        guard let local, (1...65535).contains(local) else { return "Local port must be 1–65535." }
        guard let remote, (1...65535).contains(remote) else { return "Remote port must be 1–65535." }
        let ok = remoteHost.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || ".-_".unicodeScalars.contains($0) }
        if !ok { return "Remote host: letters, numbers, dot, dash and underscore only." }
        return nil
    }
}

enum AuthKind: String, Codable, CaseIterable {
    case key
    case password
}

/// A machine to drive. The phone has no `~/.ssh/config`, so what the desktop
/// keeps as one `user@host` destination plus flags is spelled out here.
struct HostEntry: Codable, Hashable, Identifiable {
    var id: String = UUID().uuidString
    var name: String = ""
    var hostname: String = ""
    var port: Int = 22
    var user: String = ""
    var auth: AuthKind = .key
    /// Which stored key to offer, when `auth` is `.key`.
    var keyID: String?
    /// Optional command tmux runs when a new session is created, e.g. `claude`.
    var newSessionCommand: String = ""
    var tunnels: [Tunnel] = []
    /// Profiles live on the host, so each host carries its own choice.
    var activeProfile: String = "default"

    var label: String {
        let n = name.trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? destination : n
    }

    var destination: String {
        let h = hostname.trimmingCharacters(in: .whitespaces)
        if h.isEmpty { return "unnamed host" }
        let u = user.trimmingCharacters(in: .whitespaces)
        return (u.isEmpty ? "" : "\(u)@") + h + (port == 22 ? "" : ":\(port)")
    }

    var isConfigured: Bool {
        !hostname.trimmingCharacters(in: .whitespaces).isEmpty && !user.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

/// The phone's equivalent of `~/.rippon/config.json`: just enough to connect,
/// plus which profile each host loads. Secrets are never in here — they are in
/// the Keychain.
@MainActor
final class HostStore: ObservableObject {
    @Published var hosts: [HostEntry] { didSet { save() } }
    @Published var activeHostID: String? { didSet { save() } }
    @Published var fontSize: Double { didSet { save() } }

    private struct File: Codable {
        var hosts: [HostEntry]
        var activeHostID: String?
        var fontSize: Double?
    }

    private static var url: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("hosts.json")
    }

    private var loading = true

    init() {
        let file = (try? Data(contentsOf: HostStore.url)).flatMap { try? JSONDecoder().decode(File.self, from: $0) }
        hosts = file?.hosts ?? []
        activeHostID = file?.activeHostID
        fontSize = file?.fontSize ?? 12
        loading = false
    }

    var activeHost: HostEntry? {
        hosts.first { $0.id == activeHostID } ?? hosts.first
    }

    func upsert(_ host: HostEntry) {
        if let i = hosts.firstIndex(where: { $0.id == host.id }) { hosts[i] = host } else { hosts.append(host) }
        if activeHostID == nil { activeHostID = host.id }
    }

    func remove(_ id: String) {
        hosts.removeAll { $0.id == id }
        Keychain.delete(account: "password.\(id)")
        if activeHostID == id { activeHostID = hosts.first?.id }
    }

    func setActiveProfile(_ name: String, for hostID: String) {
        guard let i = hosts.firstIndex(where: { $0.id == hostID }) else { return }
        hosts[i].activeProfile = name
    }

    private func save() {
        guard !loading else { return }
        let file = File(hosts: hosts, activeHostID: activeHostID, fontSize: fontSize)
        if let data = try? JSONEncoder().encode(file) {
            try? data.write(to: HostStore.url, options: [.atomic, .completeFileProtection])
        }
    }
}
