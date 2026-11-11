import Foundation
import Security
import CommonCrypto
import Crypto
import Citadel
import NIOCore
import NIOFoundationCompat
import NIOSSH
import BigInt

/// A private key Rippon can log in with, whatever file it came from.
enum ParsedKey {
    case ed25519(Curve25519.Signing.PrivateKey)
    case p256(P256.Signing.PrivateKey)
    case p384(P384.Signing.PrivateKey)
    case p521(P521.Signing.PrivateKey)
    case rsa(RSASHA2PrivateKey)

    var typeName: String {
        switch self {
        case .ed25519: return "ed25519"
        case .p256: return "ecdsa-p256"
        case .p384: return "ecdsa-p384"
        case .p521: return "ecdsa-p521"
        case .rsa(let k): return "rsa-\(k.bits)"
        }
    }

    var nioKey: NIOSSHPrivateKey {
        switch self {
        case .ed25519(let k): return NIOSSHPrivateKey(ed25519Key: k)
        case .p256(let k): return NIOSSHPrivateKey(p256Key: k)
        case .p384(let k): return NIOSSHPrivateKey(p384Key: k)
        case .p521(let k): return NIOSSHPrivateKey(p521Key: k)
        case .rsa(let k): return NIOSSHPrivateKey(custom: k)
        }
    }

    /// The line for the host's `authorized_keys`.
    func publicLine(comment: String) -> String {
        switch self {
        case .rsa(let k): return k.rsaPublic.openSSHLine + " " + comment
        default: return String(openSSHPublicKey: nioKey.publicKey) + " " + comment
        }
    }

    func authentication(username: String) -> SSHAuthenticationMethod {
        .custom(PrivateKeyAuthentication(username: username, key: nioKey))
    }
}

enum KeyParseError: LocalizedError {
    case notAKey
    case needsPassphrase
    case wrongPassphrase
    case unsupported(String)
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .notAKey:
            return "That isn't a private key Rippon recognises. It accepts OpenSSH keys (BEGIN OPENSSH PRIVATE KEY) and PEM keys (BEGIN RSA PRIVATE KEY, BEGIN EC PRIVATE KEY, BEGIN PRIVATE KEY, BEGIN ENCRYPTED PRIVATE KEY)."
        case .needsPassphrase: return "This key is encrypted. Enter its passphrase."
        case .wrongPassphrase: return "The passphrase is wrong, or the key is damaged."
        case .unsupported(let what): return what
        case .malformed(let what): return "The key file is damaged: \(what)."
        }
    }
}

/// Reads OpenSSH and PEM private keys.
///
/// Citadel reads only `openssh-key-v1`, and signs RSA with SHA-1 (`ssh-rsa`),
/// which OpenSSH 8.8+ refuses by default. So RSA keys of every format become a
/// `RSASHA2PrivateKey`, signing with `rsa-sha2-256` through the Security
/// framework, and PEM files are unwrapped here.
enum PrivateKeyParser {
    static func parse(_ text: String, passphrase: String) throws -> ParsedKey {
        let pem = try PEM(text)
        switch pem.label {
        case "OPENSSH PRIVATE KEY":
            return try openSSH(pem.body, raw: text, passphrase: passphrase)
        case "RSA PRIVATE KEY":
            return .rsa(try RSASHA2PrivateKey(pkcs1: try pem.decrypted(passphrase: passphrase)))
        case "EC PRIVATE KEY":
            return try ec(der: try pem.decrypted(passphrase: passphrase))
        case "PRIVATE KEY":
            return try pkcs8(pem.body)
        case "ENCRYPTED PRIVATE KEY":
            if passphrase.isEmpty { throw KeyParseError.needsPassphrase }
            return try pkcs8(try PKCS8.decrypt(pem.body, passphrase: passphrase))
        case "DSA PRIVATE KEY":
            throw KeyParseError.unsupported("DSA keys are not supported (OpenSSH itself dropped them). Use an ed25519 or RSA key.")
        default:
            throw KeyParseError.notAKey
        }
    }

    // MARK: PKCS#8

