import Foundation

/// Wire-protocol constants shared by the macOS server and the iOS client.
public enum MobileProtocol {
    /// Bonjour service type advertised by the Mac app (no trailing dot).
    /// `NSBonjourServices` uses this form; `NetServiceBrowser` appends a dot.
    public static let serviceType = "_llmide._tcp"

    /// Default TCP port the Mac app listens on.
    public static let defaultPort = 3006

    /// Heartbeat cadence (seconds).
    public static let heartbeatInterval: TimeInterval = 10

    /// Drop the connection if no heartbeat is received within this window.
    public static let heartbeatTimeout: TimeInterval = 25
}

// MARK: - Connection lifecycle messages

/// Client → server keepalive.
public struct Heartbeat: Codable, Equatable {
    public let type = "heartbeat"
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case type
    }
}

/// Server → client heartbeat acknowledgement.
public struct HeartbeatAck: Codable, Equatable {
    public let type = "heartbeat_ack"
    public let ts: Double
    public init(ts: Double) { self.ts = ts }

    private enum CodingKeys: String, CodingKey {
        case type
        case ts
    }
}

/// Server → client: pairing succeeded; carry the Mac's device name.
public struct Connected: Codable, Equatable {
    public let type = "connected"
    public let deviceName: String
    public init(deviceName: String) { self.deviceName = deviceName }

    private enum CodingKeys: String, CodingKey {
        case type
        case deviceName
    }
}

/// Server → client: PIN rejected; sent before closing the socket.
public struct AuthFailed: Codable, Equatable {
    public let type = "auth_failed"
    public let message: String
    public init(message: String) { self.message = message }

    private enum CodingKeys: String, CodingKey {
        case type
        case message
    }
}

/// Client → server: first message after connecting; carries the pairing PIN.
public struct Pairing: Codable, Equatable {
    public let type = "pairing"
    public let pin: String
    public init(pin: String) { self.pin = pin }

    private enum CodingKeys: String, CodingKey {
        case type
        case pin
    }
}
