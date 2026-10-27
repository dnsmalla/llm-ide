import Foundation

/// The server calls the OS page may ask native to make. Native makes them with
/// its authenticated client; the page never holds the token and never talks to
/// the server itself. Anything not in this list is refused.
enum SystemAllowedCall: Equatable {
    /// `GET /kb/os/state?window=day|week[&activity=1..100]`
    case state(window: String, activity: Int?)
    /// `POST /agent/v2/cancel` with `{chatSessionId}`
    case cancelChat(chatSessionId: String)
    /// `POST /kb/agent/stop` with `{sessionId}`
    case stopAgentRun(sessionId: String)
    /// `GET /kb/agent/skill-library` (no query, no body)
    case skillLibrary

    var method: String {
        switch self {
        case .state, .skillLibrary: return "GET"
        case .cancelChat, .stopAgentRun: return "POST"
        }
    }

    /// The path, rebuilt from validated values only (never echoed from the page).
    var path: String {
        switch self {
        case .state(let window, let activity):
            var path = "/kb/os/state?window=\(window)"
            if let activity { path += "&activity=\(activity)" }
            return path
        case .cancelChat:
            return "/agent/v2/cancel"
        case .stopAgentRun:
            return "/kb/agent/stop"
        case .skillLibrary:
            return "/kb/agent/skill-library"
        }
    }

    /// The JSON body, or nil for a GET.
    var body: [String: String]? {
        switch self {
        case .state, .skillLibrary: return nil
        case .cancelChat(let id): return ["chatSessionId": id]
        case .stopAgentRun(let id): return ["sessionId": id]
        }
    }
}

/// The native-only data the page may ask for with `{type:'native', id, name}`.
/// These are not server calls: native assembles the answer from app state.
enum SystemNativeCall: String, Equatable, CaseIterable {
    /// The active project's code graph (`CGData`, as graph-kit's canonical JSON).
    case projectGraph
    /// The active project's scheduled routines (`[RoutineSummary]`).
    case routines
}

/// One `native` message from the page: a call id and the named call, or nil
/// when the name is not one of `SystemNativeCall` (the page still gets a 400).
struct SystemBridgeNativeRequest: Equatable {
    let id: String
    let call: SystemNativeCall?
}

/// One `request` message from the page: a call id and the validated call, or
/// nil when the call was refused (the page still gets an error reply for `id`).
struct SystemBridgeRequest: Equatable {
    let id: String
    let call: SystemAllowedCall?
}

/// Messages the OS page posts to Swift through
/// `window.webkit.messageHandlers.llmide.postMessage({...})`.
///
/// Fixed contract shared with the React page (`mac/Sources/LlmIdeMac/Resources/os-view`):
/// - `{type:'ready'}`: the page has loaded; Swift answers with `llmideConfigure`.
/// - `{type:'open', target}`: the page asks the shell to show a section.
/// - `{type:'request', id, method, path, body?}`: one allowlisted server call.
///   Swift answers with `llmideResponse(id, {status, body?, error?})`.
/// - `{type:'native', id, name}`: one native-only data set, `name` one of
///   `projectGraph` | `routines` (see `SystemNativeCall`). Answered with the same
///   `llmideResponse(id, {status, body?, error?})`; an unknown name is `400 not_allowed`.
/// - `{type:'subscribe'}` / `{type:'unsubscribe'}`: the change feed on or off.
enum SystemBridgeInbound: Equatable {
    case ready
    case open(target: String)
    case request(SystemBridgeRequest)
    case native(SystemBridgeNativeRequest)
    case subscribe
    case unsubscribe