    private static let oidRSA: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01]
    private static let oidEC: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]
    private static let oidEd25519: [UInt8] = [0x2B, 0x65, 0x70]

    /// PrivateKeyInfo ::= SEQUENCE { version, AlgorithmIdentifier, OCTET STRING privateKey }
    static func pkcs8(_ der: Data) throws -> ParsedKey {
        var top = DER(der)
        var info = try top.sequence()
        _ = try info.integer()
        var alg = try info.sequence()
        let oid = try alg.oid()
        let key = try info.octetString()
        if oid == oidRSA { return .rsa(try RSASHA2PrivateKey(pkcs1: key)) }
        if oid == oidEC { return try ec(der: der) }
        if oid == oidEd25519 {
            var inner = DER(key)
            let seed = try inner.octetString()
            return .ed25519(try Curve25519.Signing.PrivateKey(rawRepresentation: seed))
        }
        throw KeyParseError.unsupported("That key's algorithm is not supported. Use an ed25519, ECDSA or RSA key.")
    }

    /// SEC1 or PKCS#8 EC keys; CryptoKit reads both. The curve is whichever accepts it.
    private static func ec(der: Data) throws -> ParsedKey {
        if let k = try? P256.Signing.PrivateKey(derRepresentation: der) { return .p256(k) }
        if let k = try? P384.Signing.PrivateKey(derRepresentation: der) { return .p384(k) }
        if let k = try? P521.Signing.PrivateKey(derRepresentation: der) { return .p521(k) }
        throw KeyParseError.unsupported("Only P-256, P-384 and P-521 EC keys are supported.")
    }

    // MARK: openssh-key-v1

    private static func openSSH(_ data: Data, raw: String, passphrase: String) throws -> ParsedKey {
        var b = ByteBuffer(data: data)
        guard b.readString(length: 15) == "openssh-key-v1\0" else { throw KeyParseError.malformed("bad openssh-key-v1 header") }
        let cipher = try b.sshString()
        _ = try b.sshString() // kdf name
        _ = try b.sshBytes()  // kdf options
        guard let count = b.readInteger(as: UInt32.self), count == 1 else {
            throw KeyParseError.unsupported("Files holding more than one key are not supported.")
        }
        var pub = ByteBuffer(bytes: try b.sshBytes())
        let pubType = try pub.sshString()

        if cipher != "none" {
            // Citadel can decrypt ed25519 keys (bcrypt + aes-ctr). Other types it
            // would hand back as SHA-1 RSA, so those are not taken encrypted.
            guard pubType == "ssh-ed25519" else {
                throw KeyParseError.unsupported("Passphrase-protected OpenSSH \(pubType) keys can't be imported yet. Remove the passphrase on a computer first (ssh-keygen -p -f <key>), import it, then delete the unprotected copy — or use an ed25519 key.")
            }
            if passphrase.isEmpty { throw KeyParseError.needsPassphrase }
            do {
                return .ed25519(try Curve25519.Signing.PrivateKey(sshEd25519: raw, decryptionKey: Data(passphrase.utf8)))
            } catch {
                throw KeyParseError.wrongPassphrase
            }
        }

        var priv = ByteBuffer(bytes: try b.sshBytes())
        guard let c1 = priv.readInteger(as: UInt32.self), let c2 = priv.readInteger(as: UInt32.self), c1 == c2 else {
            throw KeyParseError.malformed("check bytes do not match")
        }
        let type = try priv.sshString()
        switch type {
        case "ssh-ed25519":
            _ = try priv.sshBytes()
            let both = try priv.sshBytes()
            guard both.count == 64 else { throw KeyParseError.malformed("ed25519 key has the wrong length") }
            return .ed25519(try Curve25519.Signing.PrivateKey(rawRepresentation: both.prefix(32)))
        case "ssh-rsa":
            let n = try priv.sshBytes(), e = try priv.sshBytes(), d = try priv.sshBytes()
            let iqmp = try priv.sshBytes(), p = try priv.sshBytes(), q = try priv.sshBytes()
            return .rsa(try RSASHA2PrivateKey(n: n, e: e, d: d, p: p, q: q, iqmp: iqmp))
        case "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521":
            _ = try priv.sshString() // curve
            _ = try priv.sshBytes()  // public point
            let d = try priv.sshBytes()
            func scalar(_ size: Int) -> Data {
                let s = Data(d.drop { $0 == 0 })
                return Data(repeating: 0, count: max(0, size - s.count)) + s
            }
            switch type {
            case "ecdsa-sha2-nistp256": return .p256(try P256.Signing.PrivateKey(rawRepresentation: scalar(32)))
            case "ecdsa-sha2-nistp384": return .p384(try P384.Signing.PrivateKey(rawRepresentation: scalar(48)))
            default: return .p521(try P521.Signing.PrivateKey(rawRepresentation: scalar(66)))
            }
        default:
            throw KeyParseError.unsupported("\(type) keys are not supported. Use an ed25519, ECDSA or RSA key.")
        }
    }
}

