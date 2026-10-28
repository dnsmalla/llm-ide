import Foundation

/// One value of a request body the page sends: a string, a whole number or a boolean.
/// Encoded as the bare JSON value, so the server sees the types the page meant.
enum SystemBridgeValue: Equatable, Encodable, ExpressibleByStringLiteral {
    case string(String)
    case int(Int)
    case bool(Bool)

    init(stringLiteral value: String) { self = .string(value) }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        }
    }
}

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
    /// `GET /kb/agent-history/settings` (no query, no body): the retention settings.
    case agentHistorySettings
    /// `PUT /kb/agent-history/settings` with `{retentionDays}`, a whole number of 7...365.
    case setAgentHistoryRetention(days: Int)
    /// `POST /kb/agent-history/clear` with `{scope, beforeDays?, dryRun, previewId?}`. A dry run
    /// (`dryRun: true`) has no previewId; a real clear (`dryRun: false`) carries the previewId
    /// of its dry run. `beforeDays` is a whole number of 0...3650 when given.
    case clearAgentHistory(scope: LlmIdeAPIClient.AgentHistoryClearScope, beforeDays: Int?,
                           dryRun: Bool, previewId: String?)
    /// `POST /kb/agent-history/compact` (no query, no body)
    case compactAgentHistory

    var method: String {
        switch self {
        case .state, .skillLibrary, .agentHistorySettings: return "GET"
        case .setAgentHistoryRetention: return "PUT"
        case .cancelChat, .stopAgentRun, .clearAgentHistory, .compactAgentHistory: return "POST"
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
        case .agentHistorySettings, .setAgentHistoryRetention:
            return "/kb/agent-history/settings"
        case .clearAgentHistory:
            return "/kb/agent-history/clear"
        case .compactAgentHistory:
            return "/kb/agent-history/compact"
        }
    }

    /// The JSON body, or nil when the call has none.
    var body: [String: SystemBridgeValue]? {
        switch self {
        case .state, .skillLibrary, .agentHistorySettings, .compactAgentHistory: return nil
        case .cancelChat(let id): return ["chatSessionId": .string(id)]
        case .stopAgentRun(let id): return ["sessionId": .string(id)]
        case .setAgentHistoryRetention(let days): return ["retentionDays": .int(days)]
        case .clearAgentHistory(let scope, let beforeDays, let dryRun, let previewId):
            var body: [String: SystemBridgeValue] = ["scope": .string(scope.rawValue), "dryRun": .bool(dryRun)]
            if let beforeDays { body["beforeDays"] = .int(beforeDays) }
            if let previewId { body["previewId"] = .string(previewId) }
            return body
        }
    }

    /// Whether native answers this call with the typed agent-history client (`SystemBridge.storageReply`),
    /// not with a generic server request.
    var isAgentHistory: Bool {
        switch self {
        case .agentHistorySettings, .setAgentHistoryRetention, .clearAgentHistory, .compactAgentHistory: return true
        case .state, .cancelChat, .stopAgentRun, .skillLibrary: return false
        }
    }
}

/// The native-only data the page may ask for with `{type:'native', id, name, ...}`.
/// These are not server calls: native assembles the answer from app state.
enum SystemNativeCall: Equatable {
    /// The active project's code graph (`CGData`, as graph-kit's canonical JSON).
    case projectGraph
    /// The active project's scheduled routines (`[RoutineSummary]`).
    case routines
    /// One file's text from the graph repo, for the code preview. `path` is
    /// relative to the repo root and already validated (`SystemBridge.validRelativePath`).
    case file(path: String)
}

