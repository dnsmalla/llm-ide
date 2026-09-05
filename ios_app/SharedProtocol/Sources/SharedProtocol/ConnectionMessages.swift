import Foundation

// MARK: - Connection lifecycle messages

/// Client → server: first message after connecting. Two forms share the tag:
///
///   - **PIN pairing** — `pin` set. A client that also sends `deviceId` (and
///     optionally `deviceName`) is asking the Mac to issue it a per-device
///     token in the `Connected` reply, after which the PIN is not needed again.
///   - **Token auth** — `token` + `deviceId` set, `pin` empty. The token was
///     issued by an earlier PIN pairing; no PIN travels on reconnect.
///
/// Every added field is optional on decode so the two sides can be upgraded
/// independently: an older Mac ignores them and validates `pin` as before, an
/// older phone never sends them and keeps its PIN-only behaviour.
public struct Pairing: Codable, Equatable {
    public let type = MobileProtocol.Tag.pairing
    public let pin: String
    public let token: String?
    public let deviceId: String?
    public let deviceName: String?
    public init(pin: String, token: String? = nil, deviceId: String? = nil, deviceName: String? = nil) {
        self.pin = pin
        self.token = token
        self.deviceId = deviceId
        self.deviceName = deviceName
    }
    private enum CodingKeys: String, CodingKey { case type, pin, token, deviceId, deviceName }
}

/// Client → server keepalive.
public struct Heartbeat: Codable, Equatable {
    public let type = MobileProtocol.Tag.heartbeat
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

/// Server → client heartbeat acknowledgement.
public struct HeartbeatAck: Codable, Equatable {
    public let type = MobileProtocol.Tag.heartbeatAck
    public let ts: Double
    public init(ts: Double) { self.ts = ts }
    private enum CodingKeys: String, CodingKey { case type, ts }
}

/// Server → client: pairing succeeded; carry the Mac's device name.
///
/// `token` (with `deviceId`) is present only when this connection paired with
/// a PIN and asked for a token: the phone stores it in its Keychain and sends
/// it in `Pairing.token` from then on. The PIN it just used is rotated on the
/// Mac and will not work again. Absent on token auth and for older phones.
public struct Connected: Codable, Equatable {
    public let type = MobileProtocol.Tag.connected
    public let deviceName: String
    public let token: String?
    public let deviceId: String?
    public init(deviceName: String, token: String? = nil, deviceId: String? = nil) {
        self.deviceName = deviceName
        self.token = token
        self.deviceId = deviceId
    }
    private enum CodingKeys: String, CodingKey { case type, deviceName, token, deviceId }
}

/// Server → client: the Mac is closing THIS connection on purpose, and why.
/// Sent to a paired client just before the socket is cancelled, so the phone
/// can tell "another device took over" or "this device was revoked in
/// Settings" from a network drop — and, for `revoked`, discard its token
/// instead of reconnecting into a refusal loop.
public struct Disconnected: Codable, Equatable {
    public enum Code: String, Codable, Equatable {
        /// Another phone paired with this Mac; only one connection is served.
        case replaced
        /// The user revoked this device in Settings → Mobile Control.
        case revoked
        /// Mobile Control was stopped on the Mac.
        case stopped
    }
    public let type = MobileProtocol.Tag.disconnected
    public let code: Code
    public let message: String
    public init(code: Code, message: String) {
        self.code = code
        self.message = message
    }
    private enum CodingKeys: String, CodingKey { case type, code, message }
}

/// Server → client: pairing refused; sent before closing the socket.
///
/// `retryable` separates "your PIN is wrong" from "you're going too fast".
/// The client DELETES its stored PIN on a rejection, which is right for a
/// genuinely wrong PIN and destructive for a throttle/lockout refusal — one
/// mistyped attempt followed by the CORRECT PIN inside the penalty window
/// would otherwise wipe a good PIN and force a re-pair. Optional on decode so
/// an older Mac (no field) keeps its current meaning: not retryable.
public struct AuthFailed: Codable, Equatable {
    public let type = MobileProtocol.Tag.authFailed
    public let message: String
    public let retryable: Bool?
    public init(message: String, retryable: Bool? = nil) {
        self.message = message
        self.retryable = retryable
    }
    private enum CodingKeys: String, CodingKey { case type, message, retryable }
}
