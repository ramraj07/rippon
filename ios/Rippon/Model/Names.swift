import Foundation

/// tmux forbids "." and ":" in session names, and anything needing shell quoting
/// would have to survive a trip through ssh — the same rule the desktop app uses.
/// Profile names share it because they become file names on the host.
enum Names {
    static func isValid(_ name: String) -> Bool {
        guard (1...64).contains(name.count) else { return false }
        return name.unicodeScalars.allSatisfy { s in
            (s >= "a" && s <= "z") || (s >= "A" && s <= "Z") || (s >= "0" && s <= "9") || s == "-" || s == "_"
        }
    }

    static func error(_ name: String) -> String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Name is required." }
        if !isValid(name) { return "Use letters, numbers, dashes and underscores only (max 64)." }
        return nil
    }

    /// Single-quote a string for a POSIX shell.
    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
