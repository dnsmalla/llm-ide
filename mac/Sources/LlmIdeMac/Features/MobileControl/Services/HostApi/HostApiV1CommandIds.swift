import Foundation

/// v1 command ids as the Mac's shared chat machinery sees them: `h1.<session>.<client id>`. The prefix keeps
/// v1 work apart from the v2 phone's UUID command ids (and from other v1 sessions), so v2 connect/disconnect
/// resets can skip it and outbound frames can be routed back to the session that started the command.
enum HostApiV1CommandIds {
    static let prefix = "h1."

    static func internalId(session: Int, external: String) -> String { "\(prefix)\(session).\(external)" }

    static func parse(_ id: String) -> (session: Int, external: String)? {
        guard id.hasPrefix(prefix) else { return nil }
        let rest = id.dropFirst(prefix.count)
        guard let dot = rest.firstIndex(of: "."), let session = Int(rest[..<dot]) else { return nil }
        let external = String(rest[rest.index(after: dot)...])
        return external.isEmpty ? nil : (session, external)
    }

    static func isV1(_ id: String) -> Bool { parse(id) != nil }
}
