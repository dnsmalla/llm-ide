import Foundation
import CryptoKit

/// The device's two P-256 key pairs (device contract item 2). The private halves never leave the implementation.
public protocol SyncDeviceKeys: AnyObject {
    var signingSpki: Data { get }
    var ecdhSpki: Data { get }
    /// ECDSA P-256 over SHA-256(message), 64-byte P1363 (r || s), as Node `sign(..., { dsaEncoding: 'ieee-p1363' })`.
    func sign(_ message: Data) throws -> Data
    /// ECDH with a peer P-256 SPKI: the 32-byte x-coordinate, as Node `diffieHellman`.
    func sharedSecret(withSpki spki: Data) throws -> Data
}

public final class SoftwareSyncDeviceKeys: SyncDeviceKeys {
    public let signing: P256.Signing.PrivateKey
    public let ecdh: P256.KeyAgreement.PrivateKey
    public init(signing: P256.Signing.PrivateKey = .init(), ecdh: P256.KeyAgreement.PrivateKey = .init()) {
        self.signing = signing
        self.ecdh = ecdh
    }
    /// PKCS#8 DER, the vectors' `*Pkcs8`.
    public convenience init(signingPkcs8: Data, ecdhPkcs8: Data) throws {
        self.init(signing: try .init(derRepresentation: signingPkcs8), ecdh: try .init(derRepresentation: ecdhPkcs8))
    }
    public var signingSpki: Data { signing.publicKey.derRepresentation }
    public var ecdhSpki: Data { ecdh.publicKey.derRepresentation }
    public func sign(_ message: Data) throws -> Data { try signing.signature(for: message).rawRepresentation }
    public func sharedSecret(withSpki spki: Data) throws -> Data {
        try ecdh.sharedSecretFromKeyAgreement(with: SyncSpki.ecdhKey(spki)).withUnsafeBytes { Data($0) }
    }
}

public final class SecureEnclaveSyncDeviceKeys: SyncDeviceKeys {
    public static var isAvailable: Bool { SecureEnclave.isAvailable }
    let signing: SecureEnclave.P256.Signing.PrivateKey
    let ecdh: SecureEnclave.P256.KeyAgreement.PrivateKey
    public init() throws {
        signing = try .init()
        ecdh = try .init()
    }
    /// The opaque blobs from `dataRepresentation`: usable only inside this device's Secure Enclave.
    public init(signingBlob: Data, ecdhBlob: Data) throws {
        signing = try .init(dataRepresentation: signingBlob)
        ecdh = try .init(dataRepresentation: ecdhBlob)
    }
    public var signingBlob: Data { signing.dataRepresentation }
    public var ecdhBlob: Data { ecdh.dataRepresentation }
    public var signingSpki: Data { signing.publicKey.derRepresentation }
    public var ecdhSpki: Data { ecdh.publicKey.derRepresentation }
    public func sign(_ message: Data) throws -> Data { try signing.signature(for: message).rawRepresentation }
    public func sharedSecret(withSpki spki: Data) throws -> Data {
        try ecdh.sharedSecretFromKeyAgreement(with: SyncSpki.ecdhKey(spki)).withUnsafeBytes { Data($0) }
    }
}

public enum SyncSpki {
    /// A P-256 signing SPKI whose DER is canonical (re-export gives the same bytes), so ids and hashes cannot be malleated.
    public static func signingKey(_ der: Data) throws -> P256.Signing.PublicKey {
        guard let k = try? P256.Signing.PublicKey(derRepresentation: der), k.derRepresentation == der else { throw SyncCryptoError("bad_key") }
        return k
    }
    public static func ecdhKey(_ der: Data) throws -> P256.KeyAgreement.PublicKey {
        guard let k = try? P256.KeyAgreement.PublicKey(derRepresentation: der), k.derRepresentation == der else { throw SyncCryptoError("bad_key") }
        return k
    }
}