// MARK: - RSA with SHA-256

/// The public half, sent under the algorithm name `rsa-sha2-256` (RFC 8332).
///
/// swift-nio-ssh writes a custom key's algorithm name and the type inside its
/// key blob from one prefix, so the blob also says `rsa-sha2-256` rather than
/// `ssh-rsa`. OpenSSH parses that name as an RSA key and matches it against
/// `authorized_keys` as usual — checked against OpenSSH 9.6, which also confirms
/// that plain `ssh-rsa` (SHA-1) is refused.
struct RSASHA2PublicKey: NIOSSHPublicKeyProtocol {
    static let publicKeyPrefix = "rsa-sha2-256"
    /// Unsigned big-endian, no leading zeros.
    let e: Data
    let n: Data

    var rawRepresentation: Data { e + n }

    func isValidSignature<D: DataProtocol>(_ signature: NIOSSHSignatureProtocol, for data: D) -> Bool {
        // Only ever used to log in, never to check a peer's signature.
        false
    }

    func write(to buffer: inout ByteBuffer) -> Int {
        buffer.writeMPInt(e) + buffer.writeMPInt(n)
    }

    static func read(from buffer: inout ByteBuffer) throws -> RSASHA2PublicKey {
        RSASHA2PublicKey(e: Data(try buffer.sshBytes().drop { $0 == 0 }), n: Data(try buffer.sshBytes().drop { $0 == 0 }))
    }

    /// `ssh-rsa AAAA…` — authorized_keys always names the key type `ssh-rsa`.
    var openSSHLine: String {
        var b = ByteBuffer()
        _ = b.writeSSHBytes(Data("ssh-rsa".utf8))
        _ = b.writeMPInt(e)
        _ = b.writeMPInt(n)
        return "ssh-rsa " + Data(b.readableBytesView).base64EncodedString()
    }
}

struct RSASHA2Signature: NIOSSHSignatureProtocol {
    static let signaturePrefix = "rsa-sha2-256"
    let rawRepresentation: Data

    func write(to buffer: inout ByteBuffer) -> Int {
        buffer.writeSSHBytes(rawRepresentation)
    }

    static func read(from buffer: inout ByteBuffer) throws -> RSASHA2Signature {
        RSASHA2Signature(rawRepresentation: try buffer.sshBytes())
    }
}

/// An RSA key held as a Security framework key, signing PKCS#1 v1.5 / SHA-256.
final class RSASHA2PrivateKey: NIOSSHPrivateKeyProtocol {
    static let keyPrefix = "rsa-sha2-256"
    let secKey: SecKey
    let rsaPublic: RSASHA2PublicKey
    var publicKey: NIOSSHPublicKeyProtocol { rsaPublic }
    var bits: Int { rsaPublic.n.count * 8 }

    /// From an RSAPrivateKey (PKCS#1) structure.
    init(pkcs1 der: Data) throws {
        var top = DER(der)
        var seq = try top.sequence()
        _ = try seq.integer() // version
        let n = try seq.integer()
        let e = try seq.integer()
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(der as CFData, attrs as CFDictionary, &error) else {
            let why = error.map { String(describing: $0.takeRetainedValue()) } ?? "unknown error"
            throw KeyParseError.malformed("the RSA key was not accepted (\(why))")
        }
        secKey = key
        rsaPublic = RSASHA2PublicKey(e: e, n: n)
        guard SecKeyIsAlgorithmSupported(key, .sign, .rsaSignatureMessagePKCS1v15SHA256) else {
            throw KeyParseError.malformed("the RSA key cannot sign")
        }
    }

