import Foundation

/// A tmux session as the host reports it. The session list is a live view of
/// `tmux list-sessions`, exactly as the desktop's tab strip is.
struct SessionInfo: Identifiable, Hashable {
    let name: String
    let created: Date
    let attached: Bool
    let windows: Int
    var id: String { name }
}

/// The same tmux commands the desktop app runs, over the in-app connection.
enum Tmux {
    private static let listFormat = "#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}"

    /// What is typed into the PTY's shell to put a session on screen. `exec` so
    /// detaching ends the channel; the leading space keeps it out of history.
    static func attachLine(_ session: String) -> String {
        " exec tmux -u new-session -A -s \(session) \\; set -s set-clipboard on\r"
    }

    static func list(_ c: SSHConnection) async throws -> [SessionInfo] {
        let out: String
        do {
            out = try await c.run("tmux list-sessions -F '\(listFormat)'", source: "tmux", label: "list-sessions") { text in
                let n = text.split(separator: "\n").count
                return "\(n) session\(n == 1 ? "" : "s")"
            }
        } catch let e as RemoteError {
            // tmux exits non-zero before its server has started, and that really
            // is "no sessions yet". Nothing else is.
            let m = e.message.lowercased()
            if m.contains("no server running") || m.contains("no sessions exist") { return [] }
            if m.contains("error connecting to") && m.contains("no such file or directory") { return [] }
            throw e
        }
        return out.split(separator: "\n").compactMap { line -> SessionInfo? in
            let p = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard p.count >= 4, Names.isValid(p[0]) else { return nil }
            return SessionInfo(name: p[0], created: Date(timeIntervalSince1970: Double(p[1]) ?? 0),
                               attached: p[2] != "0", windows: Int(p[3]) ?? 1)
        }.sorted { ($0.created, $0.name) < ($1.created, $1.name) }
    }

    static func create(_ c: SSHConnection, name: String, command: String) async throws {
        precondition(Names.isValid(name))
        let cmd = command.trimmingCharacters(in: .whitespaces)
        try await c.run("tmux new-session -d -s \(name)\(cmd.isEmpty ? "" : " \(cmd)")", source: "tmux", label: "new-session \(name)")
    }

    static func kill(_ c: SSHConnection, name: String) async throws {
        precondition(Names.isValid(name))
        do {
            try await c.run("tmux kill-session -t \(name)", source: "tmux", label: "kill-session \(name)")
        } catch let e as RemoteError {
            // Already gone is the outcome we wanted anyway.
            let m = e.message.lowercased()
            if m.contains("can't find session") || m.contains("no server running") { return }
            throw e
        }
    }

    static func rename(_ c: SSHConnection, from: String, to: String) async throws {
        precondition(Names.isValid(from) && Names.isValid(to))
        try await c.run("tmux rename-session -t \(from) \(to)", source: "tmux", label: "rename-session \(from) → \(to)")
    }

    /// Server-wide, so it is every session at once; nil when no server is running.
    static func mouseMode(_ c: SSHConnection) async throws -> Bool? {
        do {
            let out = try await c.run("tmux show -gv mouse", source: "tmux", label: "show mouse")
            return out.trimmingCharacters(in: .whitespacesAndNewlines) == "on"
        } catch let e as RemoteError where e.message.lowercased().contains("no server running") {
            return nil
        }
    }

    static func setMouseMode(_ c: SSHConnection, on: Bool) async throws {
        try await c.run("tmux set -g mouse \(on ? "on" : "off")", source: "tmux", label: "mouse \(on ? "on" : "off")")
    }
}
