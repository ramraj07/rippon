import Foundation

struct RemoteEntry: Identifiable, Hashable {
    enum Kind { case dir, file, link, other }
    let name: String
    let kind: Kind
    /// Whether following it lands on a directory — a symlink to one opens like one.
    let isDir: Bool
    let size: Int
    let mtime: Date
    var id: String { name }
}

struct RemoteListing {
    let path: String
    let entries: [RemoteEntry]
    let truncated: Bool
}

struct RemotePreview {
    enum Kind { case text(String), image(Data), binary }
    let path: String
    let size: Int
    let truncated: Bool
    let kind: Kind
}

/// The host's file browser, using the same commands as the desktop's (GNU
/// `find -printf` and `stat -c`, so a Linux host).
enum RemoteFiles {
    private static let previewBytes = 256 * 1024
    private static let maxEntries = 5000
    private static let sep = "__rippon_sep__"

    /// `~` and `~/…` expand on the host; everything else is quoted as-is.
    static func expand(_ path: String) -> String {
        let p = path.trimmingCharacters(in: .whitespaces)
        if p.isEmpty || p == "~" { return "\"$HOME\"" }
        if p.hasPrefix("~/") { return "\"$HOME\"/" + Names.shellQuote(String(p.dropFirst(2))) }
        return Names.shellQuote(p)
    }

    static func list(_ c: SSHConnection, path: String) async throws -> RemoteListing {
        let target = path.trimmingCharacters(in: .whitespaces).isEmpty ? "~" : path
        let out = try await c.run(
            "cd \(expand(target)) && pwd -P && echo \(sep) && find . -mindepth 1 -maxdepth 1 -printf '%y%Y\\t%s\\t%T@\\t%f\\n'",
            source: "ssh", label: "list \(target)")
        let parts = out.components(separatedBy: sep)
        let resolved = parts.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? target
        var entries: [RemoteEntry] = []
        for line in (parts.count > 1 ? parts[1] : "").split(separator: "\n") {
            let f = line.split(separator: "\t", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
            guard f.count == 4, !f[3].isEmpty, f[3] != ".", f[3] != ".." else { continue }
            let types = Array(f[0])
            let me = types.first ?? "?"
            let target = types.count > 1 ? types[1] : me
            let kind: RemoteEntry.Kind = me == "l" ? .link : me == "d" ? .dir : me == "f" ? .file : .other
            entries.append(RemoteEntry(name: f[3], kind: kind, isDir: target == "d", size: Int(f[1]) ?? 0,
                                       mtime: Date(timeIntervalSince1970: Double(f[2]) ?? 0)))
        }
        entries.sort { a, b in
            if a.isDir != b.isDir { return a.isDir }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
        return RemoteListing(path: resolved, entries: Array(entries.prefix(maxEntries)), truncated: entries.count > maxEntries)
    }

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "ico"]

    static func preview(_ c: SSHConnection, path: String) async throws -> RemotePreview {
        let out = try await c.run(
            "stat -c '%s' \(expand(path)) && echo \(sep) && head -c \(previewBytes) \(expand(path)) | base64",
            source: "ssh", label: "preview \(path)")
        let parts = out.components(separatedBy: sep)
        let size = Int(parts.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        let b64 = (parts.count > 1 ? parts[1] : "").components(separatedBy: .whitespacesAndNewlines).joined()
        let bytes = Data(base64Encoded: b64) ?? Data()
        let truncated = size > bytes.count
        let ext = (path as NSString).pathExtension.lowercased()
        if imageExtensions.contains(ext), !truncated {
            return RemotePreview(path: path, size: size, truncated: false, kind: .image(bytes))
        }
        if bytes.prefix(8000).contains(0) {
            return RemotePreview(path: path, size: size, truncated: truncated, kind: .binary)
        }
        return RemotePreview(path: path, size: size, truncated: truncated, kind: .text(String(decoding: bytes, as: UTF8.self)))
    }

    /// Fetch a whole file into the app's temporary folder, for the share sheet.
    static func download(_ c: SSHConnection, path: String, progress: @escaping (Int) -> Void) async throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent((path as NSString).lastPathComponent)
        try? FileManager.default.removeItem(at: file)
        let started = Date()
        let bytes = try await c.download("cat -- \(expand(path))", to: file, progress: progress)
        ActivityLog.log("ssh", .ok, "download \(path)", ms: Int(Date().timeIntervalSince(started) * 1000), detail: "\(bytes) bytes")
        return file
    }
}
