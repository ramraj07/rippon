import Foundation
import Crypto
import Citadel
import NIOSSH

/// SSH keys held by the app. The desktop app borrows your system `ssh`, agent and
/// all; an iPhone has none of that, so keys are generated here or imported, and
/// the private half lives in the Keychain.
struct SSHKeyInfo: Codable, Hashable, Identifiable {
    var id: String = UUID().uuidString
    var name: String
    var type: String
    /// `ssh-ed25519 AAAA… name`, ready for `authorized_keys`.
    var publicKey: String
}

enum KeyError: LocalizedError {
    case missing

    var errorDescription: String? {
        "The key for this host is no longer on this iPhone. Pick another in the host's settings."
    }
}

@MainActor
final class KeyStore: ObservableObject {
    @Published private(set) var keys: [SSHKeyInfo] = []

    private let defaultsKey = "rippon.keys"

    init() {
        if let data = UserDefaults.standard.data(forKey: defaultsKey),
           let list = try? JSONDecoder().decode([SSHKeyInfo].self, from: data) {
            keys = list
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(keys) { UserDefaults.standard.set(data, forKey: defaultsKey) }
    }

    /// A new ed25519 key. Its public line is what goes in the host's `authorized_keys`.
    @discardableResult
    func generate(name: String) -> SSHKeyInfo {
        let key = Curve25519.Signing.PrivateKey()
        let label = name.isEmpty ? "rippon-iphone" : name
        let info = SSHKeyInfo(name: label, type: "ed25519", publicKey: KeyStore.publicLine(for: key, comment: label))
        Keychain.set(Data(key.makeSSHRepresentation(comment: label).utf8), account: "key.\(info.id)")
        keys.append(info)
        persist()
        return info
    }

    /// Import a private key: OpenSSH format, or PEM (PKCS#1, SEC1, PKCS#8,
    /// encrypted or not) — so an AWS `.pem` works as it is.
    @discardableResult
    func importKey(name: String, text: String, passphrase: String) throws -> SSHKeyInfo {
        let pem = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsed = try PrivateKeyParser.parse(pem, passphrase: passphrase)
        let label = name.isEmpty ? "imported key" : name
        let info = SSHKeyInfo(name: label, type: parsed.typeName, publicKey: parsed.publicLine(comment: label))
        Keychain.set(Data(pem.utf8), account: "key.\(info.id)")
        if !passphrase.isEmpty { Keychain.set(Data(passphrase.utf8), account: "keypass.\(info.id)") }
        keys.append(info)
        persist()
        return info
    }

    func delete(_ id: String) {
        Keychain.delete(account: "key.\(id)")
        Keychain.delete(account: "keypass.\(id)")
        keys.removeAll { $0.id == id }
        persist()
    }

    func rename(_ id: String, to name: String) {
        guard let i = keys.firstIndex(where: { $0.id == id }) else { return }
        keys[i].name = name
        persist()
    }

    /// Build the authentication offer for a host. Read from the Keychain on every
    /// connect so nothing secret sits in memory longer than it has to.
    nonisolated static func authentication(for host: HostEntry) throws -> SSHAuthenticationMethod {
        let user = host.user.trimmingCharacters(in: .whitespaces)
        switch host.auth {
        case .password:
            return .passwordBased(username: user, password: Keychain.password(for: host.id) ?? "")
        case .key:
            guard let id = host.keyID,
                  let data = Keychain.get(account: "key.\(id)"),
                  let pem = String(data: data, encoding: .utf8) else { throw KeyError.missing }
            let pass = Keychain.get(account: "keypass.\(id)").map { String(decoding: $0, as: UTF8.self) } ?? ""
            return try PrivateKeyParser.parse(pem, passphrase: pass).authentication(username: user)
        }
    }

    nonisolated static func publicLine(for key: Curve25519.Signing.PrivateKey, comment: String) -> String {
        let pub = NIOSSHPrivateKey(ed25519Key: key).publicKey
        return String(openSSHPublicKey: pub) + " " + comment
    }
}
