# Host API v1 Mac Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Mac app serves Host API v1 (the 12 Plan 1 commands and 7 events) on a second, loopback-only WebSocket listener beside the unchanged v2 Mobile Control server, reusing the existing chat, approval and pairing code.

**Architecture:** SharedProtocol gains the v1 machinery every Swift host and client needs: a JSON Schema subset validator (a port of `extension/routes/bus/schema-validate.mjs`), generated schema tables and Codable payload types, and a frame codec. The Mac side is a translator rather than a second implementation. A `HostApiV1Gateway` validates v1 requests, turns `chat.send` and the approval answers into the existing v2 structs, and calls `MobileControlManager.handleInbound`. Every Mac-to-client frame then passes through one new choke point, `MobileControlManager.emit(_:)`. Frames for a v1 command go to the gateway, which converts them into v1 events. Frames for any other command go to the v2 server exactly as today.

**Tech Stack:** Swift 5.9, Network.framework (`NWListener`, `NWProtocolWebSocket`), swift-testing, Node 20 (the generator), JSON Schema 2020-12 subset.

**Spec:** [`docs/superpowers/specs/2026-11-03-host-api-design.md`](../specs/2026-11-03-host-api-design.md) (delivery phase 2, "Mac v1 adapter: handshake, auth, snapshots and chat; serve v2 unchanged"). Contract: Plan 1 [`2026-11-03-host-api-contract.md`](2026-11-03-host-api-contract.md) and `schema/host-api/v1/`.

## Global Constraints

- `apiVersion` is always `1`. A frame is at most 1,048,576 bytes. Lists default to 100 items, maximum 500. Error messages are at most 500 characters (spec "Wire envelope", "Errors").
- Payload objects are closed: unknown fields are rejected with `invalid_payload`. Unknown commands are refused with `unknown_command`, unsupported capabilities with `capability_unavailable` (spec "Wire envelope").
- Stable error codes only: `auth_failed`, `capability_unavailable`, `unknown_command`, `invalid_payload`, `not_found`, `busy`, `denied`, `desktop_only`, `rate_limited`, `host_unreachable`, `internal` (envelope `$defs/ErrorCode`).
- Error messages never contain tokens or file contents (spec "Errors").
- v2 stays on its existing `ws://3006`–`3015` range, unchanged. v1 uses default port **3016**, falling back to the next free port. Both run at once (spec "Ports and listeners").
- "Localhost development may use plaintext only when an explicit development environment flag is set; production builds refuse it" (spec "Security"). **This plan ships only that development listener:** plaintext, bound to `127.0.0.1`, started only in a DEBUG build with `LLMIDE_HOST_API_DEV=1`. TLS/WSS, certificate pinning and the web `Origin` allowlist are spec phase 6. Until then a real phone cannot reach v1, and nothing advertises it.
- Pairing PIN is one-use and rotates after a successful pair. Tokens are stored hashed. Pairing attempts are rate-limited with a lockout (spec "Security").
- No frame may carry a credential after pairing except `host.auth.token` and the token in `host.auth.revoke` (self-revoke).
- "Duplicated hand-written v1 types are not allowed" (spec "Schema and generated types"). Every v1 payload type is generated from `schema/host-api/v1/`.
- Mac boundary rules (root `CLAUDE.md`): MobileControl is sealed and may name no Chat type. Every new Mac file lives under `mac/Sources/LlmIdeMac/Features/MobileControl/`. Every new Mac test file that names a mobile-only type goes into `mobileTestExcludes` in `mac/Package.swift`.
- Mac tests always run with `LLMIDE_KEYCHAIN_BACKEND=memory`. Log frames only through `MobileLogPolicy` (type and size, never content).
- Conventional Commits, one concern per commit, on `main`, never pushed by the executor (the nightly job pushes). Every commit message ends with the attribution line the session gives.

## Decisions this plan makes (revisit if wrong)

1. **Loopback development listener only.** Without TLS a v1 listener on the LAN would be a second cleartext pairing surface, which the spec forbids. Phase 6 adds WSS on the same gateway, and nothing else here changes.
2. **v1 drops v2 progress labels.** A v2 `Output{done:false}` carries a status line ("Reading file…"), not reply text, and v1 has no progress event. Turning labels into `chat.delta` would corrupt the reply. The final reply is sent as one or more `chat.delta` (≤ 100,000 UTF-16 units each) followed by `chat.done`. A `chat.progress` event is a contract change for a later plan.
3. **`host.snapshot` serves only the `chat` topic.** A request naming `status`, `autotasks` or `loop` is refused with `capability_unavailable`, rather than answered with an invented shape. Those domains come with their own plans.
4. **v1 command ids are namespaced inside the Mac** as `h1.<session>.<client id>`. Two v1 clients, or a v1 client and the v2 phone, can never collide, and every place that resets v2 state on a v2 connect or disconnect can skip v1-owned work by prefix.
5. **A v1 connection that sends an `Origin` header is refused.** There is no web client yet. This stops a page in the developer's browser from grinding PINs against the development listener. The Origin allowlist is phase 6.

## File Structure

| File | Responsibility |
|---|---|
| `schema/host-api/v1/fixtures/invalid-cases.json` (create) | The invalid-fixture expectation map, moved out of `scripts/conformance-host-api.mjs` so the Node gate and the Swift tests read one table |
| `scripts/conformance-host-api.mjs` (modify) | Read the map from that file |
| `scripts/generate-host-api.mjs` (modify) | Also emit `HostApiSchemas.swift` (schema text) and `HostApiPayloads.swift` (Codable payload structs) |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiJSONValue.swift` (create) | Generic JSON value for opaque schema objects |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemaValidator.swift` (create) | Swift port of the Node subset validator |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemas.swift` (generated) | The envelope, command and event schemas as JSON text |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPayloads.swift` (generated) | One Codable struct per request, result and event payload |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift` (create) | Parse inbound requests; build response, event and error frames; validate outbound frames |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFixtures.swift` (create) | Test helper: read `schema/host-api/v1` from the repo |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiSchemaValidatorTests.swift` (create) | Validator against every fixture |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPayloadsTests.swift` (create) | Every command and event fixture round-trips through its generated struct |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFrameTests.swift` (create) | Codec behaviour |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobilePairedDeviceStore.swift` (modify) | Token-only `authenticate(token:)`, used by v1 |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Session.swift` (create) | Pure per-connection phase machine and command gate |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1CommandIds.swift` (create) | `h1.<session>.<id>` namespacing |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV2Translator.swift` (create) | Pure v2 frame → v1 events |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift` (create) | Sessions, auth, `rev`, command dispatch, capabilities, delivery |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Listener.swift` (create) | Loopback NWListener, development gate, Origin refusal, port fallback |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift` (modify) | `emit(_:)` choke point, extracted quick-chat history and clear, gateway wiring, v1-aware resets |
| `mac/Tests/LlmIdeMacTests/HostApiV1*Tests.swift` (create) | Mac tests per task |
| `mac/Package.swift` (modify) | Add the new test files to `mobileTestExcludes` |
| `scripts/mobile/verify-host-api-v1.swift` (create) | Manual loopback check against a running Mac app |
| `mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md`, `schema/host-api/v1/README.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | Docs and plan status |

---

### Task 1: Shared invalid-case map, Swift schema validator and generated schema tables

**Files:**
- Create: `schema/host-api/v1/fixtures/invalid-cases.json`
- Modify: `scripts/conformance-host-api.mjs:30-54`
- Modify: `scripts/generate-host-api.mjs`
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiJSONValue.swift`
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemaValidator.swift`
- Generated: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemas.swift`
- Create: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFixtures.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiSchemaValidatorTests.swift`

**Interfaces:**
- Produces: `HostApiSchemaValidator.validate(_ schema: Any, _ value: Any, defs: [String: Any], path: String = "") -> [HostApiSchemaValidator.Failure]`. `Failure` has `path: String` (Node's format: `.a.b[0]`, `(root)` for the root) and `message: String`.
- Produces: `HostApiSchemas.envelope: [String: Any]`, `HostApiSchemas.events: [String: Any]`, and `HostApiSchemas.request(for: HostApiCommand) -> [String: Any]` / `HostApiSchemas.result(for:)`. All are parsed once from generated JSON text.
- Produces (test helper): `HostApiFixtures.root: URL` (`schema/host-api/v1`), `HostApiFixtures.json(_ relative: String) throws -> Any`, `HostApiFixtures.names(_ dir: String) throws -> [String]`.

- [ ] **Step 1: Move the expectation map to JSON**

Create `schema/host-api/v1/fixtures/invalid-cases.json`, holding exactly the two maps that sit today in `scripts/conformance-host-api.mjs` lines 30–54:

```json
{
  "envelope": {
    "bad-command-shape.json": { "def": "Request", "at": ".command" },
    "bad-command-pattern.json": { "def": "Request", "at": ".command" },
    "bad-request-id.json": { "def": "Request", "at": ".id" },
    "missing-api-version.json": { "def": "Request", "at": ".apiVersion" },
    "unknown-field.json": { "def": "Request", "at": ".surprise" },
    "unknown-error-code.json": { "def": "ErrorFrame", "at": ".error.code" },
    "error-message-too-long.json": { "def": "ErrorFrame", "at": ".error.message" },
    "error-missing-error.json": { "def": "ErrorFrame", "at": ".error" },
    "response-missing-reply-to.json": { "def": "Response", "at": ".replyTo" },
    "response-missing-rev.json": { "def": "Response", "at": ".rev" },
    "event-missing-rev.json": { "def": "Event", "at": ".rev" }
  },
  "commands": {
    "chat.send.missing-text.json": { "command": "chat.send", "kind": "request", "at": ".text" },
    "chat.send.empty-text.json": { "command": "chat.send", "kind": "request", "at": ".text" },
    "chat.send.attachment-unknown-field.json": { "command": "chat.send", "kind": "request", "at": ".attachments[0].extra" },
    "chat.cancel.unknown-field.json": { "command": "chat.cancel", "kind": "request", "at": ".x" },
    "chat.snapshot.message-missing-content.json": { "command": "chat.snapshot", "kind": "result", "at": ".messages[0].content" },
    "toolApprovals.answer.bad-decision.json": { "command": "toolApprovals.answer", "kind": "request", "at": ".decision" }
  }
}
```

In `scripts/conformance-host-api.mjs`, replace the two `const INVALID_CASES = {…}` / `const INVALID_COMMAND_CASES = {…}` literals with:

```js
// The expectation maps live beside the fixtures so the Swift validator tests read the same table.
const { envelope: INVALID_CASES, commands: INVALID_COMMAND_CASES } = JSON.parse(
  readFileSync(join(DIR, "fixtures/invalid-cases.json"), "utf8"),
);
```

`DIR` is defined further down today. Move `const ROOT = …` and `const DIR = …` above this line. The fixture loops only list `fixtures/valid`, `fixtures/invalid`, `fixtures/invalid/commands`, `fixtures/commands` and `fixtures/events`, so a file directly under `fixtures/` is never read as a fixture.

Run: `make host-api-check`
Expected: `conformance-host-api: ok (12 commands, 7 events)`

- [ ] **Step 2: Write the test helper and the failing validator test**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFixtures.swift`:

```swift
import Foundation

/// Reads the Host API v1 contract straight from the repo, so these tests judge the same bytes
/// as `scripts/conformance-host-api.mjs`. Path: Tests/SharedProtocolTests/<file> → repo root is 5 levels up.
enum HostApiFixtures {
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("schema/host-api/v1", isDirectory: true)
    }()

    static func data(_ relative: String) throws -> Data {
        try Data(contentsOf: root.appendingPathComponent(relative))
    }

    static func json(_ relative: String) throws -> Any {
        try JSONSerialization.jsonObject(with: data(relative), options: [.fragmentsAllowed])
    }

    static func names(_ dir: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(dir).path)
            .filter { $0.hasSuffix(".json") }
            .sorted()
    }
}
```

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiSchemaValidatorTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

@Suite("HostApiSchemaValidator")
struct HostApiSchemaValidatorTests {
    private var defs: [String: Any] { HostApiSchemas.envelope["$defs"] as? [String: Any] ?? [:] }

    @Test("every valid frame fixture matches the envelope")
    func validFrames() throws {
        for name in try HostApiFixtures.names("fixtures/valid") {
            let value = try HostApiFixtures.json("fixtures/valid/\(name)")
            #expect(HostApiSchemaValidator.validate(HostApiSchemas.envelope, value, defs: defs).isEmpty, "\(name)")
        }
    }

    @Test("every invalid frame fixture fails its variant at the expected path and fails the root oneOf")
    func invalidFrames() throws {
        let cases = try #require((try HostApiFixtures.json("fixtures/invalid-cases.json") as? [String: Any])?["envelope"] as? [String: [String: String]])
        #expect(Set(cases.keys) == Set(try HostApiFixtures.names("fixtures/invalid")))
        for (name, c) in cases {
            let value = try HostApiFixtures.json("fixtures/invalid/\(name)")
            let variant = try #require(defs[c["def"]!], "\(name)")
            let failures = HostApiSchemaValidator.validate(variant, value, defs: defs)
            #expect(failures.contains { $0.path == c["at"] }, "\(name): \(failures)")
            #expect(!HostApiSchemaValidator.validate(HostApiSchemas.envelope, value, defs: defs).isEmpty, "\(name)")
        }
    }

    @Test("every command fixture matches its request or result schema")
    func commandFixtures() throws {
        for command in HostApiCommand.allCases {
            let request = try HostApiFixtures.json("fixtures/commands/\(command.rawValue).request.json")
            let result = try HostApiFixtures.json("fixtures/commands/\(command.rawValue).result.json")
            #expect(HostApiSchemaValidator.validate(HostApiSchemas.request(for: command), request, defs: defs).isEmpty, "\(command)")
            #expect(HostApiSchemaValidator.validate(HostApiSchemas.result(for: command), result, defs: defs).isEmpty, "\(command)")
        }
    }

    @Test("every invalid command fixture fails at the expected path")
    func invalidCommandFixtures() throws {
        let cases = try #require((try HostApiFixtures.json("fixtures/invalid-cases.json") as? [String: Any])?["commands"] as? [String: [String: String]])
        #expect(Set(cases.keys) == Set(try HostApiFixtures.names("fixtures/invalid/commands")))
        for (name, c) in cases {
            let command = try #require(HostApiCommand(rawValue: c["command"]!))
            let schema = c["kind"] == "request" ? HostApiSchemas.request(for: command) : HostApiSchemas.result(for: command)
            let failures = HostApiSchemaValidator.validate(schema, try HostApiFixtures.json("fixtures/invalid/commands/\(name)"), defs: defs)
            #expect(failures.contains { $0.path == c["at"] }, "\(name): \(failures)")
        }
    }

