import Foundation

// MARK: - Connection lifecycle messages

/// Client → server: first message after connecting; carries the pairing PIN.
public struct Pairing: Codable, Equatable {
    public let type = MobileProtocol.Tag.pairing
    public let pin: String
    public init(pin: String) { self.pin = pin }
}

/// Client → server keepalive.
public struct Heartbeat: Codable, Equatable {
    public let type = MobileProtocol.Tag.heartbeat
    public init() {}
}

/// Server → client heartbeat acknowledgement.
public struct HeartbeatAck: Codable, Equatable {
    public let type = MobileProtocol.Tag.heartbeatAck
    public let ts: Double
    public init(ts: Double) { self.ts = ts }
}

/// Server → client: pairing succeeded; carry the Mac's device name.
public struct Connected: Codable, Equatable {
    public let type = MobileProtocol.Tag.connected
    public let deviceName: String
    public init(deviceName: String) { self.deviceName = deviceName }
}

/// Server → client: PIN rejected; sent before closing the socket.
public struct AuthFailed: Codable, Equatable {
    public let type = MobileProtocol.Tag.authFailed
    public let message: String
    public init(message: String) { self.message = message }
}
