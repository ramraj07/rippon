import Foundation
import Citadel
import NIOCore
import NIOSSH

/// What a remote command produced. stderr is kept whole: it is the only place an
/// ssh or tmux failure ever explains itself.
struct CommandResult {
    var stdout: Data
    var stderr: String
    var exitCode: Int

    var text: String { String(decoding: stdout, as: UTF8.self) }
}

struct RemoteError: LocalizedError {
    let label: String
    let message: String
    var errorDescription: String? { message }
}

/// One SSH connection to a host. Everything — the session poll, profile reads
/// and writes, the file browser, every terminal and every port forward — is a
/// channel on this one connection, as the desktop app multiplexes everything
/// over one `ControlMaster`.
final class SSHConnection: @unchecked Sendable {
    let host: HostEntry
    let client: SSHClient

    private init(host: HostEntry, client: SSHClient) {
        self.host = host
        self.client = client
    }

    var isConnected: Bool { client.isConnected }

    static func open(_ host: HostEntry) async throws -> SSHConnection {
        let auth = try KeyStore.authentication(for: host)
        let validator = TOFUValidator(host: host) { line in
            ActivityLog.log("ssh", .warn, "first connection to \(host.destination) — remembered its host key", detail: line)
        }
        let started = Date()
        do {
            let client = try await SSHClient.connect(
                host: host.hostname.trimmingCharacters(in: .whitespaces),
                port: host.port,
                authenticationMethod: auth,
                hostKeyValidator: .custom(validator),
                reconnect: .never,
                connectTimeout: .seconds(10)
            )
            ActivityLog.log("ssh", .ok, "connected to \(host.destination)", ms: Int(Date().timeIntervalSince(started) * 1000))
            return SSHConnection(host: host, client: client)
        } catch {
            ActivityLog.log("ssh", .error, "connect to \(host.destination)", ms: Int(Date().timeIntervalSince(started) * 1000), detail: describe(error))
            throw RemoteError(label: "connect", message: describe(error))
        }
    }

    func close() {
        let client = self.client
        Task { try? await client.close() }
    }

    func onDisconnect(_ body: @escaping @Sendable () -> Void) {
        client.onDisconnect(perform: body)
    }

    /// Run a command and collect everything it printed. A non-zero exit is
    /// returned, not thrown — callers decide which failures are really failures.
    func exec(_ command: String, timeout: TimeInterval = 20) async throws -> CommandResult {
        try await withThrowingTaskGroup(of: CommandResult.self) { group in
            group.addTask { [client] in
                var out = Data()
                var err = Data()
                var code = 0
                do {
                    let stream = try await client.executeCommandStream(command)
                    for try await chunk in stream {
                        switch chunk {
                        case .stdout(let b): out.append(contentsOf: b.readableBytesView)
                        case .stderr(let b): err.append(contentsOf: b.readableBytesView)
                        }
                    }
                } catch let failed as SSHClient.CommandFailed {
                    code = failed.exitCode
                }
                return CommandResult(stdout: out, stderr: String(decoding: err, as: UTF8.self), exitCode: code)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw RemoteError(label: "timeout", message: "No response within \(Int(timeout))s.")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    /// `exec`, logged, with a non-zero exit turned into an error carrying stderr.
    @discardableResult
    func run(_ command: String, source: String = "ssh", label: String? = nil,
             summarise: ((String) -> String)? = nil) async throws -> String {
        let label = label ?? String(command.prefix(60))
        let started = Date()
        let ms = { Int(Date().timeIntervalSince(started) * 1000) }
        do {
            let r = try await exec(command)
            if r.exitCode != 0 {
                let body = r.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                let message = (body.isEmpty ? r.text.trimmingCharacters(in: .whitespacesAndNewlines) : body)
                    + "\n\nran: \(command)\n(exit \(r.exitCode))"
                ActivityLog.log(source, .error, label, ms: ms(), detail: message)
                throw RemoteError(label: label, message: message)
            }
            let summary = summarise?(r.text)
            ActivityLog.log(source, .ok, summary.map { "\(label) → \($0)" } ?? label, ms: ms())
            return r.text
        } catch let e as RemoteError {
            throw e
        } catch {
            let message = describe(error) + "\n\nran: \(command)"
            ActivityLog.log(source, .error, label, ms: ms(), detail: message)
            throw RemoteError(label: label, message: message)
        }
    }

    /// Stream a command's stdout into a file, for downloads.
    func download(_ command: String, to file: URL, progress: @escaping (Int) -> Void) async throws -> Int {
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        var bytes = 0
        var err = Data()
        do {
            let stream = try await client.executeCommandStream(command)
            for try await chunk in stream {
                switch chunk {
                case .stdout(let b):
                    let data = Data(b.readableBytesView)
                    try handle.write(contentsOf: data)
                    bytes += data.count
                    progress(bytes)
                case .stderr(let b):
                    err.append(contentsOf: b.readableBytesView)
                }
            }
        } catch let failed as SSHClient.CommandFailed {
            try? FileManager.default.removeItem(at: file)
            let text = String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw RemoteError(label: "download", message: text.isEmpty ? "exit \(failed.exitCode)" : text)
        }
        return bytes
    }
}

/// Turn whatever NIO or Citadel threw into words a person can act on.
func describe(_ error: Error) -> String {
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    let text = String(describing: error)
    if text.contains("allAuthenticationOptionsFailed") || text.contains("AuthenticationFailed") {
        return "The host refused the key or password (\(text)). Check the user name, and that the key's public half is in ~/.ssh/authorized_keys."
    }
    if text.contains("connectTimeout") || text.contains("ConnectTimeout") {
        return "Timed out connecting (\(text)). Is the host reachable from this network — VPN, Wi-Fi?"
    }
    if text.contains("connectionRefused") || text.contains("Connection refused") {
        return "Connection refused (\(text)). Is sshd running on that port?"
    }
    return text
}
