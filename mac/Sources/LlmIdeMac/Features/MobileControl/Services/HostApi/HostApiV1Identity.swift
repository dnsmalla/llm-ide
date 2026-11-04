import Foundation
import CryptoKit
import Security

/// The Mac's Host API v1 TLS identity: created once, kept in the Keychain (ThisDeviceOnly, never synced),
/// never sent anywhere. Clients pin `fingerprint` (SHA-256 of the SPKI) from the QR. A keychain read failure
/// is an error, never a reason to mint a new identity (that would silently break every pin).
enum HostApiV1Identity {
    static let account = "mobile::hostapi-identity"
    private static let service = "com.llmide.macapp"   // same item service as MobilePin / KeychainStore
    static let validity: TimeInterval = 5 * 365 * 24 * 3600

    struct Loaded { let identity: SecIdentity; let certificateDER: Data; let fingerprint: String; let notAfter: Date; let created: Bool }
    enum Failure: Error, Equatable { case keychain(OSStatus), corrupt, securityFramework(String) }
    private struct Material: Codable { let key: Data; let cert: Data; let notAfter: Date }

    static func loadOrCreate(hostName: String, now: Date = Date(), backend: RawKeychainAccess = KeychainStore.backend) throws -> Loaded {
        switch backend.read(account: account, service: service) {
        case .failed(let status): throw Failure.keychain(status)
        case .found(let data):
            guard let m = try? JSONDecoder().decode(Material.self, from: data),
                  let key = try? P256.Signing.PrivateKey(rawRepresentation: m.key) else { throw Failure.corrupt }
            return try build(key: key, cert: m.cert, notAfter: m.notAfter, created: false)
        case .notFound:
            let key = P256.Signing.PrivateKey()
            var serial = Data((0..<16).map { _ in UInt8.random(in: 0...255) }); serial[0] = (serial[0] & 0x7F) | 0x01
            let notAfter = now.addingTimeInterval(validity)
            let cn = "LLM-IDE " + String(hostName.prefix(64))
            let cert = try HostApiV1Certificate.selfSigned(key: key, commonName: cn, notBefore: now.addingTimeInterval(-300), notAfter: notAfter, serial: serial)
            let blob = try JSONEncoder().encode(Material(key: key.rawRepresentation, cert: cert, notAfter: notAfter))
            guard backend.write(account: account, service: service, data: blob) else { throw Failure.keychain(errSecIO) }
            return try build(key: key, cert: cert, notAfter: notAfter, created: true)
        }
    }

    /// True only when the Keychain says the item is absent (a read failure is not "missing").
    static func isMissing(backend: RawKeychainAccess = KeychainStore.backend) -> Bool {
        if case .notFound = backend.read(account: account, service: service) { return true }
        return false
    }

    static func reset(backend: RawKeychainAccess = KeychainStore.backend) { backend.delete(account: account, service: service) }

    static func fingerprint(spkiDER: Data) -> String {
        "sha256:" + Data(SHA256.hash(data: spkiDER)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func fingerprint(certificate: SecCertificate) -> String? {
        guard let pub = SecCertificateCopyKey(certificate),
              let x963 = SecKeyCopyExternalRepresentation(pub, nil) as Data?,
              let key = try? P256.Signing.PublicKey(x963Representation: x963) else { return nil }
        return fingerprint(spkiDER: key.derRepresentation)
    }

    private static func build(key: P256.Signing.PrivateKey, cert der: Data, notAfter: Date, created: Bool) throws -> Loaded {
        guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { throw Failure.corrupt }
        // Checked before SecIdentityCreate, which also rejects a key/cert mismatch but as an opaque nil.
        guard let fp = fingerprint(certificate: cert), fp == fingerprint(spkiDER: key.publicKey.derRepresentation) else { throw Failure.corrupt }
        let attrs: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits: 256]
        var err: Unmanaged<CFError>?
        guard let secKey = SecKeyCreateWithData(key.x963Representation as CFData, attrs as CFDictionary, &err) else {
            throw Failure.securityFramework(String(describing: err?.takeRetainedValue()))
        }
        guard let create = secIdentityCreate else { throw Failure.securityFramework("SecIdentityCreate is unavailable") }
        guard let identity = create(nil, cert, secKey)?.takeRetainedValue() else {
            throw Failure.securityFramework("SecIdentityCreate returned nil")
        }
        return Loaded(identity: identity, certificateDER: der, fingerprint: fp, notAfter: notAfter, created: created)
    }

    // SecIdentityCreate has been in Security.framework since macOS 10.12 but is declared only by newer SDKs
    // (CI's Xcode 16.4 / macOS 15.5 SDK lacks it), so it is resolved at runtime with its C signature.
    // shortcut: runtime lookup, call it directly once every build uses an SDK that declares it.
    private typealias SecIdentityCreateFn = @convention(c) (CFAllocator?, SecCertificate, SecKey) -> Unmanaged<SecIdentity>?
    private static let secIdentityCreate: SecIdentityCreateFn? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "SecIdentityCreate") else { return nil }  // RTLD_DEFAULT
        return unsafeBitCast(sym, to: SecIdentityCreateFn.self)
    }()
}
