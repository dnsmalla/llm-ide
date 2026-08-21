import Foundation

// MARK: - Connection lifecycle messages

/// Client → server: first message after connecting; carries the pairing PIN.
public struct Pairing: Codable, Equatable {
    public let type = MobileProtocol.Tag.pairing
    public let pin: String
    public init(pin: String) { self.pin = pin }
    private enum CodingKeys: String, CodingKey { case type, pin }
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
public struct Connected: Codable, Equatable {
    public let type = MobileProtocol.Tag.connected
    public let deviceName: String
    public init(deviceName: String) { self.deviceName = deviceName }
    private enum CodingKeys: String, CodingKey { case type, deviceName }
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