    /// From OpenSSH's components; the CRT exponents PKCS#1 also wants are derived.
    convenience init(n: Data, e: Data, d: Data, p: Data, q: Data, iqmp: Data) throws {
        let D = BigUInt(d), P = BigUInt(p), Q = BigUInt(q)
        guard P > 1, Q > 1 else { throw KeyParseError.malformed("RSA primes are missing") }
        let dp = (D % (P - 1)).serialize()
        let dq = (D % (Q - 1)).serialize()
        let fields = [Data([0]), n, e, d, p, q, dp, dq, iqmp]
        try self.init(pkcs1: DER.encodeSequence(fields.map { DER.encodeInteger($0) }))
    }

    func signature<D: DataProtocol>(for data: D) throws -> NIOSSHSignatureProtocol {
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(secKey, .rsaSignatureMessagePKCS1v15SHA256, Data(data) as CFData, &error) as Data? else {
            throw error.map { $0.takeRetainedValue() as Error } ?? KeyParseError.malformed("RSA signing failed")
        }
        return RSASHA2Signature(rawRepresentation: sig)
    }
}

/// Offers one private key, once.
final class PrivateKeyAuthentication: NIOSSHClientUserAuthenticationDelegate {
    let username: String
    let key: NIOSSHPrivateKey
    private var offered = false

    init(username: String, key: NIOSSHPrivateKey) {
        self.username = username
        self.key = key
    }

    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods,
                                nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard !offered else {
            nextChallengePromise.fail(SSHClientError.allAuthenticationOptionsFailed)
            return
        }
        offered = true
        guard availableMethods.contains(.publicKey) else {
            nextChallengePromise.fail(SSHClientError.unsupportedPrivateKeyAuthentication)
            return
        }
        nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(
            username: username, serviceName: "", offer: .privateKey(.init(privateKey: key))))
    }
}

// MARK: - PEM

struct PEM {
    let label: String
    let headers: [String: String]
    let body: Data

    init(_ text: String) throws {
        let lines = text.replacingOccurrences(of: "\r", with: "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let start = lines.firstIndex(where: { $0.hasPrefix("-----BEGIN ") && $0.hasSuffix("-----") }) else {
            throw KeyParseError.notAKey
        }
        let label = String(lines[start].dropFirst("-----BEGIN ".count).dropLast(5))
        guard let end = lines[(start + 1)...].firstIndex(of: "-----END \(label)-----") else {
            throw KeyParseError.malformed("no END line")
        }
        var headers: [String: String] = [:]
        var base64 = ""
        for line in lines[(start + 1)..<end] {
            if base64.isEmpty, let colon = line.firstIndex(of: ":") {
                headers[String(line[..<colon])] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            } else {
                base64 += line
            }
        }
        guard let body = Data(base64Encoded: base64) else { throw KeyParseError.malformed("bad base64") }
        self.label = label
        self.headers = headers
        self.body = body
    }

    /// The body, undoing OpenSSL's legacy `Proc-Type: 4,ENCRYPTED` wrapping if present.
    func decrypted(passphrase: String) throws -> Data {
        guard headers["Proc-Type"]?.contains("ENCRYPTED") == true else { return body }
        guard let info = headers["DEK-Info"]?.split(separator: ","), info.count == 2,
              let iv = Data(hex: String(info[1])) else { throw KeyParseError.malformed("bad DEK-Info") }
        if passphrase.isEmpty { throw KeyParseError.needsPassphrase }
        let cipher = info[0].uppercased()
        let chosen: (CCAlgorithm, Int)
        switch cipher {
        case "AES-128-CBC": chosen = (CCAlgorithm(kCCAlgorithmAES), 16)
        case "AES-192-CBC": chosen = (CCAlgorithm(kCCAlgorithmAES), 24)
        case "AES-256-CBC": chosen = (CCAlgorithm(kCCAlgorithmAES), 32)
        case "DES-EDE3-CBC": chosen = (CCAlgorithm(kCCAlgorithm3DES), 24)
        default: throw KeyParseError.unsupported("Keys encrypted with \(cipher) are not supported.")
        }
        let (algorithm, keyLength) = chosen
        // EVP_BytesToKey with MD5 and one iteration; the salt is the IV's first 8 bytes.
        let salt = iv.prefix(8)
        var key = Data(), block = Data()
        while key.count < keyLength {
            block = Data(Insecure.MD5.hash(data: block + Data(passphrase.utf8) + salt))
            key += block
        }
        let plain = try Cipher.cbcDecrypt(body, key: key.prefix(keyLength), iv: iv, algorithm: algorithm)
        // A wrong passphrase usually fails the padding; if not, it fails here.
        var check = DER(plain)
        guard (try? check.sequence()) != nil else { throw KeyParseError.wrongPassphrase }
        return plain
    }
}

