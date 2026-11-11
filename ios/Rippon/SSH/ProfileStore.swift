import Foundation

/// Profiles on the host, under `~/.rippon/profiles/<name>.json` — the very files
/// the desktop app reads, so the phone and the Mac share one workspace.
///
/// Writes are atomic (temp file, then rename). The desktop pipes the JSON over
/// stdin; Citadel's exec has no stdin, so it travels base64-encoded inside the
/// command instead — base64 has no characters a single-quoted string cares about.
enum ProfileStore {
    private static let dir = "~/.rippon/profiles"
    private static let missing = "__rippon_no_profile__"

    private static func path(_ name: String) -> String {
        precondition(Names.isValid(name))
        return "\(dir)/\(name).json"
    }

    static func list(_ c: SSHConnection) async throws -> [String] {
        let out = try await c.run("ls -1 \(dir) 2>/dev/null || true", source: "profile", label: "list profiles")
        return out.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasSuffix(".json") }
            .map { String($0.dropLast(5)) }
            .filter(Names.isValid)
            .sorted()
    }

    /// nil when the host has no file for it yet — reported by a sentinel rather
    /// than a failure, so an unreadable file is never mistaken for a missing one
    /// (and seeded over).
    static func read(_ c: SSHConnection, name: String) async throws -> Profile? {
        let file = path(name)
        let out = try await c.run("if [ -e \(file) ]; then cat \(file); else echo \(missing); fi",
                                  source: "profile", label: "read \(name).json")
        let trimmed = out.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == missing || trimmed.isEmpty { return nil }
        do {
            return Profile(json: try JSON.parse(Data(out.utf8)))
        } catch {
            throw RemoteError(label: "read", message: "Profile \"\(name)\" on the host is not valid JSON.")
        }
    }

    static func write(_ c: SSHConnection, name: String, profile: Profile, createOnly: Bool = false) async throws {
        let file = path(name)
        let b64 = try profile.json.serialized().base64EncodedString()
        let tmp = "\(dir)/.\(name).ios\(Int.random(in: 1000...999999)).tmp"
        let guardClause = createOnly
            ? "if [ -e \(file) ]; then echo 'profile already exists' >&2; exit 1; fi && "
            : ""
        try await c.run(
            "mkdir -p \(dir) && \(guardClause)printf '%s' '\(b64)' | base64 -d > \(tmp) && mv \(tmp) \(file)",
            source: "profile", label: "\(createOnly ? "create" : "write") \(name).json")
    }

    static func rename(_ c: SSHConnection, from: String, to: String) async throws {
        guard from != to else { return }
        try await c.run("if [ -e \(path(to)) ]; then echo 'profile already exists' >&2; exit 1; fi; mv \(path(from)) \(path(to))",
                        source: "profile", label: "rename \(from).json → \(to).json")
    }

    static func delete(_ c: SSHConnection, name: String) async throws {
        try await c.run("rm -f \(path(name))", source: "profile", label: "delete \(name).json")
    }
}