    @Test("JSON booleans are not integers, and integers are not booleans")
    func boolIntDistinction() {
        let intSchema: [String: Any] = ["type": "integer"]
        let boolSchema: [String: Any] = ["type": "boolean"]
        let parsed = try! JSONSerialization.jsonObject(with: Data(#"[true, 1, 1.5]"#.utf8)) as! [Any]
        #expect(!HostApiSchemaValidator.validate(intSchema, parsed[0], defs: [:]).isEmpty)
        #expect(HostApiSchemaValidator.validate(intSchema, parsed[1], defs: [:]).isEmpty)
        #expect(!HostApiSchemaValidator.validate(intSchema, parsed[2], defs: [:]).isEmpty)
        #expect(!HostApiSchemaValidator.validate(boolSchema, parsed[1], defs: [:]).isEmpty)
    }

    @Test("lengths count UTF-16 code units, like the Node validator")
    func utf16Lengths() {
        let schema: [String: Any] = ["type": "string", "maxLength": 1]
        #expect(!HostApiSchemaValidator.validate(schema, "😀", defs: [:]).isEmpty, "one emoji is two UTF-16 units")
        #expect(HostApiSchemaValidator.validate(schema, "é", defs: [:]).isEmpty)
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `make test-shared-protocol`
Expected: compile failure, `cannot find 'HostApiSchemaValidator' in scope` and `cannot find 'HostApiSchemas' in scope`.

- [ ] **Step 4: Write the JSON value, the validator and the schema generator**

`ios_app/SharedProtocol/Sources/SharedProtocol/HostApiJSONValue.swift`:

```swift
import Foundation

/// A JSON value, for schema objects the contract declares opaque (`host.snapshot` `snapshots`).
public enum HostApiJSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([HostApiJSONValue])
    case object([String: HostApiJSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int.self) { self = .int(i) }
        else if let d = try? c.decode(Double.self) { self = .double(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([HostApiJSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: HostApiJSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}
```

`ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemaValidator.swift`, a line-for-line port of `extension/routes/bus/schema-validate.mjs` without `x-format`, which the Host API schemas never use:

```swift
import Foundation

/// The JSON Schema subset the Host API uses, judged exactly like `extension/routes/bus/schema-validate.mjs`
/// (same keywords, same failure paths), so Swift and Node hosts accept and refuse the same frames.
/// Keywords: type, enum, const, required, properties, additionalProperties (bool | schema), items,
/// minItems, maxItems, minLength, maxLength (UTF-16 units, like JS), pattern, minimum, maximum, oneOf,
/// $ref (`#/$defs/Name`). Values are `JSONSerialization` output.
public enum HostApiSchemaValidator {
    public struct Failure: Equatable, Sendable, CustomStringConvertible {
        public let path: String
        public let message: String
        public var description: String { "\(path): \(message)" }
    }

    public static func validate(_ schema: Any, _ value: Any, defs: [String: Any], path: String = "") -> [Failure] {
        var out: [Failure] = []
        func bad(_ m: String) { out.append(Failure(path: path.isEmpty ? "(root)" : path, message: m)) }
        guard let schema = schema as? [String: Any] else { return out }
        if let ref = schema["$ref"] as? String {
            let name = ref.replacingOccurrences(of: "#/$defs/", with: "")
            guard let target = defs[name] else { bad("unresolved $ref \(ref)"); return out }
            return validate(target, value, defs: defs, path: path)
        }
        if let variants = schema["oneOf"] as? [Any] {
            let hits = variants.filter { validate($0, value, defs: defs, path: path).isEmpty }.count
            if hits != 1 { bad("must match exactly one variant (matched \(hits))") }
            return out
        }
        if let constant = schema["const"], !jsonEqual(value, constant) { bad("must equal \(constant)"); return out }
        if let options = schema["enum"] as? [Any], !options.contains(where: { jsonEqual(value, $0) }) {
            bad("must be one of \(options.map { "\($0)" }.joined(separator: ", "))"); return out
        }
        if let type = schema["type"] {
            let types = (type as? [String]) ?? [(type as? String) ?? ""]
            if !types.contains(where: { isType(value, $0) }) { bad("must be \(types.joined(separator: " or "))"); return out }
        }
        if let s = value as? String, !isNumber(value) {
            let n = s.utf16.count
            if let min = schema["minLength"] as? Int, n < min { bad("shorter than \(min)") }
            if let max = schema["maxLength"] as? Int, n > max { bad("longer than \(max)") }
            if let p = schema["pattern"] as? String, !matches(s, p) { bad("does not match the required pattern") }
        }
        if isNumber(value), let n = (value as? NSNumber)?.doubleValue {
            if let min = (schema["minimum"] as? NSNumber)?.doubleValue, n < min { bad("below \(min)") }
            if let max = (schema["maximum"] as? NSNumber)?.doubleValue, n > max { bad("above \(max)") }
        }
        if let a = value as? [Any] {
            if let min = schema["minItems"] as? Int, a.count < min { bad("fewer than \(min) items") }
            if let max = schema["maxItems"] as? Int, a.count > max { bad("more than \(max) items") }
            if let items = schema["items"] {
                for (i, v) in a.enumerated() { out += validate(items, v, defs: defs, path: "\(path)[\(i)]") }
            }
        }
        if let o = value as? [String: Any] {
            for k in (schema["required"] as? [String]) ?? [] where o[k] == nil {
                out.append(Failure(path: "\(path).\(k)", message: "is required"))
            }
            let props = (schema["properties"] as? [String: Any]) ?? [:]
            for k in o.keys.sorted() {
                let v = o[k]!
                if let p = props[k] { out += validate(p, v, defs: defs, path: "\(path).\(k)") }
                else if (schema["additionalProperties"] as? Bool) == false { out.append(Failure(path: "\(path).\(k)", message: "is not allowed")) }
                else if let ap = schema["additionalProperties"] as? [String: Any] { out += validate(ap, v, defs: defs, path: "\(path).\(k)") }
            }
        }
        return out
    }

    // MARK: - JSON kinds (JSONSerialization hands back NSNumber for both numbers and booleans)

    static func isBool(_ v: Any) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    static func isNumber(_ v: Any) -> Bool { v is NSNumber && !isBool(v) }

    static func isType(_ v: Any, _ t: String) -> Bool {
        switch t {
        case "null": return v is NSNull
        case "boolean": return isBool(v)
        case "integer":
            guard isNumber(v), let d = (v as? NSNumber)?.doubleValue else { return false }
            return d.isFinite && d.rounded() == d
        case "number": return isNumber(v) && ((v as? NSNumber)?.doubleValue.isFinite ?? false)
        case "string": return v is String
        case "array": return v is [Any]
        case "object": return v is [String: Any]
        default: return false
        }
    }

    static func jsonEqual(_ a: Any, _ b: Any) -> Bool {
        if isBool(a) || isBool(b) { return isBool(a) && isBool(b) && (a as! NSNumber).boolValue == (b as! NSNumber).boolValue }
        if isNumber(a), isNumber(b) { return (a as! NSNumber).doubleValue == (b as! NSNumber).doubleValue }
        if let x = a as? String, let y = b as? String { return x == y }
        if a is NSNull, b is NSNull { return true }
        return false
    }

    private static let regexCache = NSCache<NSString, NSRegularExpression>()

    /// JS `RegExp.test`: an unanchored search; Host API patterns anchor themselves with `^…$`.
    static func matches(_ s: String, _ pattern: String) -> Bool {
        let regex: NSRegularExpression
        if let cached = regexCache.object(forKey: pattern as NSString) { regex = cached }
        else {
            guard let built = try? NSRegularExpression(pattern: pattern) else { return false }
            regexCache.setObject(built, forKey: pattern as NSString)
            regex = built
        }
        return regex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}
```

In `scripts/generate-host-api.mjs`, after the `swift` template, add the schema-table output. The JSON goes into a Swift `##"…"##` raw string: `"#/$defs/…"` contains the `"#` sequence, which would end a single-hash raw string.

```js
const readSchema = (f) => JSON.parse(readFileSync(join(ROOT, "schema/host-api/v1", f), "utf8"));
const schemaTable = {
  envelope: readSchema("envelope.schema.json"),
  events: readSchema("events.schema.json"),
  commands: Object.fromEntries(names.map((n) => [n, { request: registry.commands[n].request, result: registry.commands[n].result }])),
};
const schemaText = JSON.stringify(schemaTable);
if (schemaText.includes('"##')) throw new Error('host-api: schema text contains "##, pick a longer Swift raw-string delimiter');

const swiftSchemas = `${header}
import Foundation

/// The Host API v1 schemas as parsed JSON, for \`HostApiSchemaValidator\`.
public enum HostApiSchemas {
    private static let table: [String: Any] = {
        let text = ##"${schemaText}"##
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
    }()

    public static var envelope: [String: Any] { table["envelope"] as? [String: Any] ?? [:] }
    public static var events: [String: Any] { table["events"] as? [String: Any] ?? [:] }

    public static func request(for command: HostApiCommand) -> [String: Any] {
        ((table["commands"] as? [String: Any])?[command.rawValue] as? [String: Any])?["request"] as? [String: Any] ?? [:]
    }

    public static func result(for command: HostApiCommand) -> [String: Any] {
        ((table["commands"] as? [String: Any])?[command.rawValue] as? [String: Any])?["result"] as? [String: Any] ?? [:]
    }
}
`;
```

Add `["ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemas.swift", swiftSchemas]` to the `outputs` array. Update the header comment at the top of the file so it lists the new output.

- [ ] **Step 5: Generate and run the tests**

Run: `node scripts/generate-host-api.mjs && node scripts/generate-host-api.mjs --check && make host-api-check && make test-shared-protocol`
Expected: `host-api: wrote 3 generated files`, no stale output, `conformance-host-api: ok (12 commands, 7 events)`, and all `HostApiSchemaValidator` tests pass, alongside the existing suites.

- [ ] **Step 6: Commit**

```bash
git add schema/host-api/v1/fixtures/invalid-cases.json scripts/conformance-host-api.mjs scripts/generate-host-api.mjs \
  ios_app/SharedProtocol/Sources/SharedProtocol/HostApiJSONValue.swift \
  ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemaValidator.swift \
  ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemas.swift \
  ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFixtures.swift \
  ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiSchemaValidatorTests.swift
git commit -m "feat(host-api): validate v1 frames in Swift against the shared schemas"
```

---

### Task 2: Generated Codable payload types

**Files:**
- Modify: `scripts/generate-host-api.mjs`
- Generated: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPayloads.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPayloadsTests.swift`

**Interfaces:**
- Consumes: `HostApiFixtures` (Task 1), `HostApiJSONValue` (Task 1).
- Produces: one `public struct … : Codable, Equatable, Sendable` per payload, with memberwise `public init` (optionals default to `nil`):
  - Requests and results: `HostApi<Pascal(command)>Request` / `…Result`, for example `HostApiChatSendRequest`, `HostApiHostAuthPairResult`, `HostApiToolApprovalsAnswerRequest`.
  - Events: `HostApi<Pascal(event)>Event`, for example `HostApiChatDeltaEvent`, `HostApiApprovalRequestEvent`, `HostApiToolApprovalRequestEvent`, `HostApiHostCapabilitiesEvent`.
  - Nested objects: parent name + `Pascal(property)`, plus `Item` for array elements, for example `HostApiChatSendRequestAttachmentsItem`, `HostApiApprovalRequestEventQuestionsItem`, `HostApiApprovalRequestEventQuestionsItemOptionsItem`, `HostApiChatSnapshotResultMessagesItem`.
  - Field types: `string` → `String`, `integer` → `Int`, `boolean` → `Bool`, an array → `[T]`, a map whose values are strings → `[String: String]`, a map of opaque objects → `[String: HostApiJSONValue]`. A field not listed in `required` is optional. Enum strings stay `String`; the validator enforces the allowed values.
  - `Pascal(name)` uppercases the first letter of each `.`-separated segment: `toolApprovals.answer` → `ToolApprovalsAnswer`.

- [ ] **Step 1: Write the failing round-trip test**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPayloadsTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

/// Every contract fixture decodes into its generated struct and re-encodes to the same JSON.
/// A schema change regenerates the structs, so a fixture that stops decoding is caught here.
@Suite("HostApiPayloads")
struct HostApiPayloadsTests {
    private func roundTrip<T: Codable & Equatable>(_ type: T.Type, _ relative: String) throws {
        let data = try HostApiFixtures.data(relative)
        let decoded = try JSONDecoder().decode(T.self, from: data)
        let reencoded = try JSONEncoder().encode(decoded)
        let a = try JSONSerialization.jsonObject(with: data) as! NSDictionary
        let b = try JSONSerialization.jsonObject(with: reencoded) as! NSDictionary
        #expect(a == b, "\(relative)")
    }

    @Test("every command fixture round-trips")
    func commands() throws {
        try roundTrip(HostApiHostHelloRequest.self, "fixtures/commands/host.hello.request.json")
        try roundTrip(HostApiHostHelloResult.self, "fixtures/commands/host.hello.result.json")
        try roundTrip(HostApiHostAuthPairRequest.self, "fixtures/commands/host.auth.pair.request.json")
        try roundTrip(HostApiHostAuthPairResult.self, "fixtures/commands/host.auth.pair.result.json")
        try roundTrip(HostApiHostAuthTokenRequest.self, "fixtures/commands/host.auth.token.request.json")
        try roundTrip(HostApiHostAuthTokenResult.self, "fixtures/commands/host.auth.token.result.json")
        try roundTrip(HostApiHostAuthRevokeRequest.self, "fixtures/commands/host.auth.revoke.request.json")
        try roundTrip(HostApiHostAuthRevokeResult.self, "fixtures/commands/host.auth.revoke.result.json")
        try roundTrip(HostApiHostPingRequest.self, "fixtures/commands/host.ping.request.json")
        try roundTrip(HostApiHostPingResult.self, "fixtures/commands/host.ping.result.json")
        try roundTrip(HostApiHostSnapshotRequest.self, "fixtures/commands/host.snapshot.request.json")
        try roundTrip(HostApiHostSnapshotResult.self, "fixtures/commands/host.snapshot.result.json")
        try roundTrip(HostApiChatSnapshotRequest.self, "fixtures/commands/chat.snapshot.request.json")
        try roundTrip(HostApiChatSnapshotResult.self, "fixtures/commands/chat.snapshot.result.json")
        try roundTrip(HostApiChatSendRequest.self, "fixtures/commands/chat.send.request.json")
        try roundTrip(HostApiChatSendResult.self, "fixtures/commands/chat.send.result.json")
        try roundTrip(HostApiChatCancelRequest.self, "fixtures/commands/chat.cancel.request.json")
        try roundTrip(HostApiChatCancelResult.self, "fixtures/commands/chat.cancel.result.json")
        try roundTrip(HostApiChatHistoryClearRequest.self, "fixtures/commands/chat.history.clear.request.json")
        try roundTrip(HostApiChatHistoryClearResult.self, "fixtures/commands/chat.history.clear.result.json")
        try roundTrip(HostApiApprovalsAnswerRequest.self, "fixtures/commands/approvals.answer.request.json")
        try roundTrip(HostApiApprovalsAnswerResult.self, "fixtures/commands/approvals.answer.result.json")
        try roundTrip(HostApiToolApprovalsAnswerRequest.self, "fixtures/commands/toolApprovals.answer.request.json")
        try roundTrip(HostApiToolApprovalsAnswerResult.self, "fixtures/commands/toolApprovals.answer.result.json")
    }

    @Test("every event fixture payload round-trips")
    func events() throws {
        func payload<T: Codable & Equatable>(_ type: T.Type, _ name: String) throws {
            let frame = try HostApiFixtures.json("fixtures/events/\(name).json") as! [String: Any]
            let data = try JSONSerialization.data(withJSONObject: frame["payload"]!)
            let decoded = try JSONDecoder().decode(T.self, from: data)
            let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as! NSDictionary
            #expect(back == (frame["payload"] as! NSDictionary), name)
        }
        try payload(HostApiChatDeltaEvent.self, "chat.delta")
        try payload(HostApiChatDoneEvent.self, "chat.done")
        try payload(HostApiChatErrorEvent.self, "chat.error")
        try payload(HostApiApprovalRequestEvent.self, "approval.request")
        try payload(HostApiApprovalClearedEvent.self, "approval.cleared")
        try payload(HostApiToolApprovalRequestEvent.self, "toolApproval.request")
        try payload(HostApiHostCapabilitiesEvent.self, "host.capabilities")
    }

    @Test("optional fields are omitted, not encoded as null")
    func optionalsOmitted() throws {
        let data = try JSONEncoder().encode(HostApiChatSendResult(accepted: true))
        #expect(String(decoding: data, as: UTF8.self) == #"{"accepted":true}"#)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `make test-shared-protocol`
Expected: compile failure, `cannot find 'HostApiHostHelloRequest' in scope`.

- [ ] **Step 3: Write the payload generator**

Add to `scripts/generate-host-api.mjs`, after `swiftSchemas`:

```js
// One Codable struct per payload schema. The mapping is deliberately narrow: a schema shape it does not
// know fails generation loudly instead of producing a lossy type.
const pascal = (name) => name.split(".").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
const structs = [];

function swiftType(schema, name) {
  switch (schema.type) {
    case "string": return "String";
    case "integer": return "Int";
    case "boolean": return "Bool";
    case "array": return `[${swiftType(schema.items, `${name}Item`)}]`;
    case "object": {
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const v = schema.additionalProperties;
        if (v.type === "object" && !v.properties) return "[String: HostApiJSONValue]";
        return `[String: ${swiftType(v, `${name}Value`)}]`;
      }
      emitStruct(name, schema);
      return name;
    }
    default:
      throw new Error(`host-api: no Swift type for ${name}: ${JSON.stringify(schema)}`);
  }
}

function emitStruct(name, schema) {
  const required = new Set(schema.required || []);
  const fields = Object.keys(schema.properties || {}).sort().map((prop) => {
    if (!/^[a-z][A-Za-z0-9]*$/.test(prop)) throw new Error(`host-api: ${name}.${prop} is not a Swift identifier`);
    const t = swiftType(schema.properties[prop], `${name}${prop[0].toUpperCase()}${prop.slice(1)}`);
    return { prop, type: required.has(prop) ? t : `${t}?`, optional: !required.has(prop) };
  });
  const lines = [`public struct ${name}: Codable, Equatable, Sendable {`];
  for (const f of fields) lines.push(`    public var ${f.prop}: ${f.type}`);
  const params = fields.map((f) => `${f.prop}: ${f.type}${f.optional ? " = nil" : ""}`).join(", ");
  lines.push("", `    public init(${params}) {`);
  for (const f of fields) lines.push(`        self.${f.prop} = ${f.prop}`);
  lines.push("    }", "}");
  structs.push(lines.join("\n"));
}

for (const n of names) {
  swiftType(registry.commands[n].request, `HostApi${pascal(n)}Request`);
  swiftType(registry.commands[n].result, `HostApi${pascal(n)}Result`);
}
for (const variant of schemaTable.events.oneOf) {
  const event = variant.properties.command.const;
  swiftType(variant.properties.payload, `HostApi${pascal(event)}Event`);
}

const swiftPayloads = `${header}
import Foundation

${structs.join("\n\n")}
`;
```

Add `["ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPayloads.swift", swiftPayloads]` to `outputs`. `names` is sorted and `oneOf` is in file order, so the output is deterministic and `--check` stays a byte comparison.

- [ ] **Step 4: Generate and run the tests**

Run: `node scripts/generate-host-api.mjs && node scripts/generate-host-api.mjs --check && make test-shared-protocol`
Expected: `host-api: wrote 4 generated files`. The `HostApiPayloads` suite passes, all three tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-host-api.mjs ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPayloads.swift \
  ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPayloadsTests.swift
git commit -m "feat(host-api): generate Swift payload types from the v1 schemas"
```

---

### Task 3: Frame codec

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFrameTests.swift`

**Interfaces:**
- Consumes: `HostApiSchemaValidator`, `HostApiSchemas`, `HostApiCommand`, `HostApi.limits` (Tasks 1–2, Plan 1).
- Produces:
  - `public struct HostApiInboundRequest: Sendable, Equatable { public let id: String; public let command: HostApiCommand; public let payload: Data }`. `payload` is the request's `payload` object re-serialized, ready for `JSONDecoder` into the generated request struct.
  - `public struct HostApiRejection: Error, Sendable, Equatable { public let replyTo: String?; public let code: String; public let message: String }`.
  - `public enum HostApiFrame`:
    - `static func parseRequest(_ data: Data) -> Result<HostApiInboundRequest, HostApiRejection>`
    - `static func response<R: Encodable>(replyTo: String, command: HostApiCommand, result: R, rev: Int, now: Date = Date()) throws -> Data`, which throws `HostApiRejection` with code `internal` when the result does not match its schema
    - `static func event<P: Encodable>(_ command: String, payload: P, rev: Int, replyTo: String? = nil, now: Date = Date()) throws -> Data`
    - `static func error(replyTo: String?, code: String, message: String, retryable: Bool, retryAfterMs: Int? = nil, hint: String? = nil, rev: Int, now: Date = Date()) -> Data`, which never throws: the message is clamped and an unknown code becomes `internal`
    - `static func clamp(_ s: String, maxUTF16: Int) -> String`

- [ ] **Step 1: Write the failing test**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFrameTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

@Suite("HostApiFrame")
struct HostApiFrameTests {
    private func frame(_ json: String) -> Data { Data(json.utf8) }
    private var defs: [String: Any] { HostApiSchemas.envelope["$defs"] as? [String: Any] ?? [:] }
    private func object(_ d: Data) -> [String: Any] { try! JSONSerialization.jsonObject(with: d) as! [String: Any] }

    @Test("a valid request parses into command and payload")
    func parsesRequest() throws {
        let r = try HostApiFrame.parseRequest(HostApiFixtures.data("fixtures/valid/request.json")).get()
        #expect(r.command.rawValue == (object(try HostApiFixtures.data("fixtures/valid/request.json"))["command"] as! String))
    }

    @Test("oversize, non-JSON, bad envelope, unknown command and bad payload are each refused with their code")
    func refusals() {
        let big = Data(repeating: 0x20, count: HostApi.limits.maxFrameBytes + 1)
        #expect(HostApiFrame.parseRequest(big).failure?.code == "invalid_payload")
        #expect(HostApiFrame.parseRequest(frame("not json")).failure?.code == "invalid_payload")
        let unknownField = frame(#"{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1,"surprise":true}"#)
        #expect(HostApiFrame.parseRequest(unknownField).failure == HostApiRejection(replyTo: "c-1", code: "invalid_payload", message: "The frame does not match the Host API envelope (.surprise)."))
        let unknown = frame(#"{"apiVersion":1,"id":"c-2","type":"request","command":"files.write","payload":{},"ts":1}"#)
        #expect(HostApiFrame.parseRequest(unknown).failure?.code == "unknown_command")
        #expect(HostApiFrame.parseRequest(unknown).failure?.replyTo == "c-2")
        let badPayload = frame(#"{"apiVersion":1,"id":"c-3","type":"request","command":"chat.send","payload":{"text":""},"ts":1}"#)
        #expect(HostApiFrame.parseRequest(badPayload).failure == HostApiRejection(replyTo: "c-3", code: "invalid_payload", message: "The payload does not match chat.send (.text)."))
    }

    @Test("a response is a valid Response frame and a bad result is refused, not sent")
    func response() throws {
        let data = try HostApiFrame.response(replyTo: "c-1", command: .hostPing, result: HostApiHostPingResult(), rev: 3)
        #expect(HostApiSchemaValidator.validate(defs["Response"]!, object(data), defs: defs).isEmpty)
        #expect(object(data)["rev"] as? Int == 3)
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.response(replyTo: "c-1", command: .hostAuthPair,
                                          result: HostApiHostAuthPairResult(capabilities: [], token: "short"), rev: 0)
        }
    }

    @Test("an event is a valid Event frame")
    func event() throws {
        let data = try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: "hi"), rev: 9, replyTo: "c-7")
        #expect(HostApiSchemaValidator.validate(defs["Event"]!, object(data), defs: defs).isEmpty)
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: String(repeating: "x", count: 100_001)), rev: 1)
        }
    }

    @Test("an error frame is always valid: long messages are clamped, unknown codes become internal")
    func errorFrames() {
        let long = HostApiFrame.error(replyTo: "c-1", code: "denied", message: String(repeating: "é", count: 900), retryable: false, rev: 1)
        #expect(HostApiSchemaValidator.validate(defs["ErrorFrame"]!, object(long), defs: defs).isEmpty)
        let odd = HostApiFrame.error(replyTo: nil, code: "nope", message: "", retryable: true, retryAfterMs: 500, rev: 1)
        let err = object(odd)["error"] as! [String: Any]
        #expect(err["code"] as? String == "internal")
        #expect((err["details"] as? [String: Any])?["retryAfterMs"] as? Int == 500)
        #expect(HostApiSchemaValidator.validate(defs["ErrorFrame"]!, object(odd), defs: defs).isEmpty)
    }

    @Test("clamp cuts on character boundaries and keeps UTF-16 length within the cap")
    func clamp() {
        #expect(HostApiFrame.clamp("😀😀😀", maxUTF16: 5) == "😀😀")
        #expect(HostApiFrame.clamp("abc", maxUTF16: 10) == "abc")
    }
}

private extension Result {
    var failure: Failure? { if case .failure(let f) = self { return f }; return nil }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `make test-shared-protocol`
Expected: compile failure, `cannot find 'HostApiFrame' in scope`.

- [ ] **Step 3: Write the codec**

Before writing, check the `ErrorFrame` and `Error` definitions in `schema/host-api/v1/envelope.schema.json`. Build the error object to match them field for field, adding `details` only when `retryAfterMs` or `hint` is present. Then create `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift`:

```swift
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
```

The test uses the same `.surprise` and `.text` paths that `fixtures/invalid-cases.json` records for those fixtures. Keep the two message templates exactly as written above.

- [ ] **Step 4: Run the tests**

Run: `make test-shared-protocol`
Expected: the `HostApiFrame` suite passes, all six tests, alongside the earlier suites.

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiFrameTests.swift
git commit -m "feat(host-api): parse and build v1 frames with outbound validation"
```

---

### Task 4: Token-only device authentication

`host.auth.pair` carries only a PIN and `host.auth.token` only a token, so the v1 host must find a device by its token, which v2 never needed. The v2 lookup by `deviceId` stays as it is.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobilePairedDeviceStore.swift:80-99`
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1DeviceStoreTests.swift`
- Modify: `mac/Package.swift` (`mobileTestExcludes`)

**Interfaces:**
- Produces: `MobilePairedDeviceStore.authenticate(token: String, now: Date = Date()) -> String?`. It returns the device id whose live token this is, applies the same idle expiry and `lastSeenAt` stamp as `authenticate(deviceId:token:now:)`, and compares every record's hash in constant time.
- Produces: `static let hostApiDevicePrefix = "h1-"`. v1 pairings are issued with `deviceId = "h1-" + UUID().uuidString`, so a v1 device is visible in Settings and revocable like any phone.

- [ ] **Step 1: Write the failing test**

`mac/Tests/LlmIdeMacTests/HostApiV1DeviceStoreTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMacLib

@Suite("Host API v1 token-only auth", .serialized)
struct HostApiV1DeviceStoreTests {
    private func store() -> MobilePairedDeviceStore {
        MobilePairedDeviceStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("h1-devices-\(UUID().uuidString)/devices.json"))
    }

    @Test("a token finds exactly its own device")
    func findsDevice() {
        let s = store()
        let a = s.issueToken(deviceId: "h1-A", name: "web")
        let b = s.issueToken(deviceId: "h1-B", name: "ios")
        #expect(s.authenticate(token: a) == "h1-A")
        #expect(s.authenticate(token: b) == "h1-B")
        #expect(s.authenticate(token: a + "x") == nil)
        #expect(s.authenticate(token: "") == nil)
    }

    @Test("revoking or re-pairing retires the old token")
    func revocation() {
        let s = store()
        let old = s.issueToken(deviceId: "h1-A", name: "web")
        _ = s.issueToken(deviceId: "h1-A", name: "web")
        #expect(s.authenticate(token: old) == nil)
        let live = s.issueToken(deviceId: "h1-C", name: "web")
        s.revoke(id: "h1-C")
        #expect(s.authenticate(token: live) == nil)
    }

    @Test("an idle token expires like the device-id path")
    func expiry() {
        let s = store()
        let t = s.issueToken(deviceId: "h1-A", name: "web", now: Date(timeIntervalSince1970: 0))
        #expect(s.authenticate(token: t, now: Date(timeIntervalSince1970: MobilePairedDeviceStore.maxIdleInterval + 1)) == nil)
        #expect(s.device(id: "h1-A") == nil, "an expired device is forgotten")
    }
}
```

Add `"HostApiV1DeviceStoreTests.swift",` to `mobileTestExcludes` in `mac/Package.swift` (the list at line 242).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1DeviceStoreTests > /tmp/h1-t4.log 2>&1; tail -20 /tmp/h1-t4.log`
Expected: compile failure, `no exact matches in call to instance method 'authenticate'`.

- [ ] **Step 3: Implement**

Insert after `authenticate(deviceId:token:now:)`:

```swift
    /// Host API v1 device ids are host-minted with this prefix (v1 pairing carries no device id).
    static let hostApiDevicePrefix = "h1-"

    /// The device whose live token `token` is, or nil. Every record's hash is compared, in constant
    /// time, so the lookup does not leak which position matched. Same idle expiry and `lastSeenAt` stamp
    /// as `authenticate(deviceId:token:now:)`.
    func authenticate(token: String, now: Date = Date()) -> String? {
        guard !token.isEmpty else { return nil }
        let candidate = Self.hash(token)
        lock.lock(); defer { lock.unlock() }
        var match: Int?
        for (i, d) in devices.enumerated() where Self.constantTimeEqual(d.tokenHash, candidate) { match = i }
        guard let index = match else { return nil }
        if now.timeIntervalSince(devices[index].lastSeenAt) > Self.maxIdleInterval {
            devices.remove(at: index)
            persistLocked()
            return nil
        }
        devices[index].lastSeenAt = now
        persistLocked()
        return devices[index].id
    }
```

- [ ] **Step 4: Run the tests**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter 'HostApiV1DeviceStoreTests|MobilePairedDevice' > /tmp/h1-t4.log 2>&1; grep -E 'passed|failed' /tmp/h1-t4.log | tail -5`
Expected: every test in the three suites passes.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobilePairedDeviceStore.swift mac/Tests/LlmIdeMacTests/HostApiV1DeviceStoreTests.swift mac/Package.swift
git commit -m "feat(mac): look up a paired device by its token for Host API v1"
```

---

### Task 5: Per-connection session gate and command-id namespacing

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Session.swift`
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1CommandIds.swift`
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1SessionTests.swift`
- Modify: `mac/Package.swift` (`mobileTestExcludes`)

**Interfaces:**
- Consumes: `HostApiCommand` (SharedProtocol).
- Produces:
  - `struct HostApiV1Session` with `enum Phase: Equatable { case awaitingHello, awaitingAuth(clientName: String), authed(deviceId: String, clientName: String) }`, `private(set) var phase`, `mutating func greeted(clientName: String)`, `mutating func authenticated(deviceId: String)`, and `func gate(_ command: HostApiCommand, served: Set<String>) -> Gate`, where `enum Gate: Equatable { case allow, refuse(code: String, message: String) }`.
  - `static func helloRefusal(apiVersions: [Int]) -> String?`, which returns a refusal message when the client does not speak version 1.
  - `enum HostApiV1CommandIds` with `static func internalId(session: Int, external: String) -> String` (`"h1.<session>.<external>"`), `static func parse(_ id: String) -> (session: Int, external: String)?` and `static func isV1(_ id: String) -> Bool`.

- [ ] **Step 1: Write the failing test**

`mac/Tests/LlmIdeMacTests/HostApiV1SessionTests.swift`:

```swift
import Testing
import SharedProtocol
@testable import LlmIdeMacLib

@Suite("HostApiV1Session")
struct HostApiV1SessionTests {
    let all: Set<String> = ["host", "chat", "approvals", "tool_approvals"]

    @Test("before hello only host.hello is allowed")
    func awaitingHello() {
        let s = HostApiV1Session()
        #expect(s.gate(.hostHello, served: all) == .allow)
        for c in HostApiCommand.allCases where c != .hostHello {
            #expect(s.gate(c, served: all) == .refuse(code: "auth_failed", message: "Send host.hello first."), "\(c)")
        }
    }

    @Test("after hello only pairing, token auth and ping are allowed")
    func awaitingAuth() {
        var s = HostApiV1Session()
        s.greeted(clientName: "web")
        for c in [HostApiCommand.hostAuthPair, .hostAuthToken, .hostPing] { #expect(s.gate(c, served: all) == .allow) }
        #expect(s.gate(.hostHello, served: all) == .refuse(code: "denied", message: "This connection already sent host.hello."))
        #expect(s.gate(.chatSend, served: all) == .refuse(code: "auth_failed", message: "Pair or authenticate first."))
        #expect(s.gate(.hostAuthRevoke, served: all) == .refuse(code: "auth_failed", message: "Pair or authenticate first."))
    }

    @Test("once authenticated, auth commands are refused and others need their capability")
    func authed() {
        var s = HostApiV1Session()
        s.greeted(clientName: "web")
        s.authenticated(deviceId: "h1-A")
        #expect(s.phase == .authed(deviceId: "h1-A", clientName: "web"))
        #expect(s.gate(.hostAuthPair, served: all) == .refuse(code: "denied", message: "This connection is already authenticated."))
        #expect(s.gate(.hostAuthToken, served: all) == .refuse(code: "denied", message: "This connection is already authenticated."))
        #expect(s.gate(.hostAuthRevoke, served: all) == .allow)
        #expect(s.gate(.chatSend, served: ["host"]) == .refuse(code: "capability_unavailable", message: "This Mac does not serve chat right now."))
        #expect(s.gate(.toolApprovalsAnswer, served: ["host", "chat", "approvals"])
                == .refuse(code: "capability_unavailable", message: "This Mac does not serve tool_approvals right now."))
        #expect(s.gate(.chatSend, served: all) == .allow)
    }

    @Test("hello must offer API version 1")
    func helloVersions() {
        #expect(HostApiV1Session.helloRefusal(apiVersions: [1, 2]) == nil)
        #expect(HostApiV1Session.helloRefusal(apiVersions: [2]) == "This Mac speaks Host API version 1 only.")
    }

    @Test("internal command ids round-trip and never look like a v2 UUID")
    func commandIds() {
        let id = HostApiV1CommandIds.internalId(session: 7, external: "c-1")
        #expect(id == "h1.7.c-1")
        #expect(HostApiV1CommandIds.parse(id)! == (7, "c-1"))
        #expect(HostApiV1CommandIds.parse("h1.7.c.1")! == (7, "c.1"))
        #expect(HostApiV1CommandIds.parse("9D2F6A1E-0000-0000-0000-000000000000") == nil)
        #expect(HostApiV1CommandIds.parse("h1.x.c-1") == nil)
        #expect(!HostApiV1CommandIds.isV1("llmide_chat_history"))
    }
}
```

Add `"HostApiV1SessionTests.swift",` to `mobileTestExcludes`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1SessionTests > /tmp/h1-t5.log 2>&1; tail -20 /tmp/h1-t5.log`
Expected: compile failure, `cannot find 'HostApiV1Session' in scope`.

- [ ] **Step 3: Implement**

`HostApiV1CommandIds.swift`:

```swift
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
```

`HostApiV1Session.swift`:

```swift
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
```

- [ ] **Step 4: Run the tests**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1SessionTests > /tmp/h1-t5.log 2>&1; grep -E 'passed|failed' /tmp/h1-t5.log | tail -3`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Session.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1CommandIds.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1SessionTests.swift mac/Package.swift
git commit -m "feat(mac): gate Host API v1 commands by connection phase and capability"
```

---

### Task 6: v2 → v1 translator

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV2Translator.swift`
- Test: `mac/Tests/LlmIdeMacTests/HostApiV2TranslatorTests.swift`
- Modify: `mac/Package.swift` (`mobileTestExcludes`)

**Interfaces:**
- Consumes: the SharedProtocol v2 types `Output`, `OutputPayload`, `CommandError`, `ApprovalRequest`, `ApprovalCleared`, `ToolApprovalRequest`, `MobileProtocol.Tag`; the generated `HostApi*Event` structs (Task 2); `HostApiFrame.clamp` (Task 3).
- Produces:
  - `struct HostApiV1EventOut: Equatable { let command: String; let payload: Data }`
  - `struct HostApiV1Translation: Equatable { let events: [HostApiV1EventOut]; let terminal: Bool }`
  - `enum HostApiV2Translator { static func translate(_ v2Frame: Data, external commandId: String, cancelledByClient: Bool) -> HostApiV1Translation }`

Rules (the spec event list; decision 2 above):

| v2 frame (`type`) | v1 events | terminal |
|---|---|---|
| `output`, `done:false` | none (progress label dropped) | no |
| `output`, `done:true` | `chat.delta` for each ≤ 100,000-unit chunk of `stream` (none if empty), then `chat.done{requestId}` | yes |
| `error`, `cancelledByClient` | `chat.done{requestId, stopReason:"cancelled"}` | yes |
| `error` | `chat.error{message (≤ 2,000), retryable:false}` | yes |
| `approval_request` | `approval.request{requestId, commandId, questions}`, header ≤ 12, at most 10 questions and 20 options, text clamped | no |
| `approval_cleared` | `approval.cleared{requestId, commandId, reason ≤ 500}` | no |
| `tool_approval_request` | `toolApproval.request` with every string clamped to its schema cap; `truncated` is true if v2 said so or anything was clamped | no |
| anything else | none | no |

In every v1 payload, `requestId`/`commandId` that name the chat turn are the client's **external** id.

- [ ] **Step 1: Write the failing test**

`mac/Tests/LlmIdeMacTests/HostApiV2TranslatorTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol
@testable import LlmIdeMacLib

@Suite("HostApiV2Translator")
struct HostApiV2TranslatorTests {
    private func v2<T: Encodable>(_ m: T) -> Data { try! JSONEncoder().encode(m) }
    private func decode<T: Decodable>(_ t: T.Type, _ e: HostApiV1EventOut) -> T { try! JSONDecoder().decode(T.self, from: e.payload) }

    @Test("progress labels are dropped; the final reply is delta then done")
    func output() {
        let progress = HostApiV2Translator.translate(v2(Output(commandId: "h1.1.c-1", payload: OutputPayload(stream: "Reading…", done: false))),
                                                     external: "c-1", cancelledByClient: false)
        #expect(progress == HostApiV1Translation(events: [], terminal: false))
        let done = HostApiV2Translator.translate(v2(Output(commandId: "h1.1.c-1", payload: OutputPayload(stream: "Hello", done: true))),
                                                 external: "c-1", cancelledByClient: false)
        #expect(done.terminal)
        #expect(done.events.map(\.command) == ["chat.delta", "chat.done"])
        #expect(decode(HostApiChatDeltaEvent.self, done.events[0]).text == "Hello")
        #expect(decode(HostApiChatDoneEvent.self, done.events[1]) == HostApiChatDoneEvent(requestId: "c-1"))
    }

    @Test("a long reply is split into schema-sized deltas")
    func chunking() {
        let reply = String(repeating: "a", count: 250_000)
        let t = HostApiV2Translator.translate(v2(Output(commandId: "x", payload: OutputPayload(stream: reply, done: true))),
                                              external: "c-1", cancelledByClient: false)
        let deltas = t.events.filter { $0.command == "chat.delta" }.map { decode(HostApiChatDeltaEvent.self, $0).text }
        #expect(deltas.map(\.utf16.count) == [100_000, 100_000, 50_000])
        #expect(deltas.joined() == reply)
    }

    @Test("an error ends the turn as chat.error, or as a cancelled done when the client cancelled")
    func errors() {
        let e = HostApiV2Translator.translate(v2(CommandError(commandId: "x", message: "Engine busy")), external: "c-1", cancelledByClient: false)
        #expect(e.terminal && e.events.map(\.command) == ["chat.error"])
        #expect(decode(HostApiChatErrorEvent.self, e.events[0]) == HostApiChatErrorEvent(message: "Engine busy", retryable: false))
        let c = HostApiV2Translator.translate(v2(CommandError(commandId: "x", message: "Cancelled")), external: "c-1", cancelledByClient: true)
        #expect(decode(HostApiChatDoneEvent.self, c.events[0]) == HostApiChatDoneEvent(requestId: "c-1", stopReason: "cancelled"))
    }

    @Test("approval request and cleared map with the external command id and clamped text")
    func approvals() {
        let q = MobileApprovalQuestion(question: "Pick", header: "A very long header", options: [MobileApprovalOption(label: "Yes", description: nil)], multiSelect: false)
        let r = HostApiV2Translator.translate(v2(ApprovalRequest(commandId: "h1.1.c-1", requestId: "r-1", questions: [q])), external: "c-1", cancelledByClient: false)
        let ev = decode(HostApiApprovalRequestEvent.self, r.events[0])
        #expect(r.events.map(\.command) == ["approval.request"] && !r.terminal)
        #expect(ev.commandId == "c-1" && ev.requestId == "r-1" && ev.questions[0].header == "A very long ")
        let cl = HostApiV2Translator.translate(v2(ApprovalCleared(commandId: "h1.1.c-1", requestId: "r-1", reason: "done")), external: "c-1", cancelledByClient: false)
        #expect(decode(HostApiApprovalClearedEvent.self, cl.events[0]) == HostApiApprovalClearedEvent(commandId: "c-1", reason: "done", requestId: "r-1"))
    }

    @Test("a tool request is clamped and then marked truncated")
    func toolApproval() {
        let req = ToolApprovalRequest(commandId: "h1.1.c-1", requestId: "r-2", toolName: "Edit", summary: nil, filePath: "a.swift",
                                      oldString: String(repeating: "o", count: 30_000), newString: "n", contentPreview: nil,
                                      command: nil, truncated: false, replaceAll: nil, overwrites: nil)
        let t = HostApiV2Translator.translate(v2(req), external: "c-1", cancelledByClient: false)
        let ev = decode(HostApiToolApprovalRequestEvent.self, t.events[0])
        #expect(ev.truncated && ev.oldString?.utf16.count == 20_000 && ev.commandId == "c-1")
    }

    @Test("frames v1 has no event for are dropped")
    func unknown() {
        #expect(HostApiV2Translator.translate(Data(#"{"type":"mac_capabilities","capabilities":[]}"#.utf8), external: "c-1", cancelledByClient: false).events.isEmpty)
    }
}
```

Before writing the test, open `ToolApprovalMessages.swift` at line 36 and match the `ToolApprovalRequest` initializer's labels and order exactly; fix the call in this test if they differ. Add `"HostApiV2TranslatorTests.swift",` to `mobileTestExcludes`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV2TranslatorTests > /tmp/h1-t6.log 2>&1; tail -20 /tmp/h1-t6.log`
Expected: compile failure, `cannot find 'HostApiV2Translator' in scope`.

- [ ] **Step 3: Implement**

`HostApiV2Translator.swift`:

```swift
import Foundation
import SharedProtocol

struct HostApiV1EventOut: Equatable {
    let command: String
    let payload: Data
}

struct HostApiV1Translation: Equatable {
    let events: [HostApiV1EventOut]
    /// The v1 command is over: the gateway stops routing frames for it.
    let terminal: Bool
}

/// Turns one v2 Mac → phone frame (for a v1-owned command) into the v1 events the spec defines. Pure.
enum HostApiV2Translator {
    static let deltaChunk = 100_000

    static func translate(_ v2Frame: Data, external commandId: String, cancelledByClient: Bool) -> HostApiV1Translation {
        struct Envelope: Decodable { let type: String }
        let decoder = JSONDecoder()
        guard let type = (try? decoder.decode(Envelope.self, from: v2Frame))?.type else { return .init(events: [], terminal: false) }
        switch type {
        case MobileProtocol.Tag.output:
            guard let o = try? decoder.decode(Output.self, from: v2Frame), o.payload.done else { return .init(events: [], terminal: false) }
            let deltas = chunks(o.payload.stream ?? "").map { event("chat.delta", HostApiChatDeltaEvent(text: $0)) }
            return .init(events: deltas + [event("chat.done", HostApiChatDoneEvent(requestId: commandId))], terminal: true)
        case MobileProtocol.Tag.error:
            if cancelledByClient {
                return .init(events: [event("chat.done", HostApiChatDoneEvent(requestId: commandId, stopReason: "cancelled"))], terminal: true)
            }
            let message = (try? decoder.decode(CommandError.self, from: v2Frame))?.message ?? ""
            let text = HostApiFrame.clamp(message.isEmpty ? "The Mac could not finish this request." : message, maxUTF16: 2_000)
            return .init(events: [event("chat.error", HostApiChatErrorEvent(message: text, retryable: false))], terminal: true)
        case MobileProtocol.Tag.approvalRequest:
            guard let r = try? decoder.decode(ApprovalRequest.self, from: v2Frame), !r.questions.isEmpty else { return .init(events: [], terminal: false) }
            let questions = r.questions.prefix(10).map { q in
                HostApiApprovalRequestEventQuestionsItem(
                    header: q.header.map { HostApiFrame.clamp($0, maxUTF16: 12) },
                    multiSelect: q.multiSelect,
                    options: q.options.prefix(20).map {
                        HostApiApprovalRequestEventQuestionsItemOptionsItem(
                            description: $0.description.map { HostApiFrame.clamp($0, maxUTF16: 500) },
                            label: HostApiFrame.clamp($0.label, maxUTF16: 200))
                    },
                    question: HostApiFrame.clamp(q.question, maxUTF16: 2_000))
            }
            return .init(events: [event("approval.request", HostApiApprovalRequestEvent(
                commandId: commandId, questions: Array(questions), requestId: HostApiFrame.clamp(r.requestId, maxUTF16: 64)))], terminal: false)
        case MobileProtocol.Tag.approvalCleared:
            guard let c = try? decoder.decode(ApprovalCleared.self, from: v2Frame) else { return .init(events: [], terminal: false) }
            return .init(events: [event("approval.cleared", HostApiApprovalClearedEvent(
                commandId: commandId, reason: c.reason.map { HostApiFrame.clamp($0, maxUTF16: 500) },
                requestId: HostApiFrame.clamp(c.requestId, maxUTF16: 64)))], terminal: false)
        case MobileProtocol.Tag.toolApprovalRequest:
            guard let t = try? decoder.decode(ToolApprovalRequest.self, from: v2Frame) else { return .init(events: [], terminal: false) }
            var clamped = false
            func cap(_ s: String?, _ n: Int) -> String? {
                guard let s else { return nil }
                let c = HostApiFrame.clamp(s, maxUTF16: n)
                if c != s { clamped = true }
                return c
            }
            let ev = HostApiToolApprovalRequestEvent(
                command: cap(t.command, 2_000), commandId: commandId, contentPreview: cap(t.contentPreview, 20_000),
                filePath: cap(t.filePath, 2_000), newString: cap(t.newString, 20_000), oldString: cap(t.oldString, 20_000),
                overwrites: t.overwrites, replaceAll: t.replaceAll, requestId: HostApiFrame.clamp(t.requestId, maxUTF16: 64),
                summary: cap(t.summary, 2_000), toolName: cap(t.toolName, 200) ?? "tool", truncated: false)
            var out = ev
            out.truncated = t.truncated || clamped
            return .init(events: [event("toolApproval.request", out)], terminal: false)
        default:
            return .init(events: [], terminal: false)
        }
    }

    /// `text` cut into pieces of at most `deltaChunk` UTF-16 units, on Character boundaries.
    static func chunks(_ text: String) -> [String] {
        var out: [String] = [], current = "", n = 0
        for ch in text {
            let w = String(ch).utf16.count
            if n + w > deltaChunk { out.append(current); current = ""; n = 0 }
            current.append(ch); n += w
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    private static func event<P: Encodable>(_ command: String, _ payload: P) -> HostApiV1EventOut {
        HostApiV1EventOut(command: command, payload: (try? JSONEncoder().encode(payload)) ?? Data("{}".utf8))
    }
}
```

The generated memberwise initializers list fields in **sorted** order (Task 2). If a label order above does not match what `HostApiPayloads.swift` generated, follow the generated file. Assign `truncated` after the clamps: `ev` is built with `truncated: false` and then set, because `clamped` is only known once every `cap` call has run.

- [ ] **Step 4: Run the tests**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV2TranslatorTests > /tmp/h1-t6.log 2>&1; grep -E 'passed|failed' /tmp/h1-t6.log | tail -3`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV2Translator.swift \
  mac/Tests/LlmIdeMacTests/HostApiV2TranslatorTests.swift mac/Package.swift
git commit -m "feat(mac): translate v2 chat and approval frames into Host API v1 events"
```

---

### Task 7: Gateway and the manager's outbound choke point

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift`
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift`
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1GatewayTests.swift`
- Modify: `mac/Package.swift` (`mobileTestExcludes`)

**Interfaces:**
- Consumes: Tasks 3–6; `PairingThrottle`; `PhoneTierTable.verdict(for:desktop:)`; the SharedProtocol v2 structs `LlmIdeChat`, `ChatFileText`, `ApprovalAnswer`, `ToolApprovalAnswer`.
- Produces:
  - `enum HostApiQuickChatHistory: Equatable { case lines([MobileChatLine]), unavailable(String) }` and `enum HostApiQuickChatClear: Equatable { case cleared, denied(String), unavailable(String) }`
  - `@MainActor final class HostApiV1Gateway` with:
    - `struct Dependencies` (closures, all main-actor): `hostName: () -> String`, `validatePin: (String) -> Bool`, `pinConsumed: () -> Void`, `issueToken: (_ deviceId: String, _ name: String) -> String`, `authenticate: (_ token: String) -> String?`, `revoke: (_ deviceId: String) -> Void`, `capabilities: () -> [String]`, `tierRefusal: (_ v2Type: String) -> String?`, `forward: (_ v2Frame: Data) -> Void`, `history: (_ limit: Int) async -> HostApiQuickChatHistory`, `clear: () async -> HostApiQuickChatClear`, `cancel: (_ internalCommandId: String) -> Void`, `log: (String) -> Void`
    - `init(dependencies:)`, `var send: (_ session: Int, _ frame: Data) -> Void`, `var close: (_ session: Int) -> Void`
    - `func opened(session: Int, peer: String)`, `func receive(session: Int, data: Data) async`, `func closed(session: Int)`
    - `func owns(_ internalCommandId: String) -> Bool`, `func deliver(v2Frame: Data, internalCommandId: String)`
    - `func capabilitiesChanged()`, `func disconnect(deviceId: String)`, `private(set) var rev: Int`
    - `static func capabilities(chatInstalled: Bool, toolApprovals: Bool) -> [String]`
  - `MobileControlManager.emit(_ message: some Encodable) async`, the only path for Mac → client frames.

Command behaviour (session gate first, then):

| Command | Behaviour |
|---|---|
| `host.hello` | Refused `capability_unavailable` (with `helloRefusal`'s text) unless the client offers version 1. Otherwise mark greeted and reply `{hostName, hostKind:"mac", apiVersion:1, apiVersions:[1], capabilities, protocolVersion: MobileProtocol.protocolVersion, requiresAuth:true}`. `certificateFingerprint` is omitted because there is no TLS in this plan. |
| `host.auth.pair` | `PairingThrottle.decision(for: peer)` first. `wait`/`lockedOut`/`serverThrottled` → `auth_failed`, retryable, with `retryAfterMs`. A wrong PIN → `auth_failed`, not retryable, and `registerFailure`. A right PIN → `issueToken("h1-" + UUID, clientName)`, `pinConsumed()`, authenticated, reply `{token, capabilities}`. |
| `host.auth.token` | `authenticate(token)` → authenticated and reply `{capabilities}`. Otherwise `auth_failed`, not retryable, and `registerFailure`. |
| `host.auth.revoke` | Only the session's own token: `authenticate(token) == session deviceId` → `revoke`, reply `{revoked:true}`, then close the session. Otherwise `denied`. |
| `host.ping` | Reply `{}`. |
| `host.snapshot` | Any topic other than `chat` → `capability_unavailable`, hint "Served topics: chat". Otherwise reply `{snapshots:{chat:{messages:[…]}}}` from `history(100)`. |
| `chat.snapshot` | `history(limit ?? 100)`. `.lines` → `{messages}` (content clamped to 100,000, at most 500). `.unavailable(m)` → `capability_unavailable`. |
| `chat.send` | `tierRefusal("llmide_chat")` → `denied`. Otherwise own `h1.<session>.<id>`, `forward(LlmIdeChat(commandId: internal, text:, files: attachments as ChatFileText))`, reply `{accepted:true, requestId:id}`. Events follow through `deliver`. |
| `chat.cancel` | For every chat command this session owns: mark it cancelled and `cancel(internal)`. Reply `{cancelled: <owned any>}`. |
| `chat.history.clear` | `clear()`. `.cleared` → `{cleared:true}`; `.denied(m)` → `denied`; `.unavailable(m)` → `capability_unavailable`. |
| `approvals.answer` | `payload.commandId` must be a command this session owns, else `not_found`. `tierRefusal("approval_answer")` → `denied`. `forward(ApprovalAnswer(internal, requestId, answers))`, reply `{accepted:true}`. |
| `toolApprovals.answer` | Same ownership and tier check (`tool_approval_answer`). `forward(ToolApprovalAnswer(internal, requestId, allow: decision == "allow_once"))`, reply `{accepted:true}`. |

The gateway keeps `rev`: one host-wide counter, incremented for every event, and stamped on every frame. Sessions are capped at 4; a fifth connection gets an `internal` error and is closed. A session that is not authenticated within 10 s is closed. When a session closes, every command it owns is cancelled and its frames are dropped from then on.

- [ ] **Step 1: Write the failing gateway test**

`mac/Tests/LlmIdeMacTests/HostApiV1GatewayTests.swift`. The test drives the gateway with fake dependencies and inspects frames as JSON:

```swift
import Testing
import Foundation
import SharedProtocol
@testable import LlmIdeMacLib

@MainActor
@Suite("HostApiV1Gateway", .serialized)
final class HostApiV1GatewayTests {
    var sent: [(Int, [String: Any])] = []
    var closed: [Int] = []
    var forwarded: [[String: Any]] = []
    var cancelled: [String] = []
    var pin = "123456"
    var tokens: [String: String] = [:]   // token -> deviceId
    var pinRotations = 0
    var toolApprovals = false

    func gateway() -> HostApiV1Gateway {
        let g = HostApiV1Gateway(dependencies: .init(
            hostName: { "Test Mac" },
            validatePin: { [unowned self] in $0 == self.pin },
            pinConsumed: { [unowned self] in self.pinRotations += 1; self.pin = "654321" },
            issueToken: { [unowned self] id, _ in let t = "tok-\(id)-0123456789"; self.tokens[t] = id; return t },
            authenticate: { [unowned self] in self.tokens[$0] },
            revoke: { [unowned self] id in self.tokens = self.tokens.filter { $0.value != id } },
            capabilities: { [unowned self] in HostApiV1Gateway.capabilities(chatInstalled: true, toolApprovals: self.toolApprovals) },
            tierRefusal: { _ in nil },
            forward: { [unowned self] in self.forwarded.append(try! JSONSerialization.jsonObject(with: $0) as! [String: Any]) },
            history: { _ in .lines([MobileChatLine(role: "user", content: "hi")]) },
            clear: { .cleared },
            cancel: { [unowned self] in self.cancelled.append($0) },
            log: { _ in }))
        g.send = { [unowned self] s, d in self.sent.append((s, try! JSONSerialization.jsonObject(with: d) as! [String: Any])) }
        g.close = { [unowned self] in self.closed.append($0) }
        return g
    }

    func request(_ id: String, _ command: String, _ payload: String = "{}") -> Data {
        Data(#"{"apiVersion":1,"id":"\#(id)","type":"request","command":"\#(command)","payload":\#(payload),"ts":1}"#.utf8)
    }
    var last: [String: Any] { sent.last!.1 }
    var lastError: String? { (last["error"] as? [String: Any])?["code"] as? String }

    func paired(_ g: HostApiV1Gateway, session: Int = 1) async {
        g.opened(session: session, peer: "127.0.0.1")
        await g.receive(session: session, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: session, data: request("c-p", "host.auth.pair", #"{"pin":"\#(pin)"}"#))
    }

    @Test("hello, pair, then the PIN rotates and the token re-authenticates a new connection")
    func pairing() async {
        let g = gateway()
        await paired(g)
        let result = last["result"] as! [String: Any]
        #expect(last["replyTo"] as? String == "c-p" && (result["token"] as! String).hasPrefix("tok-h1-"))
        #expect(pinRotations == 1)
        g.opened(session: 2, peer: "127.0.0.1")
        await g.receive(session: 2, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: 2, data: request("c-t", "host.auth.token", #"{"token":"\#(result["token"] as! String)"}"#))
        #expect(last["type"] as? String == "response")
    }

    @Test("a wrong PIN is auth_failed and not retryable; commands before auth are refused")
    func wrongPin() async {
        let g = gateway()
        g.opened(session: 1, peer: "127.0.0.1")
        await g.receive(session: 1, data: request("c-1", "chat.snapshot"))
        #expect(lastError == "auth_failed")
        await g.receive(session: 1, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: 1, data: request("c-p", "host.auth.pair", #"{"pin":"000000"}"#))
        #expect(lastError == "auth_failed" && (last["error"] as! [String: Any])["retryable"] as? Bool == false)
    }

    @Test("chat.send forwards a namespaced v2 chat and routes its reply back as delta + done")
    func chatSend() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"hello","attachments":[{"name":"a.md","text":"x"}]}"#))
        #expect((last["result"] as! [String: Any])["requestId"] as? String == "c-9")
        #expect(forwarded.last?["commandId"] as? String == "h1.1.c-9")
        #expect((forwarded.last?["files"] as? [[String: Any]])?.first?["name"] as? String == "a.md")
        #expect(g.owns("h1.1.c-9"))
        g.deliver(v2Frame: try! JSONEncoder().encode(Output(commandId: "h1.1.c-9", payload: OutputPayload(stream: "hi", done: true))),
                  internalCommandId: "h1.1.c-9")
        #expect(sent.suffix(2).map { $0.1["command"] as? String } == ["chat.delta", "chat.done"])
        #expect(!g.owns("h1.1.c-9"), "a terminal frame ends ownership")
        let revs = sent.compactMap { $0.1["rev"] as? Int }
        #expect(revs == revs.sorted(), "rev is monotonic")
    }

    @Test("cancel ends the turn as a cancelled done")
    func cancel() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"hello"}"#))
        await g.receive(session: 1, data: request("c-x", "chat.cancel"))
        #expect(cancelled == ["h1.1.c-9"] && (last["result"] as! [String: Any])["cancelled"] as? Bool == true)
        g.deliver(v2Frame: try! JSONEncoder().encode(CommandError(commandId: "h1.1.c-9", message: "Cancelled")), internalCommandId: "h1.1.c-9")
        #expect((last["payload"] as! [String: Any])["stopReason"] as? String == "cancelled")
    }

    @Test("an approval answer for a command this session does not own is not_found")
    func approvalOwnership() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-a", "approvals.answer", #"{"requestId":"r","commandId":"someone-else","answers":{}}"#))
        #expect(lastError == "not_found" && forwarded.isEmpty)
    }

    @Test("tool approvals need their capability; a capability change pushes host.capabilities")
    func capabilities() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-t", "toolApprovals.answer", #"{"requestId":"r","commandId":"c-9","decision":"deny"}"#))
        #expect(lastError == "capability_unavailable")
        toolApprovals = true
        g.capabilitiesChanged()
        #expect(last["command"] as? String == "host.capabilities")
        #expect(((last["payload"] as! [String: Any])["capabilities"] as! [String]).contains("tool_approvals"))
    }

    @Test("snapshot serves chat only")
    func snapshot() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-s", "host.snapshot", #"{"topics":["chat"]}"#))
        #expect(((last["result"] as! [String: Any])["snapshots"] as! [String: Any])["chat"] != nil)
        await g.receive(session: 1, data: request("c-s2", "host.snapshot", #"{"topics":["chat","loop"]}"#))
        #expect(lastError == "capability_unavailable")
    }

    @Test("self-revoke works only with the session's own token, then closes it")
    func revoke() async {
        let g = gateway()
        await paired(g)
        let token = tokens.first!.key
        await g.receive(session: 1, data: request("c-r", "host.auth.revoke", #"{"token":"tok-h1-other-0123456789"}"#))
        #expect(lastError == "denied")
        await g.receive(session: 1, data: request("c-r2", "host.auth.revoke", #"{"token":"\#(token)"}"#))
        #expect((last["result"] as! [String: Any])["revoked"] as? Bool == true && tokens.isEmpty && closed == [1])
    }

    @Test("closing a session cancels its commands and drops later frames")
    func closing() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"hello"}"#))
        g.closed(session: 1)
        #expect(cancelled == ["h1.1.c-9"])
        let before = sent.count
        g.deliver(v2Frame: try! JSONEncoder().encode(Output(commandId: "h1.1.c-9", payload: OutputPayload(stream: "late", done: true))), internalCommandId: "h1.1.c-9")
        #expect(sent.count == before)
    }
}
```

Add `"HostApiV1GatewayTests.swift",` to `mobileTestExcludes`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1GatewayTests > /tmp/h1-t7.log 2>&1; tail -20 /tmp/h1-t7.log`
Expected: compile failure, `cannot find 'HostApiV1Gateway' in scope`.

- [ ] **Step 3: Write the gateway**

`HostApiV1Gateway.swift`:

```swift
import Foundation
import SharedProtocol

enum HostApiQuickChatHistory: Equatable { case lines([MobileChatLine]), unavailable(String) }
enum HostApiQuickChatClear: Equatable { case cleared, denied(String), unavailable(String) }

/// Host API v1 on the Mac: per-connection sessions, auth, `rev`, and the 12 commands. Chat and approvals
/// run through the manager's existing v2 handlers (`forward`), so v1 inherits the tier gate, Phone Access
/// switches and approval rules; their replies come back through `deliver` and `HostApiV2Translator`.
@MainActor
final class HostApiV1Gateway {
    struct Dependencies {
        var hostName: () -> String
        var validatePin: (String) -> Bool
        var pinConsumed: () -> Void
        var issueToken: (_ deviceId: String, _ name: String) -> String
        var authenticate: (_ token: String) -> String?
        var revoke: (_ deviceId: String) -> Void
        var capabilities: () -> [String]
        var tierRefusal: (_ v2Type: String) -> String?
        var forward: (_ v2Frame: Data) -> Void
        var history: (_ limit: Int) async -> HostApiQuickChatHistory
        var clear: () async -> HostApiQuickChatClear
        var cancel: (_ internalCommandId: String) -> Void
        var log: (String) -> Void
    }

    static let maxSessions = 4
    static let authDeadline: TimeInterval = 10

    var send: (_ session: Int, _ frame: Data) -> Void = { _, _ in }
    var close: (_ session: Int) -> Void = { _ in }
    private(set) var rev = 0

    private let deps: Dependencies
    private var sessions: [Int: (state: HostApiV1Session, peer: String)] = [:]
    /// internal command id → (session, external id, cancelled by the client)
    private var owned: [String: (session: Int, external: String, cancelled: Bool)] = [:]
    private var throttle = PairingThrottle()
    private var lastCapabilities: [String] = []

    init(dependencies: Dependencies) { self.deps = dependencies }

    static func capabilities(chatInstalled: Bool, toolApprovals: Bool) -> [String] {
        var caps = ["host"]
        if chatInstalled { caps += ["chat", "approvals"] }
        if chatInstalled && toolApprovals { caps.append("tool_approvals") }
        return caps
    }

    // MARK: - Connections

    func opened(session: Int, peer: String) {
        guard sessions.count < Self.maxSessions else {
            send(session, HostApiFrame.error(replyTo: nil, code: "busy", message: "This Mac already has the maximum number of Host API connections.", retryable: true, rev: rev))
            close(session)
            return
        }
        sessions[session] = (HostApiV1Session(), peer)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.authDeadline * 1_000_000_000))
            guard let self, let s = self.sessions[session], s.state.deviceId == nil else { return }
            self.deps.log("Host API v1 connection \(session) did not authenticate in time — closing")
            self.close(session)
            self.closed(session: session)
        }
    }

    func closed(session: Int) {
        sessions.removeValue(forKey: session)
        for (id, o) in owned where o.session == session {
            owned.removeValue(forKey: id)
            deps.cancel(id)
        }
    }

    func disconnect(deviceId: String) {
        for (id, s) in sessions where s.state.deviceId == deviceId {
            send(id, HostApiFrame.error(replyTo: nil, code: "auth_failed", message: "This device was removed on the Mac.", retryable: false, rev: rev))
            close(id)
            closed(session: id)
        }
    }

    func owns(_ internalCommandId: String) -> Bool { owned[internalCommandId] != nil }

    // MARK: - Outbound (from MobileControlManager.emit)

    func deliver(v2Frame: Data, internalCommandId: String) {
        guard let o = owned[internalCommandId], sessions[o.session] != nil else { return }
        let t = HostApiV2Translator.translate(v2Frame, external: o.external, cancelledByClient: o.cancelled)
        for e in t.events { sendEvent(o.session, e.command, raw: e.payload, replyTo: o.external) }
        if t.terminal { owned.removeValue(forKey: internalCommandId) }
    }

    func capabilitiesChanged() {
        let caps = deps.capabilities()
        guard caps != lastCapabilities else { return }
        lastCapabilities = caps
        for (id, s) in sessions where s.state.deviceId != nil {
            sendEvent(id, "host.capabilities", payload: HostApiHostCapabilitiesEvent(capabilities: caps))
        }
    }

    // MARK: - Inbound

    func receive(session: Int, data: Data) async {
        guard let entry = sessions[session] else { return }
        let request: HostApiInboundRequest
        switch HostApiFrame.parseRequest(data) {
        case .success(let r): request = r
        case .failure(let f): return fail(session, f.replyTo, f.code, f.message)
        }
        let served = Set(deps.capabilities())
        if case .refuse(let code, let message) = entry.state.gate(request.command, served: served) {
            return fail(session, request.id, code, message)
        }
        let decoder = JSONDecoder()
        func payload<T: Decodable>(_ t: T.Type) -> T? { try? decoder.decode(T.self, from: request.payload) }
        let id = request.id

        switch request.command {
        case .hostHello:
            guard let p = payload(HostApiHostHelloRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.hello payload.") }
            if let why = HostApiV1Session.helloRefusal(apiVersions: p.apiVersions) { return fail(session, id, "capability_unavailable", why) }
            sessions[session]?.state.greeted(clientName: p.clientName)
            respond(session, id, .hostHello, HostApiHostHelloResult(
                apiVersion: 1, apiVersions: [1], capabilities: deps.capabilities(),
                hostKind: "mac", hostName: HostApiFrame.clamp(deps.hostName(), maxUTF16: 120),
                protocolVersion: MobileProtocol.protocolVersion, requiresAuth: true))
        case .hostAuthPair:
            guard let p = payload(HostApiHostAuthPairRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.auth.pair payload.") }
            switch throttle.decision(for: entry.peer, now: Date()) {
            case .allow: break
            case .wait(let s): return fail(session, id, "auth_failed", "Too many attempts — wait a moment and try again.", retryable: true, retryAfterMs: Int(s * 1000))
            case .lockedOut: return fail(session, id, "auth_failed", "Too many wrong PINs — locked out for 15 minutes.", retryable: true, retryAfterMs: 15 * 60 * 1000)
            case .serverThrottled: return fail(session, id, "auth_failed", "This Mac is refusing new pairings for a few minutes.", retryable: true, retryAfterMs: 60_000)
            }
            guard deps.validatePin(p.pin) else {
                throttle.registerFailure(host: entry.peer, now: Date())
                return fail(session, id, "auth_failed", "Wrong PIN.")
            }
            throttle.registerSuccess(host: entry.peer)
            guard case .awaitingAuth(let name) = entry.state.phase else { return }
            let deviceId = MobilePairedDeviceStore.hostApiDevicePrefix + UUID().uuidString
            let token = deps.issueToken(deviceId, name)
            deps.pinConsumed()
            sessions[session]?.state.authenticated(deviceId: deviceId)
            respond(session, id, .hostAuthPair, HostApiHostAuthPairResult(capabilities: deps.capabilities(), token: token))
        case .hostAuthToken:
            guard let p = payload(HostApiHostAuthTokenRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.auth.token payload.") }
            guard let deviceId = deps.authenticate(p.token) else {
                throttle.registerFailure(host: entry.peer, now: Date())
                return fail(session, id, "auth_failed", "This device is no longer paired with this Mac — pair again with the current PIN.")
            }
            throttle.registerSuccess(host: entry.peer)
            sessions[session]?.state.authenticated(deviceId: deviceId)
            respond(session, id, .hostAuthToken, HostApiHostAuthTokenResult(capabilities: deps.capabilities()))
        case .hostAuthRevoke:
            guard let p = payload(HostApiHostAuthRevokeRequest.self), let mine = entry.state.deviceId,
                  deps.authenticate(p.token) == mine else { return fail(session, id, "denied", "Only this connection's own token can be revoked here.") }
            deps.revoke(mine)
            respond(session, id, .hostAuthRevoke, HostApiHostAuthRevokeResult(revoked: true))
            close(session)
            closed(session: session)
        case .hostPing:
            respond(session, id, .hostPing, HostApiHostPingResult())
        case .hostSnapshot:
            guard let p = payload(HostApiHostSnapshotRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.snapshot payload.") }
            guard p.topics.allSatisfy({ $0 == "chat" }) else {
                return fail(session, id, "capability_unavailable", "This Mac serves only the chat snapshot.", hint: "Served topics: chat")
            }
            switch await deps.history(HostApi.limits.defaultListItems) {
            case .unavailable(let m): fail(session, id, "capability_unavailable", m)
            case .lines(let lines):
                let messages = Self.messages(lines, limit: HostApi.limits.defaultListItems)
                    .map { HostApiJSONValue.object(["role": .string($0.role), "content": .string($0.content)]) }
                respond(session, id, .hostSnapshot, HostApiHostSnapshotResult(snapshots: ["chat": .object(["messages": .array(messages)])]))
            }
        case .chatSnapshot:
            let limit = payload(HostApiChatSnapshotRequest.self)?.limit ?? HostApi.limits.defaultListItems
            switch await deps.history(limit) {
            case .unavailable(let m): fail(session, id, "capability_unavailable", m)
            case .lines(let lines): respond(session, id, .chatSnapshot, HostApiChatSnapshotResult(messages: Self.messages(lines, limit: limit)))
            }
        case .chatSend:
            guard let p = payload(HostApiChatSendRequest.self) else { return fail(session, id, "invalid_payload", "Bad chat.send payload.") }
            if let why = deps.tierRefusal(MobileProtocol.Tag.llmIdeChat) { return fail(session, id, "denied", why) }
            let internalId = HostApiV1CommandIds.internalId(session: session, external: id)
            owned[internalId] = (session, id, false)
            let files = (p.attachments ?? []).map { ChatFileText(name: $0.name, text: $0.text) }
            respond(session, id, .chatSend, HostApiChatSendResult(accepted: true, requestId: id))
            deps.forward((try? JSONEncoder().encode(LlmIdeChat(commandId: internalId, text: p.text, files: files))) ?? Data())
        case .chatCancel:
            let mine = owned.filter { $0.value.session == session }
            for (internalId, _) in mine {
                owned[internalId]?.cancelled = true
                deps.cancel(internalId)
            }
            respond(session, id, .chatCancel, HostApiChatCancelResult(cancelled: !mine.isEmpty))
        case .chatHistoryClear:
            switch await deps.clear() {
            case .cleared: respond(session, id, .chatHistoryClear, HostApiChatHistoryClearResult(cleared: true))
            case .denied(let m): fail(session, id, "denied", m)
            case .unavailable(let m): fail(session, id, "capability_unavailable", m)
            }
        case .approvalsAnswer:
            guard let p = payload(HostApiApprovalsAnswerRequest.self) else { return fail(session, id, "invalid_payload", "Bad approvals.answer payload.") }
            let internalId = HostApiV1CommandIds.internalId(session: session, external: p.commandId)
            guard owned[internalId] != nil else { return fail(session, id, "not_found", "That chat request is not open on this connection.") }
            if let why = deps.tierRefusal(MobileProtocol.Tag.approvalAnswer) { return fail(session, id, "denied", why) }
            respond(session, id, .approvalsAnswer, HostApiApprovalsAnswerResult(accepted: true))
            deps.forward((try? JSONEncoder().encode(ApprovalAnswer(commandId: internalId, requestId: p.requestId, answers: p.answers))) ?? Data())
        case .toolApprovalsAnswer:
            guard let p = payload(HostApiToolApprovalsAnswerRequest.self) else { return fail(session, id, "invalid_payload", "Bad toolApprovals.answer payload.") }
            let internalId = HostApiV1CommandIds.internalId(session: session, external: p.commandId)
            guard owned[internalId] != nil else { return fail(session, id, "not_found", "That chat request is not open on this connection.") }
            if let why = deps.tierRefusal(MobileProtocol.Tag.toolApprovalAnswer) { return fail(session, id, "denied", why) }
            respond(session, id, .toolApprovalsAnswer, HostApiToolApprovalsAnswerResult(accepted: true))
            deps.forward((try? JSONEncoder().encode(ToolApprovalAnswer(commandId: internalId, requestId: p.requestId,
                                                                        allow: p.decision == "allow_once"))) ?? Data())
        }
    }

    // MARK: - Helpers

    static func messages(_ lines: [MobileChatLine], limit: Int) -> [HostApiChatSnapshotResultMessagesItem] {
        lines.filter { $0.role == "user" || $0.role == "assistant" }
            .suffix(min(max(limit, 1), HostApi.limits.maxListItems))
            .map { HostApiChatSnapshotResultMessagesItem(content: HostApiFrame.clamp($0.content, maxUTF16: 100_000), role: $0.role) }
    }

    private func respond<R: Encodable>(_ session: Int, _ replyTo: String, _ command: HostApiCommand, _ result: R) {
        do { send(session, try HostApiFrame.response(replyTo: replyTo, command: command, result: result, rev: rev)) }
        catch {
            deps.log("Host API v1 \(command.rawValue) result failed validation — sent internal")
            fail(session, replyTo, "internal", "The Mac could not build this reply.")
        }
    }

    private func sendEvent<P: Encodable>(_ session: Int, _ command: String, payload: P, replyTo: String? = nil) {
        rev += 1
        do { send(session, try HostApiFrame.event(command, payload: payload, rev: rev, replyTo: replyTo)) }
        catch { deps.log("Host API v1 \(command) event failed validation — dropped") }
    }

    private func sendEvent(_ session: Int, _ command: String, raw: Data, replyTo: String?) {
        sendEvent(session, command, payload: (try? JSONDecoder().decode(HostApiJSONValue.self, from: raw)) ?? .object([:]), replyTo: replyTo)
    }

    private func fail(_ session: Int, _ replyTo: String?, _ code: String, _ message: String,
                      retryable: Bool = false, retryAfterMs: Int? = nil, hint: String? = nil) {
        send(session, HostApiFrame.error(replyTo: replyTo, code: code, message: message, retryable: retryable,
                                         retryAfterMs: retryAfterMs, hint: hint, rev: rev))
    }
}
```

Check two things against the real sources before compiling. First, the `LlmIdeChat` initializer at `ios_app/SharedProtocol/Sources/SharedProtocol/LlmIdeChatMessages.swift:39` takes `history`/`images`/`files` with defaults; pass only `files:`. Second, every generated initializer's label order must match `HostApiPayloads.swift`. Follow the generated file where they differ.

- [ ] **Step 4: Run the gateway tests**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1GatewayTests > /tmp/h1-t7.log 2>&1; grep -E 'passed|failed' /tmp/h1-t7.log | tail -3`
Expected: 9 tests pass.

- [ ] **Step 5: Wire the manager**

In `MobileControlManager.swift`:

1. **Choke point.** Add `emit(_:)` next to `reply(_:)`. Make `reply` call it, so the "server not running" log stays on the v2 path only:

```swift
    /// The one path for Mac → client frames. A frame for a Host API v1 command (`h1.` command id) goes
    /// to the v1 gateway, which translates it; everything else goes to the v2 phone exactly as before.
    func emit(_ message: some Encodable) async {
        if let gateway = hostApiGateway, let data = try? JSONEncoder().encode(message),
           let cid = Self.commandId(in: data), HostApiV1CommandIds.isV1(cid) {
            gateway.deliver(v2Frame: data, internalCommandId: cid)
            return
        }
        await server?.send(message)
    }

    nonisolated static func commandId(in frame: Data) -> String? {
        struct Envelope: Decodable { let commandId: String? }
        return (try? JSONDecoder().decode(Envelope.self, from: frame))?.commandId
    }

    func reply(_ message: some Encodable) {
        if server == nil && hostApiGateway == nil {
            append(.stderr, "Mobile reply dropped — WebSocket server not running")
            return
        }
        Task { await self.emit(message) }
    }
```

Then replace **every** `server?.send(` in the file with `emit(`. Run `grep -n 'server?.send(' MobileControlManager.swift`; Plan 2 counts 27 sites today, and afterwards the count must be 0. The only direct `server.send` left in the class is the one inside `emit`. Also check `MobileControlManager+BridgeHost.swift` (`grep -n 'server?.send\|server\.send'`) and route any hits through `emit` too.

2. **v2 resets skip v1 work.** In `onMobileClientDisconnected` (line 1384), and in every other function that clears or bulk-cancels `mobileInflightTasks`, `mobileCancelledCommandIds`, `pendingPhoneApprovals` or `truncatedToolRequestIds` on a v2 connect or disconnect (find them with `grep -n 'mobileInflightTasks\.\(removeAll\|keys\|values\)\|pendingPhoneApprovals\.removeAll\|truncatedToolRequestIds\.removeAll'`), restrict the operation to ids where `!HostApiV1CommandIds.isV1(id)`. For example:

```swift
        let v2Inflight = mobileInflightTasks.filter { !HostApiV1CommandIds.isV1($0.key) }
        mobileCancelledCommandIds.formUnion(v2Inflight.keys)
        for entry in v2Inflight.values { entry.task.cancel() }
        for key in v2Inflight.keys { mobileInflightTasks.removeValue(forKey: key) }
```

`truncatedToolRequestIds` is keyed by request id, not command id. Clear only the request ids whose `pendingPhoneApprovals` entry is v2-owned, and leave the rest.

3. **Extract quick-chat history and clear** from `handleLlmIdeChatHistoryList` / `handleLlmIdeChatHistoryClear` (lines 1745–1804) into two internal functions. Make the v2 handlers thin wrappers that keep their exact v2 replies:

```swift
    func quickChatHistory(limit: Int) async -> HostApiQuickChatHistory {
        guard let api, let config, let projectStore else { return .unavailable("Backend not configured") }
        guard let chatHost else { return .unavailable("Chat is not installed on this Mac.") }
        guard let quick = chatHost.quickChat(config: config, projectStore: projectStore, api: api) else { return .lines([]) }
        return .lines(Array(quick.engine.conversationLines.suffix(max(limit, 0))))
    }

    func clearQuickChat() async -> HostApiQuickChatClear {
        guard Self.chatDeletionAllowed({ phoneAccess.isAllowed($0) }) else { return .denied(Self.chatDeletionSwitch.deniedMessage) }
        guard let api else { return .unavailable("Backend not configured") }
        guard let chatHost else { return .unavailable("Chat is not installed on this Mac.") }
        guard let config, let projectStore,
              let quick = chatHost.quickChat(config: config, projectStore: projectStore, api: api) else { return .cleared }
        await quick.engine.clearCurrentChat()
        return .cleared
    }
```

In the v2 list handler, map `.unavailable("Backend not configured")` to the existing `CommandError(commandId: "llmide_chat_history", …)` and `.unavailable` for Chat to `replyFeatureUnavailable(feature: "Chat", commandId: "llmide_chat_history")`. Map `.lines` to `LlmIdeChatHistoryReply` (`ChatTurn(role:content:)`). The clear handler maps the same way to its current replies. The v2 phone must see byte-identical frames.

4. **Build the gateway** as `private var hostApiGateway: HostApiV1Gateway?`, created in `start()` only when `HostApiV1Listener.devListenerAllowed(...)` is true (Task 8). Use these dependencies:

```swift
        HostApiV1Gateway.Dependencies(
            hostName: { Self.deviceName() },
            validatePin: { Self.pinMatches(candidate: $0, current: MobilePin.read()) },
            pinConsumed: { [weak self] in self?.rotatePairingPin() },
            issueToken: { [pairedDeviceStore] id, name in pairedDeviceStore.issueToken(deviceId: id, name: name) },
            authenticate: { [pairedDeviceStore] in pairedDeviceStore.authenticate(token: $0) },
            revoke: { [weak self] id in self?.pairedDeviceStore.revoke(id: id); self?.refreshPairedDevices() },
            capabilities: { [weak self] in HostApiV1Gateway.capabilities(chatInstalled: self?.chatHost != nil,
                                                                          toolApprovals: self?.phoneAccess.isAllowed(.toolApprovals) ?? false) },
            tierRefusal: { [weak self] type in
                if case .refuse(_, let message) = PhoneTierTable.verdict(for: type, desktop: false) { return message }
                _ = self; return nil
            },
            forward: { [weak self] in self?.handleInbound($0) },
            history: { [weak self] in await self?.quickChatHistory(limit: $0) ?? .unavailable("Mobile Control stopped.") },
            clear: { [weak self] in await self?.clearQuickChat() ?? .unavailable("Mobile Control stopped.") },
            cancel: { [weak self] in self?.cancelMobileInflightTask(commandId: $0) },
            log: { [weak self] in self?.append(.info, $0) })
```

`rotatePairingPin()` already exists (it is called from `revokeAllDevices`). Confirm that it rotates in memory first and persists off the main actor, like the v2 `onPinConsumed`. If it does not, follow the v2 pattern from `start()` lines 398–412. `pairedDeviceStore` is `private let`; the revoke closure runs inside the class, so it is reachable.

5. **Hooks.** In `refreshCapabilities()` (line 146) and in `installPhoneAccessObserver`'s `onChange`, call `hostApiGateway?.capabilitiesChanged()`. In `revokeDevice(_:)` call `hostApiGateway?.disconnect(deviceId: id)`. In `revokeAllDevices()` call it for each removed id. In `stop()` close the listener and set `hostApiGateway = nil`.

- [ ] **Step 6: Run the full Mac suite**

Run: `cd mac && swift build 2>&1 | tail -3 && LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/h1-t7-all.log 2>&1; grep -E 'Executed|passed after|failed' /tmp/h1-t7-all.log | tail -5`
Expected: build succeeds and there are 0 failures. The existing `MobileInflightTaskTests`, `MobilePhoneApprovalHookTests`, `MobileToolApprovalTests` and `MobileWebSocketServerRoutingTests` all pass, which is the "v2 unchanged" evidence.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1GatewayTests.swift mac/Package.swift
git commit -m "feat(mac): serve Host API v1 chat, approvals and auth through the Mobile Control handlers"
```

---

### Task 8: Loopback development listener, smoke check and docs

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Listener.swift`
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift` (`start()`, `stop()`)
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1ListenerTests.swift`
- Modify: `mac/Package.swift` (`mobileTestExcludes`)
- Create: `scripts/mobile/verify-host-api-v1.swift`
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md`, `schema/host-api/v1/README.md`, `docs/superpowers/MASTER-PLAN.md`

**Interfaces:**
- Consumes: `HostApiV1Gateway` (Task 7).
- Produces: `final class HostApiV1Listener: @unchecked Sendable` with:
  - `init(basePort: Int = 3016, candidates: Int = 10, onOpen: @escaping (Int, String) -> Void, onFrame: @escaping (Int, Data) -> Void, onClose: @escaping (Int) -> Void, onListening: @escaping (Int) -> Void, onLog: @escaping (String) -> Void)`
  - `func start() throws`, `func stop()`, `func send(_ session: Int, _ data: Data)`, `func close(_ session: Int)`
  - `static func devListenerAllowed(environment: [String: String], isDebugBuild: Bool) -> Bool`
  - `static func refusesHandshake(headers: [(name: String, value: String)]) -> Bool`, which is true when any header is `Origin` (decision 5)
  - `static var isDebugBuild: Bool` (`#if DEBUG` true, else false)

- [ ] **Step 1: Write the failing test**

`mac/Tests/LlmIdeMacTests/HostApiV1ListenerTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMacLib

@Suite("HostApiV1Listener", .serialized)
struct HostApiV1ListenerTests {
    @Test("the development listener needs a DEBUG build AND the explicit flag")
    func devGate() {
        #expect(HostApiV1Listener.devListenerAllowed(environment: ["LLMIDE_HOST_API_DEV": "1"], isDebugBuild: true))
        #expect(!HostApiV1Listener.devListenerAllowed(environment: ["LLMIDE_HOST_API_DEV": "1"], isDebugBuild: false))
        #expect(!HostApiV1Listener.devListenerAllowed(environment: [:], isDebugBuild: true))
        #expect(!HostApiV1Listener.devListenerAllowed(environment: ["LLMIDE_HOST_API_DEV": "true"], isDebugBuild: true))
    }

    @Test("a handshake carrying Origin is refused, whatever its case")
    func origin() {
        #expect(HostApiV1Listener.refusesHandshake(headers: [("Origin", "https://evil.example")]))
        #expect(HostApiV1Listener.refusesHandshake(headers: [("origin", "null")]))
        #expect(!HostApiV1Listener.refusesHandshake(headers: [("Host", "127.0.0.1:3016")]))
    }

    @Test("a loopback client can open a socket and its frames reach the gateway")
    func loopbackRoundTrip() async throws {
        let port = 3016 + Int.random(in: 200...900)
        let frames = FrameBox()
        let listener = HostApiV1Listener(basePort: port, candidates: 3,
                                         onOpen: { _, _ in }, onFrame: { s, d in frames.add(s, d) }, onClose: { _ in },
                                         onListening: { frames.bound($0) }, onLog: { _ in })
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(bound)")!)
        task.resume()
        try await task.send(.string(#"{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1}"#))
        let got = try await frames.waitForFrame()
        #expect(String(decoding: got, as: UTF8.self).contains("host.ping"))
        task.cancel(with: .goingAway, reason: nil)
    }
}

final class FrameBox: @unchecked Sendable {
    private let lock = NSLock()
    private var port: Int?
    private var frames: [Data] = []
    func bound(_ p: Int) { lock.lock(); port = p; lock.unlock() }
    func add(_ s: Int, _ d: Data) { lock.lock(); frames.append(d); lock.unlock() }
    func waitForBind() async throws -> Int {
        for _ in 0..<100 { lock.lock(); let p = port; lock.unlock(); if let p { return p }; try await Task.sleep(nanoseconds: 20_000_000) }
        throw CancellationError()
    }
    func waitForFrame() async throws -> Data {
        for _ in 0..<100 { lock.lock(); let f = frames.first; lock.unlock(); if let f { return f }; try await Task.sleep(nanoseconds: 20_000_000) }
        throw CancellationError()
    }
}
```

`loopbackRoundTrip` binds a real loopback port. Under an agent sandbox without local binding it fails with `EPERM`; that is the sandbox, not the code. Run it outside the sandbox, as the existing `MobileWebSocketServerBindTests` require. Add `"HostApiV1ListenerTests.swift",` to `mobileTestExcludes`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1ListenerTests > /tmp/h1-t8.log 2>&1; tail -20 /tmp/h1-t8.log`
Expected: compile failure, `cannot find 'HostApiV1Listener' in scope`.

- [ ] **Step 3: Write the listener**

`HostApiV1Listener.swift`. It follows `MobileWebSocketServer`'s queue discipline: every mutable field is touched only on `queue`.

```swift
import Foundation
import Network

/// Host API v1 development listener: plaintext WebSocket on 127.0.0.1 only, started only in a DEBUG build
/// with `LLMIDE_HOST_API_DEV=1` (spec "Security": plaintext only behind an explicit development flag;
/// production builds refuse it). TLS/WSS is spec phase 6. A handshake carrying `Origin` is refused:
/// there is no web client yet, and a page in the developer's browser must not reach the PIN.
final class HostApiV1Listener: @unchecked Sendable {
    static var isDebugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    static func devListenerAllowed(environment: [String: String], isDebugBuild: Bool) -> Bool {
        isDebugBuild && environment["LLMIDE_HOST_API_DEV"] == "1"
    }

    static func refusesHandshake(headers: [(name: String, value: String)]) -> Bool {
        headers.contains { $0.name.lowercased() == "origin" }
    }

    private let basePort: Int
    private let candidates: Int
    private let onOpen: (Int, String) -> Void
    private let onFrame: (Int, Data) -> Void
    private let onClose: (Int) -> Void
    private let onListening: (Int) -> Void
    private let onLog: (String) -> Void
    private let queue = DispatchQueue(label: "llmide.hostapi.v1")
    private var listener: NWListener?
    private var portIndex = 0
    private var nextSession = 1
    private var connections: [Int: NWConnection] = [:]

    init(basePort: Int = 3016, candidates: Int = 10,
         onOpen: @escaping (Int, String) -> Void, onFrame: @escaping (Int, Data) -> Void,
         onClose: @escaping (Int) -> Void, onListening: @escaping (Int) -> Void, onLog: @escaping (String) -> Void) {
        self.basePort = basePort
        self.candidates = max(1, min(candidates, 65_535 - basePort + 1))
        self.onOpen = onOpen; self.onFrame = onFrame; self.onClose = onClose
        self.onListening = onListening; self.onLog = onLog
    }

    func start() throws { try queue.sync { portIndex = 0; try bind() } }

    func stop() {
        queue.async {
            self.listener?.cancel(); self.listener = nil
            for (_, c) in self.connections { c.stateUpdateHandler = nil; c.cancel() }
            self.connections.removeAll()
        }
    }

    func send(_ session: Int, _ data: Data) {
        queue.async {
            guard let conn = self.connections[session] else { return }
            let meta = NWProtocolWebSocket.Metadata(opcode: .text)
            let ctx = NWConnection.ContentContext(identifier: "hostapi", metadata: [meta])
            conn.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
        }
    }

    func close(_ session: Int) {
        queue.asyncAfter(deadline: .now() + 0.2) {
            guard let conn = self.connections.removeValue(forKey: session) else { return }
            conn.stateUpdateHandler = nil
            conn.cancel()
        }
    }

    private func bind() throws {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = HostApi.limits.maxFrameBytes
        ws.setClientRequestHandler(queue) { _, headers in
            let pairs = headers.map { (name: $0.name, value: $0.value) }
            return NWProtocolWebSocket.Response(status: Self.refusesHandshake(headers: pairs) ? .reject : .accept, subprotocol: nil)
        }
        let params = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        guard let raw = UInt16(exactly: basePort + portIndex), let port = NWEndpoint.Port(rawValue: raw) else {
            throw NWError.posix(.EADDRNOTAVAIL)
        }
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.stateUpdateHandler = { [weak self, weak l] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.onLog("Host API v1 (development, loopback only) listening on 127.0.0.1:\(self.basePort + self.portIndex)")
                self.onListening(self.basePort + self.portIndex)
            case .failed(let error):
                l?.cancel()
                if case .posix(.EADDRINUSE) = error, self.portIndex + 1 < self.candidates {
                    self.portIndex += 1
                    try? self.bind()
                } else {
                    self.onLog("❌ Host API v1 listener failed — \(error.localizedDescription)")
                }
            default: break
            }
        }
        listener = l
        l.start(queue: queue)
    }

    private func accept(_ conn: NWConnection) {
        // Defence in depth beside requiredLocalEndpoint: only a loopback peer is served.
        guard case let .hostPort(host, _) = conn.endpoint, Self.isLoopback(host) else { conn.cancel(); return }
        let session = nextSession
        nextSession += 1
        connections[session] = conn
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.onOpen(session, "\(host)")
                self.receive(session, conn)
            case .failed, .cancelled:
                if self.connections.removeValue(forKey: session) != nil { self.onClose(session) }
                conn.stateUpdateHandler = nil
            default: break
            }
        }
        conn.start(queue: queue)
    }

    private func receive(_ session: Int, _ conn: NWConnection) {
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            guard let data, error == nil else { conn.cancel(); return }
            self.onFrame(session, data)
            self.receive(session, conn)
        }
    }

    private static func isLoopback(_ host: NWEndpoint.Host) -> Bool {
        switch host {
        case .ipv4(let a): return a == .loopback
        case .ipv6(let a): return a == .loopback
        case .name(let n, _): return n == "localhost"
        @unknown default: return false
        }
    }
}
```

`HostApi.limits` comes from SharedProtocol, so add `import SharedProtocol` at the top of the file.

- [ ] **Step 4: Start and stop it with Mobile Control**

At the end of `MobileControlManager.start()`, before `status = .running`:

```swift
        if HostApiV1Listener.devListenerAllowed(environment: ProcessInfo.processInfo.environment,
                                                isDebugBuild: HostApiV1Listener.isDebugBuild) {
            let gateway = HostApiV1Gateway(dependencies: makeHostApiDependencies())
            let listener = HostApiV1Listener(
                onOpen: { s, peer in Task { @MainActor in gateway.opened(session: s, peer: peer) } },
                onFrame: { s, d in Task(priority: .userInitiated) { @MainActor in await gateway.receive(session: s, data: d) } },
                onClose: { s in Task { @MainActor in gateway.closed(session: s) } },
                onListening: { _ in },
                onLog: { [weak self] line in Task { @MainActor [weak self] in self?.append(.info, line) } })
            gateway.send = { s, d in listener.send(s, d) }
            gateway.close = { s in listener.close(s) }
            do { try listener.start(); hostApiGateway = gateway; hostApiListener = listener }
            catch { append(.stderr, "Host API v1 development listener did not start: \(error.localizedDescription)") }
        }
```

Here `makeHostApiDependencies()` is a private method returning the `Dependencies` from Task 7 step 5.4, and `hostApiListener` is a new `private var hostApiListener: HostApiV1Listener?`. In `stop()`, add `hostApiListener?.stop(); hostApiListener = nil; hostApiGateway = nil`. The v2 server, Bonjour and the QR are untouched: v1 is never advertised (decision 1).

- [ ] **Step 5: Run the listener tests and the full suites**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/h1-t8-all.log 2>&1; grep -E 'passed after|failed' /tmp/h1-t8-all.log | tail -5; cd .. && make test-shared-protocol && make host-api-check && node scripts/generate-host-api.mjs --check && bash mac/Scripts/feature-boundaries.sh`
Expected: 0 failures in both Swift suites, `conformance-host-api: ok`, no stale generated file, and the boundary gate exits 0 (all new files are inside `Features/MobileControl/` and name no other feature).

- [ ] **Step 6: Write the manual loopback check**

`scripts/mobile/verify-host-api-v1.swift`, a standalone script like `verify-native-pairing.swift`:

```swift
#!/usr/bin/env swift
//
//  verify-host-api-v1.swift — manual loopback check of the Mac's Host API v1 development listener.
//
//  Prerequisites: a DEBUG Mac build started with the flag, Mobile Control started:
//    cd mac && LLMIDE_HOST_API_DEV=1 swift run LlmIdeMac      # then Settings → Mobile Control → Start
//  Run:
//    swift scripts/mobile/verify-host-api-v1.swift <PIN> [port]      # PIN from Settings → Mobile Control
//
//  Checks (exit 0 if all pass): [1] host.hello → response with hostKind "mac" and apiVersion 1;
//  [2] host.auth.pair with the PIN → a token; [3] chat.snapshot → a messages array; [4] host.ping;
//  [5] a wrong command before auth on a fresh socket → error auth_failed; [6] host.auth.revoke → revoked true.
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: verify-host-api-v1.swift <PIN> [port]"); exit(2) }
let pin = args[1]
let port = args.count >= 3 ? args[2] : "3016"
var failures = 0

func open() -> URLSessionWebSocketTask {
    let t = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
    t.resume(); return t
}

func call(_ t: URLSessionWebSocketTask, _ id: String, _ command: String, _ payload: String) async throws -> [String: Any] {
    try await t.send(.string(#"{"apiVersion":1,"id":"\#(id)","type":"request","command":"\#(command)","payload":\#(payload),"ts":\#(Int(Date().timeIntervalSince1970 * 1000))}"#))
    while true {
        guard case .string(let s) = try await t.receive(),
              let obj = try JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { continue }
        if obj["replyTo"] as? String == id { return obj }
    }
}

func check(_ label: String, _ ok: Bool) { print(ok ? "✅ \(label)" : "❌ \(label)"); if !ok { failures += 1 } }

let hello = #"{"clientName":"verify-host-api-v1","clientVersion":"1","platform":"mac","apiVersions":[1]}"#
let t = open()
let h = try await call(t, "c-1", "host.hello", hello)
check("[1] host.hello", (h["result"] as? [String: Any])?["hostKind"] as? String == "mac")
let p = try await call(t, "c-2", "host.auth.pair", #"{"pin":"\#(pin)"}"#)
let token = (p["result"] as? [String: Any])?["token"] as? String
check("[2] host.auth.pair → token", token != nil)
let s = try await call(t, "c-3", "chat.snapshot", "{}")
check("[3] chat.snapshot", (s["result"] as? [String: Any])?["messages"] is [Any])
let ping = try await call(t, "c-4", "host.ping", "{}")
check("[4] host.ping", ping["type"] as? String == "response")
let fresh = open()
let refused = try await call(fresh, "c-5", "chat.snapshot", "{}")
check("[5] before hello → auth_failed", (refused["error"] as? [String: Any])?["code"] as? String == "auth_failed")
if let token {
    let r = try await call(t, "c-6", "host.auth.revoke", #"{"token":"\#(token)"}"#)
    check("[6] host.auth.revoke", (r["result"] as? [String: Any])?["revoked"] as? Bool == true)
}
exit(failures == 0 ? 0 : 1)
```

`host.auth.pair` rotates the PIN, so each run needs the current PIN from Settings.

- [ ] **Step 7: Docs and plan status**

- `mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md`: add a section titled **"Host API v1 (development listener)"**, five bullets long:
  - It runs only in a DEBUG build with `LLMIDE_HOST_API_DEV=1`, on 127.0.0.1:3016+, and is never advertised.
  - `HostApiV1Gateway` forwards `chat.send` and both approval answers to `handleInbound` as v2 structs with `h1.<session>.<id>` command ids.
  - Every Mac → client frame goes through `emit(_:)`. A new `server?.send` call bypasses v1 routing and is a bug.
  - v2 resets must skip `h1.` ids.
  - Run the manual check with `scripts/mobile/verify-host-api-v1.swift`.
- `schema/host-api/v1/README.md`: replace "It does not contain a host adapter or a client; those are later plans." with "The Mac host adapter is `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/` (development listener only until TLS lands); Swift validation and payload types are generated into `ios_app/SharedProtocol`." Add `invalid-cases.json` to the Workflow list as the file to update when adding an invalid fixture.
- `docs/superpowers/MASTER-PLAN.md`: under S6, replace the "Host API Plans 2 to 6" open item with a `[x]` item for Plan 2, citing its commits, and a `[ ]` item for Plans 3 to 6. Then run `node scripts/plan-status.mjs --fix && node scripts/plan-status.mjs --check`.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Listener.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1ListenerTests.swift mac/Package.swift scripts/mobile/verify-host-api-v1.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md schema/host-api/v1/README.md docs/superpowers/MASTER-PLAN.md
git commit -m "feat(mac): run Host API v1 on a loopback development listener beside v2"
```

---

## Limits

- No TLS, no LAN access, no Bonjour or QR advertisement for v1. A real phone cannot use v1 until spec phase 6.
- `host.snapshot` serves the `chat` topic only. Explorer, Auto Tasks, Loop, projects, files, SCM, issues, Self-Heal, generation, status, usage and activity come with their own command plans.
- No v1 progress event: v2 progress labels are not shown to v1 clients.
- The desktop adapter (spec phase 3), the iOS `HostConnection` (phase 4) and the web client (phase 5) are separate plans. The cross-host conformance run against the desktop stub belongs to phase 3.

## Workflow

Subagent-driven, one task per fresh implementer, each reviewed before the next starts. The Mac tasks (4–8) touch security-relevant code (auth, tokens, the listener), so per the master plan's cross-cutting rules they need an independent review before the plan is called done. Commit on `main`, and do not push.

## Commands

```bash
node scripts/generate-host-api.mjs            # regenerate after any schema change
node scripts/generate-host-api.mjs --check    # drift gate
make host-api-check                            # Node conformance gate
make test-shared-protocol                      # SharedProtocol (validator, payloads, codec)
cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/mac-test.log 2>&1   # Mac suite (pipe to a file)
bash mac/Scripts/feature-boundaries.sh         # boundary gate
swift scripts/mobile/verify-host-api-v1.swift <PIN>   # manual, against a running DEBUG app with LLMIDE_HOST_API_DEV=1
```

## Self-review

- **Spec coverage, phase 2:**
  - Handshake: Task 7 (`host.hello`).
  - Auth: Tasks 4 and 7 (pair, token, self-revoke, throttle, PIN rotation, hashed tokens).
  - Snapshots: Task 7 (`host.snapshot`, `chat.snapshot`).
  - Chat: Tasks 6 and 7 (`chat.send`, `chat.cancel`, `chat.history.clear`, and the delta, done and error events).
  - Approvals: Tasks 6 and 7.
  - Capabilities event: Task 7.
  - Serve v2 unchanged: Task 7 step 6, where the existing v2 suites must pass, and Task 7 step 5.3, which keeps the v2 replies byte-identical.
  - Generated types, not hand-written ones: Tasks 1–2.
  - Envelope rules (closed payloads, unknown command, 1 MiB, bounded error text): Task 3.
  - Listener rule (separate port, 3016 with fallback): Task 8.
  - "Each phase ends with the conformance suite, a build, and a manual pairing check": Task 8 steps 5–6.
- **Deferred on purpose, recorded in Limits:** TLS and fingerprint pinning, the Origin allowlist and the audit log are phase 6. The `status`, `autotasks` and `loop` snapshot topics are later plans.
- **Placeholders:** none. Three steps tell the executor to check one existing signature against the source before compiling: `ToolApprovalRequest.init`, the generated initializer label order, and `rotatePairingPin`. Each names the exact file and line.
- **Type consistency:**
  - `HostApiV1CommandIds.internalId`/`parse`/`isV1` (Task 5) are used in Tasks 7 and 8.
  - `HostApiV1Translation`/`HostApiV1EventOut` (Task 6) are consumed by `deliver` (Task 7).
  - `HostApiQuickChatHistory`/`HostApiQuickChatClear` are defined in Task 7 and used by the manager's extracted functions.
  - `MobilePairedDeviceStore.hostApiDevicePrefix` and `authenticate(token:)` (Task 4) are used in Task 7.
  - The generated names follow the Task 2 rules everywhere they appear.
