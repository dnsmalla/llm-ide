import Foundation

public struct HostApiInboundRequest: Sendable, Equatable {
    public let id: String
    public let command: HostApiCommand
    public let payload: Data
}

/// Why an inbound frame was refused. `message` is fixed host text: it names the failing schema path,
/// never a value from the frame, so it can carry no token or file content.
public struct HostApiRejection: Error, Sendable, Equatable {
    public let replyTo: String?
    public let code: String
    public let message: String
    public init(replyTo: String?, code: String, message: String) {
        self.replyTo = replyTo; self.code = code; self.message = message
    }
}

public enum HostApiFrame {
    static let errorCodes: Set<String> = ["auth_failed", "capability_unavailable", "unknown_command", "invalid_payload",
                                          "not_found", "busy", "denied", "desktop_only", "rate_limited",
                                          "host_unreachable", "internal"]
    private static var defs: [String: Any] { HostApiSchemas.envelope["$defs"] as? [String: Any] ?? [:] }
    private static let idPattern = "^[A-Za-z0-9_-]{1,64}$"

    public static func parseRequest(_ data: Data) -> Result<HostApiInboundRequest, HostApiRejection> {
        guard data.count <= HostApi.limits.maxFrameBytes else {
            return .failure(.init(replyTo: nil, code: "invalid_payload", message: "The frame is larger than 1 MiB."))
        }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(.init(replyTo: nil, code: "invalid_payload", message: "The frame is not a JSON object."))
        }
        // Only a well-formed id is echoed back as replyTo.
        let replyTo = (obj["id"] as? String).flatMap { HostApiSchemaValidator.matches($0, idPattern) ? $0 : nil }
        if let first = HostApiSchemaValidator.validate(defs["Request"] ?? [:], obj, defs: defs).first {
            return .failure(.init(replyTo: replyTo, code: "invalid_payload",
                                  message: "The frame does not match the Host API envelope (\(first.path))."))
        }
        guard let name = obj["command"] as? String, let command = HostApi.commands[name] else {
            return .failure(.init(replyTo: replyTo, code: "unknown_command", message: "This host does not serve that command."))
        }
        let payload = obj["payload"] ?? [String: Any]()
        if let first = HostApiSchemaValidator.validate(HostApiSchemas.request(for: command), payload, defs: defs).first {
            return .failure(.init(replyTo: replyTo, code: "invalid_payload",
                                  message: "The payload does not match \(name) (\(first.path))."))
        }
        guard let id = replyTo, let payloadData = try? JSONSerialization.data(withJSONObject: payload) else {
            return .failure(.init(replyTo: nil, code: "invalid_payload", message: "The frame does not match the Host API envelope (.id)."))
        }
        return .success(.init(id: id, command: command, payload: payloadData))
    }

    public static func response<R: Encodable>(replyTo: String, command: HostApiCommand, result: R, rev: Int,
                                              now: Date = Date()) throws -> Data {
        let resultObj = try jsonObject(result)
        if let first = HostApiSchemaValidator.validate(HostApiSchemas.result(for: command), resultObj, defs: defs).first {
            throw HostApiRejection(replyTo: replyTo, code: "internal", message: "The host built an invalid \(command.rawValue) result (\(first.path)).")
        }
        return try finish(["apiVersion": 1, "id": newId(), "replyTo": replyTo, "type": "response",
                           "command": command.rawValue, "result": resultObj, "ts": millis(now), "rev": rev], def: "Response")
    }

    public static func event<P: Encodable>(_ command: String, payload: P, rev: Int, replyTo: String? = nil,
                                           now: Date = Date()) throws -> Data {
        var frame: [String: Any] = ["apiVersion": 1, "id": newId(), "type": "event", "command": command,
                                    "payload": try jsonObject(payload), "ts": millis(now), "rev": rev]
        if let replyTo { frame["replyTo"] = replyTo }
        // The events schema is the oneOf of complete event frames, so it checks the payload too.
        if let first = HostApiSchemaValidator.validate(HostApiSchemas.events, frame, defs: defs).first {
            throw HostApiRejection(replyTo: replyTo, code: "internal", message: "The host built an invalid \(command) event (\(first.path)).")
        }
        return try finish(frame, def: "Event")
    }

    public static func error(replyTo: String?, code: String, message: String, retryable: Bool,
                             retryAfterMs: Int? = nil, hint: String? = nil, rev: Int, now: Date = Date()) -> Data {
        var error: [String: Any] = ["code": errorCodes.contains(code) ? code : "internal",
                                    "message": clamp(message.isEmpty ? "The host could not handle this request." : message, maxUTF16: 500),
                                    "retryable": retryable]
        var details: [String: Any] = [:]
        if let retryAfterMs { details["retryAfterMs"] = max(0, retryAfterMs) }
        if let hint { details["hint"] = clamp(hint, maxUTF16: 500) }
        if !details.isEmpty { error["details"] = details }
        var frame: [String: Any] = ["apiVersion": 1, "id": newId(), "type": "error", "error": error,
                                    "ts": millis(now), "rev": max(0, rev)]
        if let replyTo, HostApiSchemaValidator.matches(replyTo, idPattern) { frame["replyTo"] = replyTo }
        return (try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys])) ?? Data()
    }

    /// The longest prefix, cut between Characters, whose UTF-16 length is at most `maxUTF16`.
    public static func clamp(_ s: String, maxUTF16: Int) -> String {
        guard s.utf16.count > maxUTF16 else { return s }
        var out = "", n = 0
        for ch in s {
            let w = String(ch).utf16.count
            if n + w > maxUTF16 { break }
            out.append(ch); n += w
        }
        return out
    }

    private static func finish(_ frame: [String: Any], def: String) throws -> Data {
        if let first = HostApiSchemaValidator.validate(defs[def] ?? [:], frame, defs: defs).first {
            throw HostApiRejection(replyTo: frame["replyTo"] as? String, code: "internal",
                                   message: "The host built an invalid \(def) frame (\(first.path)).")
        }
        let data = try JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys])
        guard data.count <= HostApi.limits.maxFrameBytes else {
            throw HostApiRejection(replyTo: frame["replyTo"] as? String, code: "internal", message: "The host built a frame larger than 1 MiB.")
        }
        return data
    }

    private static func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private static func newId() -> String { "h-\(UUID().uuidString)" }
    private static func millis(_ d: Date) -> Int { Int(d.timeIntervalSince1970 * 1000) }
}