/// One `openFile` message from the page, validated: a repo-relative path and an
/// optional 1-based line. Confinement to the repo root is checked on use.
struct SystemOpenFileRequest: Equatable {
    let path: String
    let line: Int?
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
/// - `{type:'open', target}`: the page asks the shell to show a place. `target` is one of
///   `loop` | `autoTasks` | `settings` | `library` | `explorer` | `codeGraph`
///   (see `SystemBridge.section(forOpenTarget:)`). `explorer` shows the Explorer;
///   `codeGraph` shows the Graph section's code-graph page. A target whose feature is
///   off or not compiled in, and any other `target`, is ignored.
/// - `{type:'openFile', path, line?}`: the page asks Explorer to open a file of the
///   project's graph repo. `path` is repo-relative (the same paths the graph nodes
///   carry), `line` an optional 1-based line. Swift shows Explorer with the file open
///   (at `line` when given). Nothing is answered. A refused message is ignored: `path`
///   empty, longer than 1024 UTF-8 bytes, absolute, containing NUL or a `..` component,
///   or `line` not an integer in 1...10000000; and a path that does not resolve (after
///   symlinks) to a regular file inside the repo root, or that is refused by the file
///   rules below (`SystemBridge.confinedFile`). The check runs off the main thread.
///
///   File rules (`openFile` and `file`), applied to the request path AND to the path
///   after symlinks, relative to the resolved root, component-wise and case-insensitively:
///   - Root (`SystemBridge.isOverBroadRoot`): refused when the repo root is a symlink
///     before resolution, or resolves to `/`, the user's home directory, any ancestor of
///     it, or one of `/Users` `/Volumes` `/private` `/System` `/Library` `/Applications`.
///   - Directories refused at any depth: `.git` `.ssh` `.gnupg` `.aws` `.kube` `.docker`.
///   - Last component refused by glob: `.env` `.env.*` `*.pem` `*.key` `*.p12` `*.pfx`
///     `id_rsa*` `id_ed25519*` `id_ecdsa*` `id_dsa*` `*.keychain*` `.netrc` `.npmrc`
///     `.pypirc` `credentials*` `*.mobileprovision`.
///   - `file` only (it returns text to the page): a data-like last component (no
///     extension, or `sensitiveDataExtensions`) containing `secret` or `token` is also
///     refused; source files such as `tokenizer.ts` stay readable. `openFile` does not
///     apply this fragment rule.
///   - Known limit, accepted: a hard link to a file inside the root is followed like any
///     regular file, so a link made inside the repo can expose content it names outside
///     it. Symlinks are refused; hard links cannot be told apart from the file itself.
///   - Refusals are indistinguishable from a missing file: `404 not_found`, no hint.
/// - `{type:'request', id, method, path, body?}`: one allowlisted server call.
///   Swift answers with `llmideResponse(id, {status, body?, error?})`.
/// - `{type:'native', id, name, path?}`: one native-only data set. `name` is one of
///   `projectGraph` | `routines` | `file` (see `SystemNativeCall`). Answered with the same
///   `llmideResponse(id, {status, body?, error?})`:
///   - `projectGraph`, `routines`: as before; an unknown name is `400 not_allowed`.
///   - `file` (`path` as for `openFile`): read off the main thread, at most 256 KiB.
///     `200 {path, text, truncated, bytes, language}` where `text` is UTF-8 decoded
///     leniently, `truncated` is true when the file is larger than 256 KiB (`bytes`
///     is then the total size), and `language` is one of `swift` `typescript`
///     `javascript` `json` `markdown` `python` `rust` `go` `java` `kotlin` `c` `cpp`
///     `css` `html` `yaml` `toml` `shell` from the extension, else null. A file whose
///     first 8 KiB hold a NUL byte is `200 {path, binary: true, bytes}` with no text.
///     A missing, refused or non-regular file is `404 not_found`; an invalid `path`
///     (or missing) is `400 not_allowed`.
/// - `{type:'subscribe'}` / `{type:'unsubscribe'}`: the change feed on or off.
enum SystemBridgeInbound: Equatable {
    case ready
    case open(target: String)
    case openFile(SystemOpenFileRequest)
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
        case "openFile":
            guard let path = (dict["path"] as? String).flatMap(SystemBridge.validRelativePath) else { return nil }
            // An absent or null line means none; any other value must be a valid line.
            var line: Int?
            if let rawLine = dict["line"], !(rawLine is NSNull) {
                guard let value = SystemBridge.validLine(rawLine) else { return nil }
                line = value
            }
            return .openFile(SystemOpenFileRequest(path: path, line: line))
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
            let call: SystemNativeCall?
            switch dict["name"] as? String {
            case "projectGraph": call = .projectGraph
            case "routines": call = .routines
            case "file":
                // An invalid or missing path is refused with the id, like an unknown name.
                call = (dict["path"] as? String).flatMap(SystemBridge.validRelativePath).map { .file(path: $0) }
            default: call = nil
            }
            return .native(SystemBridgeNativeRequest(id: id, call: call))
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
        case ("GET", "/kb/agent-history/settings"):
            guard body == nil, query == nil else { return nil }
            return .agentHistorySettings
        case ("PUT", "/kb/agent-history/settings"):
            guard query == nil, let body, body.count == 1,
                  let days = integerValue(body["retentionDays"], in: retentionDaysRange) else { return nil }
            return .setAgentHistoryRetention(days: days)
        case ("POST", "/kb/agent-history/clear"):
            guard query == nil else { return nil }
            return clearCall(body: body)
        case ("POST", "/kb/agent-history/compact"):
            guard body == nil, query == nil else { return nil }
            return .compactAgentHistory
        default:
            return nil
        }
    }

    /// Whole days the retention setting may hold (the server clamps to the same range).
    static let retentionDaysRange = 7...365
    /// Largest `beforeDays` a clear may name (the server's own cap).
    static let maxBeforeDays = 3650
    /// Longest preview id the page may send back. Preview ids are a base64url payload, a dot, and a MAC.
    static let maxPreviewIdLength = 512

    /// `{scope, dryRun, beforeDays?, previewId?}`: scope `raw` or `all`; a dry run takes no previewId,
    /// a real clear needs one. Any other key, or a value of the wrong type, refuses the call.
    private static func clearCall(body: [String: Any]?) -> SystemAllowedCall? {
        guard let body, onlyKeys(body, required: ["scope", "dryRun"], optional: ["beforeDays", "previewId"]),
              let scopeName = body["scope"] as? String,
              let scope = LlmIdeAPIClient.AgentHistoryClearScope(rawValue: scopeName),
              let dryRun = boolValue(body["dryRun"]) else { return nil }
        let beforeDays: Int?
        if let raw = body["beforeDays"], !(raw is NSNull) {
            guard let days = integerValue(raw, in: 0...maxBeforeDays) else { return nil }
            beforeDays = days
        } else {
            beforeDays = nil
        }
        let previewId: String?
        if let raw = body["previewId"], !(raw is NSNull) {
            guard let id = raw as? String, isValidPreviewId(id) else { return nil }
            previewId = id
        } else {
            previewId = nil
        }
        // A dry run has no previewId and a real clear has one: any other pairing is refused.
        guard dryRun == (previewId == nil) else { return nil }
        return .clearAgentHistory(scope: scope, beforeDays: beforeDays, dryRun: dryRun, previewId: previewId)
    }

    /// Whether a body has no keys outside `required` and `optional`, and every `required` key.
    private static func onlyKeys(_ body: [String: Any], required: Set<String>, optional: Set<String>) -> Bool {
        let keys = Set(body.keys)
        return required.isSubset(of: keys) && keys.isSubset(of: required.union(optional))
    }

    /// A JSON whole number in `range`. A boolean, a fraction and a string are refused.
    static func integerValue(_ value: Any?, in range: ClosedRange<Int>) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let d = number.doubleValue
        guard d.rounded() == d, d >= Double(range.lowerBound), d <= Double(range.upperBound) else { return nil }
        return Int(d)
    }

    /// A JSON boolean. A number (even 0 or 1) is refused.
    static func boolValue(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// A preview id: 1...`maxPreviewIdLength` characters of letters, digits, `-`, `_` and `.`.
    static func isValidPreviewId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= maxPreviewIdLength else { return false }
        return id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ".") }
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

    // MARK: Agent history replies

    /// What a clear call does: a dry run (the counts and a previewId) or a real clear that
    /// carries the previewId of its dry run.
    enum StorageClearPlan: Equatable {
        case preview(scope: LlmIdeAPIClient.AgentHistoryClearScope, beforeDays: Int?)
        case commit(scope: LlmIdeAPIClient.AgentHistoryClearScope, beforeDays: Int?, previewId: String)
    }

    /// The plan for a validated clear call. Nil for any other call, and for a real clear without a previewId.
    static func clearPlan(_ call: SystemAllowedCall) -> StorageClearPlan? {
        guard case .clearAgentHistory(let scope, let beforeDays, let dryRun, let previewId) = call else { return nil }
        if dryRun { return .preview(scope: scope, beforeDays: beforeDays) }
        guard let previewId else { return nil }
        return .commit(scope: scope, beforeDays: beforeDays, previewId: previewId)
    }

    /// Answers one agent-history call with the typed client, which owns the request shapes and the
    /// Codable models. A 200 carries the JSON the page reads. A failure keeps the server's status,
    /// sets `error` to the server's code and sends `{code, message}` as the body. Nil for a call
    /// that is not an agent-history call.
    static func storageReply(_ call: SystemAllowedCall, api: LlmIdeAPIClient) async -> NativeReply? {
        guard call.isAgentHistory else { return nil }
        do {
            switch call {
            case .agentHistorySettings:
                let settings = try await api.agentHistorySettings()
                return okJSON(settings)
            case .setAgentHistoryRetention(let days):
                let settings = try await api.setAgentHistoryRetention(days: days)
                return okJSON(settings)
            case .clearAgentHistory:
                guard let plan = clearPlan(call) else { return nil }
                switch plan {
                case .preview(let scope, let beforeDays):
                    let result = try await api.previewAgentHistoryClear(scope: scope, beforeDays: beforeDays)
                    return okJSON(result)
                case .commit(let scope, let beforeDays, let previewId):
                    let result = try await api.performAgentHistoryClear(
                        scope: scope, beforeDays: beforeDays, previewId: previewId)
                    return okJSON(result)
                }
            case .compactAgentHistory:
                let result = try await api.compactAgentHistory()
                return okJSON(result)
            default:
                return nil
            }
        } catch APIError.http(let status, let code, let message, _) {
            return storageFailure(status: status, code: code, message: message)
        } catch APIError.noSession {
            return NativeReply(status: 401, bodyJSON: "null", error: "signed_out")
        } catch {
            return NativeReply(status: 0, bodyJSON: "null", error: "unreachable")
        }
    }

    /// A 200 reply whose body is `value` encoded as JSON.
    static func okJSON<T: Encodable>(_ value: T) -> NativeReply {
        guard let json = jsonFragment(value) else {
            return NativeReply(status: 500, bodyJSON: "null", error: "encode_failed")
        }
        return NativeReply(status: 200, bodyJSON: json, error: nil)
    }

    /// A failed agent-history call: the server's status, its code as `error`, and `{code, message}` as the body.
    static func storageFailure(status: Int, code: String, message: String) -> NativeReply {
        let json = jsonObjectFragment(["code": code, "message": message]) ?? "null"
        return NativeReply(status: status, bodyJSON: json, error: code)
    }

    // MARK: File access (openFile and native file)

    /// Longest repo-relative path a page may send, in UTF-8 bytes.
    static let maxFilePathBytes = 1024
    /// Highest line an `openFile` may name.
    static let maxLine = 10_000_000
    /// Most bytes of one file the native `file` call returns.
    static let maxFileReadBytes = 256 * 1024
    /// The leading bytes searched for a NUL to call a file binary.
    static let binarySniffBytes = 8 * 1024

    /// The file extensions the code preview names a language for, and the
    /// language each one is. Anything else (or no extension) is `null`.
    static let languageByExtension: [String: String] = [
        "swift": "swift", "ts": "typescript", "tsx": "typescript",
        "js": "javascript", "mjs": "javascript", "json": "json", "md": "markdown",
        "py": "python", "rs": "rust", "go": "go", "java": "java", "kt": "kotlin",
        "c": "c", "h": "c", "cpp": "cpp", "css": "css", "html": "html",
        "yml": "yaml", "yaml": "yaml", "toml": "toml", "sh": "shell",
    ]

    /// A path from the page, when it is a usable repo-relative path: non-empty,
    /// at most `maxFilePathBytes` UTF-8 bytes, not absolute, no NUL, and no `..`
    /// component. Nil otherwise. Whether it stays inside the repo is decided by
    /// `confinedFile` against the real file system.
    static func validRelativePath(_ raw: String) -> String? {
        guard !raw.isEmpty, raw.utf8.count <= maxFilePathBytes else { return nil }
        guard !raw.unicodeScalars.contains("\u{0}"), !raw.hasPrefix("/") else { return nil }
        guard !raw.split(separator: "/", omittingEmptySubsequences: false).contains("..") else { return nil }
        return raw
    }

    /// A line from the page: an integer (not a boolean, not fractional) in `1...maxLine`.
    static func validLine(_ value: Any) -> Int? {
        // JSON `true` bridges to an NSNumber whose type is CFBoolean; refuse it
        // rather than read it as 1.
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let d = number.doubleValue
        guard d.rounded() == d, d >= 1, d <= Double(maxLine) else { return nil }
        return Int(d)
    }

    /// Directory names no path may pass through, at any depth (lowercase; matched case-insensitively).
    static let sensitiveDirectoryNames: Set<String> = [".git", ".ssh", ".gnupg", ".aws", ".kube", ".docker"]

    /// Glob patterns (`*` only, lowercase) the LAST path component may not match.
    static let sensitiveFilePatterns: [String] = [
        ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx",
        "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*", "*.keychain*",
        ".netrc", ".npmrc", ".pypirc", "credentials*", "*.mobileprovision",
    ]

    /// Name fragments the last component may not contain, for the `file` call only.
    static let sensitiveTextFragments: [String] = ["secret", "token"]

    /// Extensions of data-like files the fragment rule applies to (plus no extension).
    /// Source and prose files are left alone so `tokenizer.ts` or `secrets-manager.md`
    /// still preview.
    static let sensitiveDataExtensions: Set<String> = [
        "json", "txt", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
        "env", "plist", "csv", "xml", "dat", "db", "sqlite",
    ]

    /// Paths that are never a repo root, whatever they resolve to.
    static let refusedRootPaths: Set<String> = [
        "/", "/Users", "/Volumes", "/private", "/System", "/Library", "/Applications",
    ]

    /// Whether `relativePath` (repo-relative) names a secret-bearing location. Checked
    /// component-wise and case-insensitively, against `sensitiveDirectoryNames` at any
    /// depth and `sensitiveFilePatterns` on the last component. With `forText`, the last
    /// component is also refused when it contains a `sensitiveTextFragments` entry.
    static func isSensitivePath(_ relativePath: String, forText: Bool) -> Bool {
        let components = relativePath.lowercased().split(separator: "/").map(String.init)
        guard let name = components.last else { return true }
        if components.contains(where: sensitiveDirectoryNames.contains) { return true }
        if sensitiveFilePatterns.contains(where: { fnmatch($0, name, 0) == 0 }) { return true }
        if forText, sensitiveTextFragments.contains(where: { name.contains($0) }) {
            let ext = (name as NSString).pathExtension
            if ext.isEmpty || sensitiveDataExtensions.contains(ext) { return true }
        }
        return false
    }

    /// Whether a resolved repo root is too broad to confine anything to: one of
    /// `refusedRootPaths`, the home directory itself, or an ancestor of it.
    static func isOverBroadRoot(_ rootPath: String, home homePath: String) -> Bool {
        if refusedRootPaths.contains(rootPath) { return true }
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        return homePath == rootPath || homePath.hasPrefix(prefix)
    }

    /// Whether the path itself is a symbolic link (not followed).
    private static func isSymbolicLink(atPath path: String) -> Bool {
        var info = stat()
        guard lstat(path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFLNK
    }

    /// The user's home directory, symlinks and dot-segments resolved.
    private static var resolvedHomePath: String {
        FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// The file `relativePath` names under `repoRoot`, when it resolves (symlinks
    /// followed on both sides) to a regular file inside the root and is not refused
    /// by the file rules (see the bridge contract). Nil for: a root that is a symlink
    /// before resolution or is over-broad (`isOverBroadRoot`); an escape through a
    /// symlink or `..`; a sensitive path (`isSensitivePath`, with `forText` for the
    /// `file` call); a missing file, a directory, or anything else.
    ///
    /// The result is a validated location, not an open file: `openRegularFile` opens
    /// it again with `O_NOFOLLOW` and checks the descriptor.
    static func confinedFile(relativePath: String, repoRoot: URL, forText: Bool = false) -> URL? {
        guard !isSymbolicLink(atPath: repoRoot.path) else { return nil }
        let root = repoRoot.resolvingSymlinksInPath().standardizedFileURL
        guard !isOverBroadRoot(root.path, home: resolvedHomePath) else { return nil }
        let candidate = root.appendingPathComponent(relativePath)
            .resolvingSymlinksInPath().standardizedFileURL
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(prefix), candidate.path != root.path else { return nil }
        let inside = String(candidate.path.dropFirst(prefix.count))
        guard !isSensitivePath(relativePath, forText: forText),
              !isSensitivePath(inside, forText: forText) else { return nil }
        guard let values = try? candidate.resourceValues(forKeys: [.isRegularFileKey]),
              values.isRegularFile == true else { return nil }
        return candidate
    }

    /// Opens a validated file for reading without following a symlink at the final
    /// component (`O_NOFOLLOW`), without blocking on a FIFO or device (`O_NONBLOCK`),
    /// and checks the open descriptor itself is a regular file (`fstat`). Reads then
    /// come from that descriptor, so a path swapped after validation is refused.
    /// Nil for anything else. The caller owns the handle (closed on dealloc).
    static func openRegularFile(at url: URL) -> (handle: FileHandle, size: Int)? {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { return nil }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            close(fd)
            return nil
        }
        return (FileHandle(fileDescriptor: fd, closeOnDealloc: true), Int(info.st_size))
    }

    /// The answer to a native `file` call: the confined file's text, a binary marker,
    /// or `404 not_found`. Reads at most `maxFileReadBytes` from the opened descriptor;
    /// the binary sniff looks at the first `binarySniffBytes` of that same read.
    /// Blocking file I/O: call it off the main thread.
    static func fileNativeReply(relativePath: String, repoRoot: URL?) -> NativeReply {
        let notFound = NativeReply(status: 404, bodyJSON: "null", error: "not_found")
        guard let repoRoot,
              let url = confinedFile(relativePath: relativePath, repoRoot: repoRoot, forText: true),
              let opened = openRegularFile(at: url) else { return notFound }
        let handle = opened.handle
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: maxFileReadBytes)) ?? Data()
        let total = opened.size
        let body: [String: Any]
        if head.prefix(binarySniffBytes).contains(0) {
            body = ["path": relativePath, "binary": true, "bytes": total]
        } else {
            let ext = (relativePath as NSString).pathExtension.lowercased()
            body = [
                "path": relativePath,
                "text": String(decoding: head, as: UTF8.self),
                "truncated": total > maxFileReadBytes,
                "bytes": total,
                "language": nullable(languageByExtension[ext]),
            ]
        }
        guard let json = jsonObjectFragment(body) else {
            return NativeReply(status: 500, bodyJSON: "null", error: "encode_failed")
        }
        return NativeReply(status: 200, bodyJSON: json, error: nil)
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
        case "explorer":  section = .explorer
        case "codeGraph": section = .codeGraph
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