/// PKCS#8 EncryptedPrivateKeyInfo with PBES2 (PBKDF2 + AES-CBC or 3DES) — what
/// `openssl pkcs8 -topk8` and `openssl genpkey -aes256` write.
enum PKCS8 {
    private static let oidPBES2: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x05, 0x0D]
    private static let oidPBKDF2: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x05, 0x0C]
    private static let oidHmacSHA1: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x02, 0x07]
    private static let oidHmacSHA256: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x02, 0x09]
    private static let oidHmacSHA512: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x02, 0x0B]
    private static let aes: [[UInt8]: Int] = [
        [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x02]: 16,
        [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x16]: 24,
        [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2A]: 32
    ]
    private static let oidDESEDE3: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x03, 0x07]

    static func decrypt(_ der: Data, passphrase: String) throws -> Data {
        var top = DER(der)
        var info = try top.sequence()
        var alg = try info.sequence()
        guard try alg.oid() == oidPBES2 else {
            throw KeyParseError.unsupported("Only PBES2-encrypted PKCS#8 keys are supported. Re-export with `openssl pkcs8 -topk8 -v2 aes256`.")
        }
        var params = try alg.sequence()
        var kdf = try params.sequence()
        guard try kdf.oid() == oidPBKDF2 else { throw KeyParseError.unsupported("Only PBKDF2 key derivation is supported.") }
        var kdfParams = try kdf.sequence()
        let salt = try kdfParams.octetString()
        let iterations = Int(BigUInt(try kdfParams.integer()))
        var prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1)
        var explicitLength: Int?
        while !kdfParams.isAtEnd {
            if kdfParams.peekTag == 0x02 {
                explicitLength = Int(BigUInt(try kdfParams.integer()))
            } else {
                var p = try kdfParams.sequence()
                let oid = try p.oid()
                if oid == oidHmacSHA256 { prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256) }
                else if oid == oidHmacSHA512 { prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512) }
                else if oid != oidHmacSHA1 { throw KeyParseError.unsupported("That key's PBKDF2 hash is not supported.") }
            }
        }
        var enc = try params.sequence()
        let encOID = try enc.oid()
        let iv = try enc.octetString()
        let chosen: (CCAlgorithm, Int)
        if let n = aes[encOID] { chosen = (CCAlgorithm(kCCAlgorithmAES), n) }
        else if encOID == oidDESEDE3 { chosen = (CCAlgorithm(kCCAlgorithm3DES), 24) }
        else { throw KeyParseError.unsupported("That key's cipher is not supported. Re-export with `openssl pkcs8 -topk8 -v2 aes256`.") }
        let (algorithm, keyLength) = chosen
        let encrypted = try info.octetString()

        let length = explicitLength ?? keyLength
        var key = Data(count: length)
        let pass = Array(passphrase.utf8)
        let status = key.withUnsafeMutableBytes { k in
            salt.withUnsafeBytes { s in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pass.map { Int8(bitPattern: $0) }, pass.count,
                                     s.bindMemory(to: UInt8.self).baseAddress, salt.count, prf, UInt32(iterations),
                                     k.bindMemory(to: UInt8.self).baseAddress, length)
            }
        }
        guard Int(status) == kCCSuccess else { throw KeyParseError.malformed("key derivation failed") }
        let plain = try Cipher.cbcDecrypt(encrypted, key: key, iv: iv, algorithm: algorithm)
        var check = DER(plain)
        guard (try? check.sequence()) != nil else { throw KeyParseError.wrongPassphrase }
        return plain
    }
}