    /// Decodes a script-message body. Unknown types and malformed bodies are
    /// `nil`, which the caller ignores: a page must not be able to drive the
    /// shell by sending something unexpected. A malformed `request` with a
    /// usable id decodes to a refused request, so that call still gets a reply.
    static func decode(_ body: Any) -> SystemBridgeInbound? {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
        switch type {
        case "ready":
            return .ready
        case "open":
            guard let target = dict["target"] as? String, !target.isEmpty else { return nil }
            return .open(target: target)
        case "subscribe":
            return .subscribe
        case "unsubscribe":
            return .unsubscribe
        case "request":
            guard let id = dict["id"] as? String, SystemBridge.isValidRequestId(id) else { return nil }
            let method = (dict["method"] as? String) ?? ""
            let path = (dict["path"] as? String) ?? ""
            // An absent or null body is "no body"; anything else must be an object.
            let rawBody = dict["body"]
            var bodyObject: [String: Any]?
            if rawBody == nil || rawBody is NSNull {
                bodyObject = nil
            } else if let object = rawBody as? [String: Any] {
                bodyObject = object
            } else {
                return .request(SystemBridgeRequest(id: id, call: nil))
            }
            let call = SystemBridge.validate(method: method, path: path, body: bodyObject)
            return .request(SystemBridgeRequest(id: id, call: call))
        case "native":
            guard let id = dict["id"] as? String, SystemBridge.isValidRequestId(id) else { return nil }
            let name = (dict["name"] as? String).flatMap(SystemNativeCall.init(rawValue:))
            return .native(SystemBridgeNativeRequest(id: id, call: name))
        default:
            return nil
        }
    }
}

/// The argument of `window.llmideConfigure(...)`. The page gets only what it
/// draws: the theme and the project name. No server address, no token.
struct SystemBridgeConfig: Encodable, Equatable {
    let theme: String
    let projectName: String?

    private enum Keys: String, CodingKey {
        case theme, projectName
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(theme, forKey: .theme)
        try c.encode(projectName, forKey: .projectName)
    }
}

/// Pure helpers for the OS view bridge. Everything that turns app values into
/// JavaScript or decides what a page may do lives here, so it is testable
/// without a WKWebView.
enum SystemBridge {
    // MARK: Request allowlist

    /// Longest path a request may carry (the state call is well under this).
    static let maxPathLength = 256
    /// Longest query string accepted after the `?`.
    static let maxQueryLength = 128
    /// Longest id value in a cancel or stop body.
    static let maxIdLength = 128
    /// Longest call id from the page.
    static let maxRequestIdLength = 64

    /// Validates one page request. Returns the call only when the method, the
    /// exact path, the query keys and values, and the body shape all match an
    /// allowlisted call. Anything else is nil.
    static func validate(method: String, path: String, body: [String: Any]?) -> SystemAllowedCall? {
        guard path.utf8.count <= maxPathLength else { return nil }
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let base = String(parts[0])
        let query: String? = parts.count > 1 ? String(parts[1]) : nil

        switch (method, base) {
        case ("GET", "/kb/os/state"):
            guard body == nil, let query else { return nil }
            return stateCall(query: query)
        case ("POST", "/agent/v2/cancel"):
            guard query == nil, let id = singleId(body, key: "chatSessionId") else { return nil }
            return .cancelChat(chatSessionId: id)
        case ("POST", "/kb/agent/stop"):
            guard query == nil, let id = singleId(body, key: "sessionId") else { return nil }
            return .stopAgentRun(sessionId: id)
        case ("GET", "/kb/agent/skill-library"):
            guard body == nil, query == nil else { return nil }
            return .skillLibrary
        default:
            return nil
        }
    }

