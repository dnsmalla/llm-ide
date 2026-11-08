import Foundation
import CryptoKit
import Security

/// Host API v1 certificate pinning (spec "Security": "The host certificate fingerprint is carried in the
/// pairing QR and pinned by the client"). Format, shared with both hosts (`HostApiV1Identity.fingerprint`,
/// `host-identity.mjs fingerprintOfSpki`, vector `schema/host-api/v1/fixtures/security/identity-vector.json`):
/// `sha256:` + base64url, no padding, of SHA-256 over the leaf certificate's SubjectPublicKeyInfo DER.
public enum HostApiPinning {
    /// Client-local refusal codes; never on the wire. Both are non-retryable and leave credentials alone.
    public static let mismatch = HostApiRejection(
        replyTo: nil, code: "pin_mismatch", message: "This computer's security identity changed — pair again.")
    public static let missingPin = HostApiRejection(
        replyTo: nil, code: "pin_missing", message: "This computer's security identity is unknown — pair again.")

    /// DER prefix of a P-256 SPKI: SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING (0 unused) }.
    /// Both hosts mint P-256 keys only.
    private static let p256SpkiHeader = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
                                              0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03,
                                              0x42, 0x00])

    public static func fingerprint(spkiDER: Data) -> String {
        "sha256:" + Data(SHA256.hash(data: spkiDER)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The SPKI DER for an uncompressed X9.63 P-256 point (`04 || X || Y`, what `SecKeyCopyExternalRepresentation`
    /// returns for an EC public key); nil for anything else.
    public static func spkiDER(p256X963 point: Data) -> Data? {
        guard point.count == 65, point.first == 0x04 else { return nil }
        return p256SpkiHeader + point
    }

    /// The leaf's fingerprint, or nil when its key is not a P-256 EC key.
    public static func fingerprint(certificate: SecCertificate) -> String? {
        guard let key = SecCertificateCopyKey(certificate),
              let attrs = SecKeyCopyAttributes(key) as? [CFString: Any],
              attrs[kSecAttrKeyType] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
              let point = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              let spki = spkiDER(p256X963: point) else { return nil }
        return fingerprint(spkiDER: spki)
    }

    public static func isValidFingerprint(_ s: String) -> Bool {
        guard s.hasPrefix("sha256:") else { return false }
        let body = s.dropFirst(7)
        return body.count == 43 && body.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Constant-time over equal lengths; a missing or empty side never matches.
    public static func matches(_ fingerprint: String?, pin: String?) -> Bool {
        guard let fingerprint, let pin, !pin.isEmpty else { return false }
        let a = Array(fingerprint.utf8), b = Array(pin.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    /// The pin to keep after a pairing. Pinning is QR-only: the QR is the one channel the user sees come from
    /// the host, so only `.qrScan` sets or replaces the pin (a QR without `h1fp` drops it). A typed PIN keeps
    /// the stored pin for the same host. A pin is never carried to another host.
    public static func pinAfterOffer(stored: String?, offered: String?, source: HostApiPairingSource,
                                     sameHost: Bool) -> String? {
        switch source {
        case .qrScan: return offered.flatMap { isValidFingerprint($0) ? $0 : nil }
        case .typedPin: return sameHost ? stored : nil
        }
    }

    /// The trust evaluator for `endpoint`: nil for loopback `ws://`; for `wss://` a pinned evaluator, or
    /// `missingPin` thrown so no socket is ever opened unpinned.
    public static func trust(for endpoint: HostApiEndpoint, pin: String?) throws -> HostApiTrustEvaluating? {
        guard endpoint.isTLS else { return nil }
        guard let pin, isValidFingerprint(pin) else { throw missingPin }
        return HostApiPinnedTrust(pin: pin)
    }
}

/// How the user started a pairing (`HostApiPinning.pinAfterOffer`).
public enum HostApiPairingSource: Sendable, Equatable {
    /// Scanned the desktop's pairing QR.
    case qrScan
    /// Typed the PIN by hand.
    case typedPin
}

/// Accepts exactly the paired leaf key. System trust is never consulted: the host certificate is self-signed.
public struct HostApiPinnedTrust: HostApiTrustEvaluating {
    public let pin: String
    public init(pin: String) { self.pin = pin }

    public func evaluate(_ trust: SecTrust, host: String) -> Bool {
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { return false }
        return HostApiPinning.matches(HostApiPinning.fingerprint(certificate: leaf), pin: pin)
    }
}

/// The v1 listener a host advertises at pairing: `h1port` + `h1fp` in the QR.
public struct HostApiPairingOffer: Sendable, Equatable {
    public let port: Int
    public let fingerprint: String

    public init(port: Int, fingerprint: String) { self.port = port; self.fingerprint = fingerprint }

    public init?(port: String?, fingerprint: String?) {
        guard let p = port.flatMap(Int.init), (p == 443 || (1024...65_535).contains(p)),
              let fingerprint, HostApiPinning.isValidFingerprint(fingerprint) else { return nil }
        self.init(port: p, fingerprint: fingerprint)
    }

    public func endpoint(host: String) -> HostApiEndpoint? {
        HostApiEndpoint("wss://\(host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host):\(port)/host-api/v1")
    }
}
