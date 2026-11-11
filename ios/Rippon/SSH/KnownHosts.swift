import Foundation
import NIOCore
import NIOSSH

/// Trust on first use, as `ssh` does with `known_hosts`: the first key a host
/// presents is remembered, and a different one later is refused.
enum KnownHosts {
    private static let defaultsKey = "rippon.knownHosts"

    static func key(for host: HostEntry) -> String {
        "[\(host.hostname.lowercased())]:\(host.port)"
    }

    static var all: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }

    static func forget(_ host: HostEntry) {
        var a = all
        a.removeValue(forKey: key(for: host))
        all = a
    }
}

struct HostKeyChanged: LocalizedError {
    let host: String
    let expected: String
    let presented: String
    var errorDescription: String? {
        """
        The host key for \(host) has changed. Someone could be intercepting the connection — or the machine \
        was rebuilt. If you expected this, forget the saved key in the host's settings and connect again.

        saved:     \(expected)
        presented: \(presented)
        """
    }
}

final class TOFUValidator: NIOSSHClientServerAuthenticationDelegate {
    let host: HostEntry
    /// Called with the key line when a host is seen for the first time.
    let onFirstUse: (String) -> Void

    init(host: HostEntry, onFirstUse: @escaping (String) -> Void) {
        self.host = host
        self.onFirstUse = onFirstUse
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let presented = String(openSSHPublicKey: hostKey)
        let id = KnownHosts.key(for: host)
        var known = KnownHosts.all
        if let saved = known[id] {
            if saved == presented { validationCompletePromise.succeed(()) }
            else { validationCompletePromise.fail(HostKeyChanged(host: id, expected: saved, presented: presented)) }
            return
        }
        known[id] = presented
        KnownHosts.all = known
        onFirstUse(presented)
        validationCompletePromise.succeed(())
    }
}