enum Cipher {
    static func cbcDecrypt(_ data: Data, key: Data, iv: Data, algorithm: CCAlgorithm) throws -> Data {
        var out = Data(count: data.count + 32)
        var moved = 0
        let outCount = out.count
        let status = out.withUnsafeMutableBytes { o in
            data.withUnsafeBytes { d in
                key.withUnsafeBytes { k in
                    iv.withUnsafeBytes { i in
                        CCCrypt(CCOperation(kCCDecrypt), algorithm, CCOptions(kCCOptionPKCS7Padding),
                                k.baseAddress, key.count, i.baseAddress,
                                d.baseAddress, data.count, o.baseAddress, outCount, &moved)
                    }
                }
            }
        }
        guard Int(status) == kCCSuccess else { throw KeyParseError.wrongPassphrase }
        return out.prefix(moved)
    }
}

// MARK: - Minimal DER

struct DER {
    private let bytes: [UInt8]
    private var index: Int
    private let end: Int

    init(_ data: Data) {
        bytes = Array(data)
        index = 0
        end = bytes.count
    }

    private init(bytes: [UInt8], start: Int, end: Int) {
        self.bytes = bytes
        index = start
        self.end = end
    }

    var isAtEnd: Bool { index >= end }
    var peekTag: UInt8? { index < end ? bytes[index] : nil }

    private mutating func element(_ tag: UInt8) throws -> Range<Int> {
        guard index + 2 <= end, bytes[index] == tag else { throw KeyParseError.malformed("unexpected DER structure") }
        index += 1
        var length = Int(bytes[index]); index += 1
        if length & 0x80 != 0 {
            let n = length & 0x7F
            guard n >= 1, n <= 4, index + n <= end else { throw KeyParseError.malformed("bad DER length") }
            length = 0
            for _ in 0..<n { length = (length << 8) | Int(bytes[index]); index += 1 }
        }
        guard index + length <= end else { throw KeyParseError.malformed("truncated DER") }
        defer { index += length }
        return index..<(index + length)
    }

    mutating func sequence() throws -> DER {
        let r = try element(0x30)
        return DER(bytes: bytes, start: r.lowerBound, end: r.upperBound)
    }

    /// Unsigned big-endian, leading zeros stripped.
    mutating func integer() throws -> Data {
        let r = try element(0x02)
        return Data(bytes[r].drop { $0 == 0 })
    }

    mutating func octetString() throws -> Data { Data(bytes[try element(0x04)]) }
    mutating func oid() throws -> [UInt8] { Array(bytes[try element(0x06)]) }

    // Building

    private static func header(_ tag: UInt8, _ count: Int) -> Data {
        if count < 0x80 { return Data([tag, UInt8(count)]) }
        var len = withUnsafeBytes(of: UInt32(count).bigEndian, Array.init)
        while len.first == 0 { len.removeFirst() }
        return Data([tag, 0x80 | UInt8(len.count)] + len)
    }

    static func encodeInteger(_ unsigned: Data) -> Data {
        var v = Data(unsigned.drop { $0 == 0 })
        if v.isEmpty || v.first! & 0x80 != 0 { v.insert(0, at: 0) }
        return header(0x02, v.count) + v
    }

    static func encodeSequence(_ parts: [Data]) -> Data {
        let body = parts.reduce(Data(), +)
        return header(0x30, body.count) + body
    }
}

// MARK: - SSH wire helpers

extension ByteBuffer {
    mutating func sshBytes() throws -> Data {
        guard let n = readInteger(as: UInt32.self), let d = readData(length: Int(n)) else {
            throw KeyParseError.malformed("truncated key data")
        }
        return d
    }

    mutating func sshString() throws -> String {
        String(decoding: try sshBytes(), as: UTF8.self)
    }

    @discardableResult
    mutating func writeSSHBytes(_ data: Data) -> Int {
        writeInteger(UInt32(data.count)) + writeBytes(data)
    }

    /// An SSH mpint of a non-negative number given unsigned big-endian.
    @discardableResult
    mutating func writeMPInt(_ unsigned: Data) -> Int {
        var v = Data(unsigned.drop { $0 == 0 })
        if let first = v.first, first & 0x80 != 0 { v.insert(0, at: 0) }
        return writeSSHBytes(v)
    }
}

extension Data {
    init?(hex: String) {
        var out = Data()
        var chars = hex.makeIterator()
        while let a = chars.next() {
            guard let b = chars.next(), let byte = UInt8(String([a, b]), radix: 16) else { return nil }
            out.append(byte)
        }
        self = out
    }
}