    /// Parses `window=day|week` (required) and `activity=1..100` (optional).
    /// Unknown keys, repeats, empty values and anything non-numeric are refused.
    private static func stateCall(query: String) -> SystemAllowedCall? {
        guard query.utf8.count <= maxQueryLength else { return nil }
        var window: String?
        var activity: Int?
        var seen = Set<String>()
        for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard kv.count == 2 else { return nil }
            let key = String(kv[0])
            let value = String(kv[1])
            guard seen.insert(key).inserted else { return nil }
            switch key {
            case "window":
                guard value == "day" || value == "week" else { return nil }
                window = value
            case "activity":
                guard !value.isEmpty, value.count <= 3,
                      value.allSatisfy({ $0 >= "0" && $0 <= "9" }),
                      let n = Int(value), (1...100).contains(n) else { return nil }
                activity = n
            default:
                return nil
            }
        }
        guard let window else { return nil }
        return .state(window: window, activity: activity)
    }

    /// A body with exactly one string key, a plausible id.
    private static func singleId(_ body: [String: Any]?, key: String) -> String? {
        guard let body, body.count == 1, let value = body[key] as? String else { return nil }
        guard !value.isEmpty, value.count <= maxIdLength else { return nil }
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:")
        guard value.allSatisfy({ allowed.contains($0) }) else { return nil }
        return value
    }

    /// The page's call id: short and plain, so it is safe in JavaScript.
    static func isValidRequestId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= maxRequestIdLength else { return false }
        return id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    // MARK: Scripts handed to the page

    /// The JavaScript that hands the page its configuration.
    static func configureScript(_ config: SystemBridgeConfig) -> String? {
        guard let json = jsonFragment(config) else { return nil }
        return jsSafe("window.llmideConfigure(\(json));")
    }

    /// `window.llmideResponse(id, {status, body, error})`. The body is the
    /// server's JSON, parsed; a non-JSON or empty body becomes null. Status 0
    /// means the call never reached the server.
    static func responseScript(id: String, status: Int, body: Data?, error: String?) -> String? {
        var parsed: Any = NSNull()
        if let body, !body.isEmpty,
           let value = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) {
            parsed = value
        }
        let reply: [String: Any] = [
            "status": status,
            "body": parsed,
            "error": nullable(error),
        ]
        guard let idJSON = jsonFragment(id), let replyJSON = jsonObjectFragment(reply) else { return nil }
        return jsSafe("window.llmideResponse(\(idJSON), \(replyJSON));")
    }

    /// `llmideResponse` for a body that is already JSON text (a graph or a
    /// routine list encoded off the main thread). `bodyJSON` must be a valid
    /// JSON fragment; it is spliced in as is, so the caller encodes it.
    static func responseScript(id: String, status: Int, bodyJSON: String, error: String?) -> String? {
        guard let idJSON = jsonFragment(id) else { return nil }
        let errorJSON: String
        if let error {
            guard let encoded = jsonFragment(error) else { return nil }
            errorJSON = encoded
        } else {
            errorJSON = "null"
        }
        return jsSafe("window.llmideResponse(\(idJSON), {\"status\":\(status),\"body\":\(bodyJSON),\"error\":\(errorJSON)});")
    }

    /// U+2028 and U+2029 are legal raw inside JSON strings but were line
    /// terminators in older JavaScript engines, which breaks a script that
    /// carries them. Escaping them keeps the script valid everywhere; the
    /// escape decodes to the same character in JSON.
    static func jsSafe(_ script: String) -> String {
        script
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    // MARK: Native bodies

    /// The outcome of one native answer: the status, the JSON body text and an error code.
    struct NativeReply: Equatable {
        let status: Int
        let bodyJSON: String
        let error: String?
    }

    /// Answers `projectGraph`. `provided` is the Graph feature's cached graph as
    /// `GraphDocument` JSON (`ProjectGraphRegistry`); when nil, `loadFile` reads the
    /// project's v1.1 graph.json. The graph is capped (`ProjectGraphCap`) and
    /// encoded in the canonical shape. No graph is `200 null`. Bytes that cannot
    /// be read as a graph document, or a graph that cannot be encoded, are
    /// `500 graph_encode_failed`, never a silent null.
    static func projectGraphReply(provided: Data?, loadFile: () -> ProjectGraphDocument?) -> NativeReply {
        let document: ProjectGraphDocument?
        if let provided {
            guard let decoded = ProjectGraphDocument.decode(graphDocumentJSON: provided) else {
                return graphEncodeFailed
            }
            document = decoded
        } else {
            document = loadFile()
        }
        guard let document else { return NativeReply(status: 200, bodyJSON: "null", error: nil) }
        let capped = ProjectGraphCap.capped(document)
        guard let data = capped.jsonData(), let text = String(data: data, encoding: .utf8) else {
            return graphEncodeFailed
        }
        return NativeReply(status: 200, bodyJSON: text, error: nil)
    }

    private static let graphEncodeFailed = NativeReply(status: 500, bodyJSON: "null", error: "graph_encode_failed")

    /// The skill library as the page may see it: `repo` (a local path) is dropped
    /// at the top level, and each skill keeps only `id`, `family`, `name`,
    /// `description`, `sourceId` and `sourceName` (`path` is a local file path).
    /// Other top-level keys pass through. nil when the body is not a JSON object.
    static func sanitizeSkillLibrary(_ body: Data) -> Data? {
        guard var object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return nil }
        object.removeValue(forKey: "repo")
        let keep: Set<String> = ["id", "family", "name", "description", "sourceId", "sourceName"]
        if let skills = object["skills"] as? [[String: Any]] {
            object["skills"] = skills.map { $0.filter { keep.contains($0.key) } }
        }
        return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    /// The routines body: a JSON array of `RoutineSummary` with ISO-8601 dates.
    static func routinesBodyJSON(_ routines: [RoutineSummary]) -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(routines),
              let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    /// What a change of the active project means for the open page. The page's
    /// controller can see only the project's name, so a switch that keeps the
    /// name (or changes only the root or id) needs a fresh page load.
    enum ProjectChange: Equatable {
        case none
        /// The name changed: the page is configured and its extras reload itself; the feed restarts.
        case renamed
        /// Only the root or id changed: reload the page so nothing from the old project survives.
        case reloadPage
    }

    static func projectChange(fromName oldName: String?, fromRoot oldRoot: URL?, fromId oldId: String?,
                              toName newName: String?, toRoot newRoot: URL?, toId newId: String?) -> ProjectChange {
        if newName != oldName { return .renamed }
        if newRoot != oldRoot || newId != oldId { return .reloadPage }
        return .none
    }

    /// `window.llmideEvent({type, at})`: only the type and the time cross over.
    static func eventScript(_ event: SystemFeedEvent) -> String? {
        let payload: [String: Any] = ["type": event.type, "at": nullable(event.at)]
        guard let json = jsonObjectFragment(payload) else { return nil }
        return jsSafe("window.llmideEvent(\(json));")
    }

    /// `window.llmideStatus({status, detail})` for the feed's state.
    static func statusScript(status: String, detail: String?) -> String? {
        let payload: [String: Any] = ["status": status, "detail": nullable(detail)]
        guard let json = jsonObjectFragment(payload) else { return nil }
        return jsSafe("window.llmideStatus(\(json));")
    }

    /// Encodes a value as a JSON fragment for `evaluateJavaScript`. Values are
    /// escaped by the encoder; nothing is concatenated as raw text.
    static func jsonFragment<T: Encodable>(_ value: T) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The same for a dictionary that may hold `NSNull` (JSON null).
    static func jsonObjectFragment(_ value: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: []) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// A string or an explicit JSON null, for dictionaries handed to `jsonObjectFragment`.
    static func nullable(_ value: String?) -> Any {
        value.map { $0 as Any } ?? NSNull()
    }

    // MARK: open target mapping

    /// Maps a page's `open` target to a shell section. Returns `nil` for an
    /// unknown target, and for a section whose feature is not compiled in or
    /// not enabled, so the page cannot route into a disabled feature.
    @MainActor
    static func section(forOpenTarget target: String,
                        isEnabled: ((AppFeature) -> Bool)? = nil) -> ShellSection? {
        // A default-argument closure is evaluated outside the main actor, so
        // the registry is read here, inside the @MainActor body.
        let isEnabled = isEnabled ?? { FeatureRegistry.shared.isEnabled($0) }
        let section: ShellSection
        switch target {
        case "loop":      section = .loopEngine
        case "autoTasks": section = .autoCode
        case "settings":  section = .settings
        case "library":   section = .library
        default:          return nil
        }
        if let feature = section.backingFeature, !isEnabled(feature) { return nil }
        return section
    }

    /// Whether a navigation may proceed in the OS view: only file URLs inside
    /// the bundled page's own directory. Every remote URL, every other
    /// local file, and any `..` escape is refused.
    static func isLocalNavigation(_ url: URL?, bundleDirectory: URL?) -> Bool {
        guard let url, url.isFileURL, let bundleDirectory else { return false }
        let root = bundleDirectory.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        return path.hasPrefix(root + "/")
    }
}
