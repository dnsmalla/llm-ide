import Foundation

public struct HostApiInboundRequest: Sendable, Equatable {
    public let id: String
    public let command: HostApiCommand
    public let payload: Data
}

/// Why a frame was refused. `message` names the failing schema path, which can include a property name
/// taken from the frame (clamped to 80 UTF-16 units), never a value from the frame. `retryable` and
/// `retryAfterMs` come from a host's error frame (throttle, busy); host-built rejections leave them unset.
public struct HostApiRejection: Error, Sendable, Equatable {
    public let replyTo: String?
    public let code: String
    public let message: String
    public let retryable: Bool
    public let retryAfterMs: Int?
    public init(replyTo: String?, code: String, message: String, retryable: Bool = false, retryAfterMs: Int? = nil) {
        self.replyTo = replyTo; self.code = code; self.message = message
        self.retryable = retryable; self.retryAfterMs = retryAfterMs
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
                                  message: "The frame does not match the Host API envelope (\(clamp(first.path, maxUTF16: 80)))."))
        }
        guard let name = obj["command"] as? String, let command = HostApi.commands[name] else {
            return .failure(.init(replyTo: replyTo, code: "unknown_command", message: "This host does not serve that command."))
        }
        let payload = obj["payload"] ?? [String: Any]()
        if let first = HostApiSchemaValidator.validate(HostApiSchemas.request(for: command), payload, defs: defs).first {
            return .failure(.init(replyTo: replyTo, code: "invalid_payload",
                                  message: "The payload does not match \(name) (\(clamp(first.path, maxUTF16: 80)))."))
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

// MARK: - Client side: build requests, parse what a host sends

public enum HostApiInbound: Sendable, Equatable {
    case response(replyTo: String, command: HostApiCommand, result: Data, rev: Int)
    case event(HostApiEvent, payload: Data, replyTo: String?, rev: Int)
    case error(replyTo: String?, rejection: HostApiRejection, rev: Int?)
}

extension HostApiFrame {
    /// `c-` plus a UUID: 38 characters, inside the envelope's `^[A-Za-z0-9_-]{1,64}$`.
    public static func newClientId() -> String { "c-\(UUID().uuidString)" }

    /// A request frame. The payload must match the command's request schema and the frame the envelope's
    /// `Request`; a mismatch throws `invalid_payload` and nothing is sent.
    public static func request<P: Encodable>(id: String, command: HostApiCommand, payload: P, now: Date = Date()) throws -> Data {
        let payloadObj = try jsonObject(payload)
        if let first = HostApiSchemaValidator.validate(HostApiSchemas.request(for: command), payloadObj, defs: defs).first {
            throw HostApiRejection(replyTo: nil, code: "invalid_payload",
                                   message: "This client built an invalid \(command.rawValue) payload (\(clamp(first.path, maxUTF16: 80))).")
        }
        let frame: [String: Any] = ["apiVersion": 1, "id": id, "type": "request", "command": command.rawValue,
                                    "payload": payloadObj, "ts": millis(now)]
        if let first = HostApiSchemaValidator.validate(defs["Request"] ?? [:], frame, defs: defs).first {
            throw HostApiRejection(replyTo: nil, code: "invalid_payload", message: "This client built an invalid request frame (\(first.path)).")
        }
        let data = try JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys])
        guard data.count <= HostApi.limits.maxFrameBytes else {
            throw HostApiRejection(replyTo: nil, code: "invalid_payload", message: "The request is larger than 1 MiB.")
        }
        return data
    }

    /// One frame from a host. Anything that is not a valid v1 response, event or error frame (a foreign frame,
    /// a newer host's unknown event) is a failure, which the client ignores.
    public static func parseInbound(_ data: Data) -> Result<HostApiInbound, HostApiRejection> {
        func bad(_ why: String) -> Result<HostApiInbound, HostApiRejection> {
            .failure(.init(replyTo: nil, code: "invalid_payload", message: "The host sent \(why)."))
        }
        guard data.count <= HostApi.limits.maxFrameBytes else { return bad("a frame larger than 1 MiB") }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = obj["type"] as? String else { return bad("a frame that is not a Host API object") }
        let replyTo = obj["replyTo"] as? String
        let rev = obj["rev"] as? Int
        switch type {
        case "response":
            if let f = HostApiSchemaValidator.validate(defs["Response"] ?? [:], obj, defs: defs).first { return bad("an invalid response (\(f.path))") }
            guard let name = obj["command"] as? String, let command = HostApi.commands[name] else { return bad("a response for an unknown command") }
            let result = obj["result"] ?? [String: Any]()
            if let f = HostApiSchemaValidator.validate(HostApiSchemas.result(for: command), result, defs: defs).first {
                return bad("an invalid \(name) result (\(f.path))")
            }
            guard let replyTo, let rev, let resultData = try? JSONSerialization.data(withJSONObject: result) else { return bad("an invalid response") }
            return .success(.response(replyTo: replyTo, command: command, result: resultData, rev: rev))
        case "event":
            guard let name = obj["command"] as? String, let event = HostApiEvent(rawValue: name) else { return bad("an unknown event") }
            // The events schema is the oneOf of complete event frames, so it checks the payload too.
            if let f = HostApiSchemaValidator.validate(HostApiSchemas.events, obj, defs: defs).first { return bad("an invalid \(name) event (\(f.path))") }
            guard let rev, let payloadData = try? JSONSerialization.data(withJSONObject: obj["payload"] ?? [String: Any]()) else {
                return bad("an invalid event")
            }
            return .success(.event(event, payload: payloadData, replyTo: replyTo, rev: rev))
        case "error":
            if let f = HostApiSchemaValidator.validate(defs["ErrorFrame"] ?? [:], obj, defs: defs).first { return bad("an invalid error frame (\(f.path))") }
            guard let e = obj["error"] as? [String: Any], let code = e["code"] as? String, let message = e["message"] as? String else {
                return bad("an invalid error frame")
            }
            let details = e["details"] as? [String: Any]
            return .success(.error(replyTo: replyTo, rejection: HostApiRejection(
                replyTo: replyTo, code: code, message: message,
                retryable: e["retryable"] as? Bool ?? false, retryAfterMs: details?["retryAfterMs"] as? Int), rev: rev))
        default:
            return bad("a frame of an unknown type")
        }
    }
}
