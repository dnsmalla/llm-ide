import Foundation
import SharedProtocol

/// One v1 connection's phase and command gate. Pure: the gateway owns I/O, auth checks and state changes.
struct HostApiV1Session {
    enum Phase: Equatable {
        case awaitingHello
        case awaitingAuth(clientName: String)
        case authed(deviceId: String, clientName: String)
    }

    enum Gate: Equatable { case allow, refuse(code: String, message: String) }

    private(set) var phase: Phase = .awaitingHello

    mutating func greeted(clientName: String) { phase = .awaitingAuth(clientName: clientName) }

    mutating func authenticated(deviceId: String) {
        switch phase {
        case .awaitingAuth(let name), .authed(_, let name): phase = .authed(deviceId: deviceId, clientName: name)
        case .awaitingHello: break
        }
    }

    var deviceId: String? { if case .authed(let id, _) = phase { return id }; return nil }

    func gate(_ command: HostApiCommand, served: Set<String>) -> Gate {
        switch phase {
        case .awaitingHello:
            return command == .hostHello ? .allow : .refuse(code: "auth_failed", message: "Send host.hello first.")
        case .awaitingAuth:
            switch command {
            case .hostAuthPair, .hostAuthToken, .hostPing: return .allow
            case .hostHello: return .refuse(code: "denied", message: "This connection already sent host.hello.")
            default: return .refuse(code: "auth_failed", message: "Pair or authenticate first.")
            }
        case .authed:
            switch command {
            case .hostAuthPair, .hostAuthToken: return .refuse(code: "denied", message: "This connection is already authenticated.")
            case .hostHello: return .refuse(code: "denied", message: "This connection already sent host.hello.")
            default:
                return served.contains(command.capability)
                    ? .allow
                    : .refuse(code: "capability_unavailable", message: "This Mac does not serve \(command.capability) right now.")
            }
        }
    }

    static func helloRefusal(apiVersions: [Int]) -> String? {
        apiVersions.contains(HostApi.version) ? nil : "This Mac speaks Host API version 1 only."
    }
}
