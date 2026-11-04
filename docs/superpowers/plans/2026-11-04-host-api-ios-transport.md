# Host API v1 iOS Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iPhone app gets a `HostConnection` transport. It has a Host API v1 client and an adapter over today's MobileProtocol v2 socket. The app tries `host.hello` first and falls back to v2 when no v1 host answers. The chat and approvals store moves behind `HostConnection` with no change in behaviour. Every other screen stays on v2 for now.

**Architecture:** Everything that can be pure goes into `ios_app/SharedProtocol`, so `make test-shared-protocol` tests it with swift-testing and no simulator. That covers:
- a client half for the Plan 2 frame codec (build requests; parse responses, events and errors);
- a generated `HostApiEvent` enum;
- the `HostConnection` protocol and its `HostEvent` vocabulary;
- a `rev`-gap tracker, the negotiation state machine and the endpoint rule;
- `HostApiV1Client`, written against a small `HostApiSocket` seam: URLSession in the app, a scripted fake in tests, a TLS trust hook for Plan 6;
- `HostApiV2ChatBridge`, the inverse of the Mac's `HostApiV2Translator`, which speaks the chat + approvals slice of v2 in v1 vocabulary.

The app adds one file, `V2HostConnection`, which wraps `ConnectionService`'s existing socket. `ConnectionService` stays the app-facing object that views observe (status, error banner, `supports`). It picks the transport, mirrors v1 state into its published properties, and routes `HostEvent`s to `LlmIdeChatStore`. The store then speaks only `HostConnection`.

**Tech Stack:** Swift 5.9, `URLSessionWebSocketTask`, swift-testing (SharedProtocol package), Xcode `MyApp` target (iOS 16, no test target), Node 20 (the generator).

**Spec:** [`docs/superpowers/specs/2026-11-03-host-api-design.md`](../specs/2026-11-03-host-api-design.md), delivery phase 4: "iOS transport: introduce `HostConnection`; v1 adapter plus the existing v2 fallback; move screens behind it without changing behaviour". It also follows the spec's "Compatibility with MobileProtocol v2", "Handshake", "Reconnect after iOS suspends" and "Risks" sections. Contract: `schema/host-api/v1/`. Host implementations: Plan 2 [`2026-11-04-host-api-mac-adapter.md`](2026-11-04-host-api-mac-adapter.md) (done) and Plan 3 [`2026-11-04-host-api-desktop-adapter.md`](2026-11-04-host-api-desktop-adapter.md) (in progress).

## Global Constraints

- `apiVersion` is always `1`. A frame is at most 1,048,576 bytes. Lists default to 100 items, maximum 500. Error messages are at most 500 characters (spec "Wire envelope", "Errors").
- "`id` is unique per client connection and used for correlation." "Requests may be retried only when the command declares `idempotent: true`; otherwise the client generates a new `id` after a timeout." Ids match `^[A-Za-z0-9_-]{1,64}$`.
- "A client that sees an event `rev` greater than its snapshot `rev + 1` resubscribes and takes a fresh snapshot instead of guessing" (spec "Wire envelope").
- Handshake (spec "Handshake"): `host.hello` with client name, app version, platform (`"ios"`) and the API versions spoken; then `host.auth.pair` (PIN) on first use or `host.auth.token` afterwards; then "Client requests the snapshots it needs for the visible screens".
- Reconnect (spec "Reconnect after iOS suspends"): "Phone reopens the socket with `host.hello` and `host.auth.token`", "discards stale feature state and requests snapshots for visible screens", and "no historical replay is required".
- Compatibility (spec): "A new iOS client first attempts `host.hello`. If the host does not answer with a v1 handshake, it uses the existing v2 transport adapter." "New iOS features that need v1 commands are unavailable on a v2-only Mac and are hidden by capability gating; nothing pretends to work."
- Ports (spec "Ports and listeners"): v2 stays on `ws://3006`–`3015`. v1 defaults to `wss://3016`. "Discovery, the QR and the manual-entry screen advertise the exact v1 port; the default is never assumed."
- Security (spec "Security"): "TLS/WSS is required for non-loopback clients. The host certificate fingerprint is carried in the pairing QR and pinned by the client." "Tokens are stored hashed on the host and in Keychain on iOS." "No frame may carry a credential after pairing except `host.auth.token` and the token in `host.auth.revoke`."
- "Duplicated hand-written v1 types are not allowed" (spec "Schema and generated types"). Every v1 payload type the client uses comes from the generated `HostApiPayloads.swift`; event names come from a generated enum.
- Risks (spec): "Moving iOS behind a transport abstraction touches every store; it must be done slice by slice, not as one rewrite." This plan moves exactly one slice, chat + approvals.
- Behaviour on v2 must not change. That covers the frames sent, the banner texts, the idle timeout and its Cancel, the approval card rules, demo mode, and the Keychain items that already exist.
- Repo rules (root `CLAUDE.md`):
  - SharedProtocol changes must keep `make test-shared-protocol` and the Mac build green, because the Mac links the package.
  - A new app source file needs its four `project.pbxproj` entries (build file, file reference, Services group, Sources phase).
  - Conventional Commits, one concern per commit, on `main`, never pushed by the executor (the nightly job pushes). Every commit message ends with the attribution line the session gives.
- User decision 2026-11-04: manual device checks are deferred to the product stage. They are recorded in `docs/mobile/verification.md` as rows to run later and are **not** gates for this plan.

## Decisions this plan makes (revisit if wrong)

1. **v1 is tried only when a v1 endpoint is known, and nothing advertises one yet.**
   - The spec forbids assuming port 3016.
   - Today's Bonjour record and QR carry only the v2 port. Spec phase 6 adds the v1 port and the fingerprint.
   - Until then, only a DEBUG build can supply an endpoint, through the `LLMIDE_HOST_API_URL` environment variable (Xcode scheme → Run → Environment). An example is `ws://127.0.0.1:3016/host-api/v1` for the Simulator against a DEBUG Mac or desktop host started with `LLMIDE_HOST_API_DEV=1`.
   - Release builds see no endpoint and go straight to v2, exactly as today. The negotiation still runs and is tested; it just always takes the v2 branch.
2. **What counts as "no v1 answer".** The app falls back to v2 when any of these happens:
   - no valid v1 frame arrives within 3 s of `host.hello`;
   - the socket fails before the hello is answered;
   - `host.hello` is refused with `capability_unavailable` or `unknown_command`.

   Any other v1 refusal (`auth_failed`, `rate_limited`, `busy`) ends that attempt and is handled the way v2's `AuthFailed` is today: a retryable refusal backs off and retries, and a non-retryable one clears the credentials. The app never falls back to v2 after a v1 host has answered, because that would hide a revocation.
3. **One vocabulary for stores.**
   - `HostConnection` speaks v1 commands (generated payload types) and v1 events.
   - The v2 adapter translates through the pure `HostApiV2ChatBridge`.
   - v2 adds one extra case, `HostEvent.progress`: an `Output{done:false}` status line. v1 has no progress event (Plan 2 decision 2). Without this case, the moved store would lose the status lines and the approval-pause glyph that phone users see today.
4. **Views keep the v2 view models.** The store still publishes `ApprovalRequest` and `ToolApprovalRequest`. v1 events are decoded with generated types and mapped onto them by `HostApiV2ChatBridge.approvalRequest(_:)` and its siblings, so no view changes and no hand-written v1 type is added.
5. **A separate v1 token.**
   - It uses Keychain account `host-api-token` under the existing service `com.llmide.device-pin`, with the same `AfterFirstUnlockThisDeviceOnly` policy, written through the existing `CredentialKeychain`.
   - The v2 `device-token` item is untouched.
   - A fresh PIN clears both tokens. A successful pair on either transport drops the PIN, because the host rotates it.
6. **A v1 connection serves chat + approvals only.** Its capability set is `host`, `chat`, `approvals` and, when the host allows it, `tool_approvals`.
   - Every other screen is hidden by the existing `supports()` gating: the Project tab, Activity, Usage, Docs and Generate.
   - The v2 refreshes are skipped.
   - This is the spec's "nothing pretends to work". In return, v1 must not be preferred in release builds until the later slices move (see Limits).
7. **The v1 idle window is the long one from the start.**
   - On v2, every progress frame restarts the 120 s idle breaker.
   - v1 sends nothing until the reply, so the 120 s breaker would send Cancel to every turn longer than two minutes.
   - On a v1 connection the store uses the existing 960 s window. The 10 s `host.ping` watchdog still detects a dead socket.
   - The breaker itself is unchanged and still slated for removal in S4 (`docs/mobile/verification.md`).
8. **`wss://` is refused until Plan 6.**
   - `HostApiEndpoint` accepts only `ws://` to a loopback host.
   - `URLSessionHostApiSocket` already routes the TLS challenge to an optional `HostApiTrustEvaluating`. With none set, it cancels the challenge.
   - Plan 6 supplies the fingerprint evaluator and relaxes `HostApiEndpoint` to accept `wss://` with a fingerprint. Nothing else changes.
9. **The v1 path is `/host-api/v1`.** The desktop listener upgrades only that path, and the Mac listener ignores the path, so one URL works for both hosts.
10. **No reconnect loop inside the v1 client.** A dropped v1 socket surfaces as `HostEvent.disconnected`, and `ConnectionService`'s existing backoff (`scheduleReconnect`) calls `connectDirect` again. That runs hello, token, connected, and the views' existing "on connected, reload" hooks. Those hooks are the spec's "requests snapshots for visible screens".

## File Structure

| File | Responsibility |
|---|---|
| `scripts/generate-host-api.mjs` (modify) | Also emit `HostApiEvent` (event-name enum) into `HostApiCommands.swift` |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift` (generated) | + `HostApiEvent` |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift` (modify) | `HostApiRejection.retryable/retryAfterMs`; client side: `newClientId`, `request`, `parseInbound`, `HostApiInbound` |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostConnection.swift` (create) | `HostConnection` protocol, `HostEvent`, `HostConnectionState`, `HostCredential` |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiClientLogic.swift` (create) | `HostApiRevTracker`, `HostApiNegotiation`, `HostApiEndpoint` (pure) |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSocket.swift` (create) | `HostApiSocket`, `HostApiTrustEvaluating` (Plan 6 seam), `URLSessionHostApiSocket` |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV1Client.swift` (create) | v1 `HostConnection`: hello, auth, correlation, ping watchdog, `rev` gaps |
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV2ChatBridge.swift` (create) | Pure v2 ⇄ v1 mapping for chat + approvals |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientFrameTests.swift` (create) | Client codec against the fixtures and the host codec |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientLogicTests.swift` (create) | Rev tracker, negotiation, endpoint |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV1ClientTests.swift` (create) | Client against a scripted `FakeHostSocket` |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV2ChatBridgeTests.swift` (create) | Byte-identical v2 frames; event mapping |
| `ios_app/MyApp/Services/ConnectionStore.swift` (modify) | v1 token Keychain account, `hostApiEndpoint` |
| `ios_app/MyApp/Services/V2HostConnection.swift` (create) | `HostConnection` over today's v2 socket |
| `ios_app/MyApp.xcodeproj/project.pbxproj` (modify) | Register `V2HostConnection.swift` |
| `ios_app/MyApp/Services/ConnectionService.swift` (modify) | `host`, negotiation in `connectDirect`, v1 lifecycle, `route(_:)`, `sendV2Frame`, chat dispatch via the adapter |
| `ios_app/MyApp/Services/LlmIdeChatStore.swift` (modify) | Speaks `HostConnection` only; `handle(_ event:)` |
| `ios_app/MyApp/Views/RootTabView.swift`, `Views/Control/LlmIdeControlView.swift` (modify) | Capability gating for a v1 connection |
| `docs/mobile/verification.md`, `docs/mobile/quick-start.md`, `schema/host-api/v1/README.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | Deferred manual rows, developer how-to, client codec, plan status |

**Dependency order and parallel safety:**
- Task 1 comes first.
- Tasks 2 and 4 are **parallel-safe** with each other. They only create new files.
- Task 3 needs Tasks 1 and 2.
- Task 5 needs Tasks 1–4.
- Tasks 6, 7 and 8 are **parallel-safe** with each other after Task 5. They touch disjoint files.
- Parallel implementers commit one at a time. Each stages only its own files.

---

### Task 1: Generated event enum, client-side frame codec and the `HostConnection` vocabulary

**Files:**
- Modify: `scripts/generate-host-api.mjs`
- Generated: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift`
- Modify: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift`
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostConnection.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientFrameTests.swift`

**Interfaces:**
- Produces: `public enum HostApiEvent: String, CaseIterable, Sendable` (cases `approvalCleared`, `approvalRequest`, `chatDelta`, `chatDone`, `chatError`, `hostCapabilities`, `toolApprovalRequest`).
- Produces: `HostApiRejection(replyTo:code:message:retryable: = false, retryAfterMs: = nil)`. The two new fields keep every existing call site compiling.
- Produces: `HostApiFrame.newClientId() -> String`, `HostApiFrame.request<P: Encodable>(id:command:payload:now:) throws -> Data`, `HostApiFrame.parseInbound(_:) -> Result<HostApiInbound, HostApiRejection>`.
- Produces: `HostApiInbound` with the cases `.response(replyTo:command:result:rev:)`, `.event(_:payload:replyTo:rev:)` and `.error(replyTo:rejection:rev:)`.
- Produces: `HostConnection`, `HostEvent`, `HostConnectionState`, `HostCredential` (below).

- [ ] **Step 1: Generate the event enum**

In `scripts/generate-host-api.mjs`, after `const eventsSchema = readSchema("events.schema.json");` add:

```js
// Event names, for the Swift client's HostApiEvent (sorted, so --check stays a byte comparison).
const eventNames = eventsSchema.oneOf.map((v) => v.properties.command.const).sort();
```

At the end of the `swift` template, after the closing `}` of `public enum HostApi { … }` and before the closing backtick, append:

```js

public enum HostApiEvent: String, CaseIterable, Sendable {
${eventNames.map((n) => `    case ${swiftCase(n)} = ${JSON.stringify(n)}`).join("\n")}
}
```

Run: `node scripts/generate-host-api.mjs && node scripts/generate-host-api.mjs --check`
Expected: `host-api: wrote 4 generated files`, then exit 0. `HostApiCommands.swift` ends with a 7-case `HostApiEvent`, and `commands.generated.mjs` has not changed (`git diff --stat` shows only the Swift file).

- [ ] **Step 2: Write the failing codec test**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientFrameTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

@Suite("HostApiFrame client side")
struct HostApiClientFrameTests {
    private func obj(_ d: Data) -> [String: Any] { try! JSONSerialization.jsonObject(with: d) as! [String: Any] }

    @Test("every command's request fixture builds a frame the host codec accepts")
    func requestsRoundTripThroughHostCodec() throws {
        for command in HostApiCommand.allCases {
            let payload = try JSONDecoder().decode(HostApiJSONValue.self,
                from: HostApiFixtures.data("fixtures/commands/\(command.rawValue).request.json"))
            let id = HostApiFrame.newClientId()
            let frame = try HostApiFrame.request(id: id, command: command, payload: payload)
            let parsed = try HostApiFrame.parseRequest(frame).get()
            #expect(parsed.command == command)
            #expect(parsed.id == id)
        }
    }

    @Test("a payload that breaks its schema is refused before anything is sent")
    func invalidPayload() {
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.request(id: "c-1", command: .chatSend, payload: HostApiChatSendRequest(text: ""))
        }
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.request(id: "bad id!", command: .hostPing, payload: HostApiHostPingRequest())
        }
    }

    @Test("client ids fit the envelope id pattern")
    func clientIds() {
        let id = HostApiFrame.newClientId()
        #expect(HostApiSchemaValidator.matches(id, "^[A-Za-z0-9_-]{1,64}$"))
    }

    @Test("valid response, event and error fixtures parse with their rev")
    func parsesValidFixtures() throws {
        guard case .response(let replyTo, let command, _, let rev) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/valid/response.json")).get()
        else { Issue.record("expected a response"); return }
        #expect(replyTo == "c-1"); #expect(command == .hostPing); #expect(rev == 1)

        guard case .event(let event, let payload, _, let erev) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/valid/event.json")).get()
        else { Issue.record("expected an event"); return }
        #expect(event == .chatDelta); #expect(erev == 2)
        #expect(try JSONDecoder().decode(HostApiChatDeltaEvent.self, from: payload).text == "hi")

        guard case .error(let ereplyTo, let rejection, let xrev) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/valid/error.json")).get()
        else { Issue.record("expected an error"); return }
        #expect(ereplyTo == "c-1"); #expect(rejection.code == "denied"); #expect(rejection.retryable == false); #expect(xrev == nil)
    }

    @Test("every event fixture parses as its generated event name, and the enum lists exactly the fixtures")
    func eventFixtures() throws {
        let names = try HostApiFixtures.names("fixtures/events").map { String($0.dropLast(5)) }
        #expect(Set(names) == Set(HostApiEvent.allCases.map(\.rawValue)))
        for name in names {
            guard case .event(let event, _, _, _) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/events/\(name).json")).get()
            else { Issue.record("\(name) did not parse as an event"); continue }
            #expect(event.rawValue == name)
        }
    }

    @Test("host-built frames parse back, retryable and retryAfterMs included")
    func hostBuiltFrames() throws {
        let r = try HostApiFrame.response(replyTo: "c-9", command: .chatCancel, result: HostApiChatCancelResult(cancelled: true), rev: 7)
        guard case .response(_, .chatCancel, let result, 7) = try HostApiFrame.parseInbound(r).get() else { Issue.record("response"); return }
        #expect(try JSONDecoder().decode(HostApiChatCancelResult.self, from: result).cancelled)
        let e = HostApiFrame.error(replyTo: "c-9", code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 500, rev: 7)
        guard case .error(_, let rejection, _) = try HostApiFrame.parseInbound(e).get() else { Issue.record("error"); return }
        #expect(rejection == HostApiRejection(replyTo: "c-9", code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 500))
    }

    @Test("v2 frames, unknown events, bad results and oversize frames are refused, never crash")
    func refusals() {
        #expect(HostApiFrame.parseInbound(Data(#"{"type":"connected","deviceName":"Mac"}"#.utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data(#"{"apiVersion":1,"id":"e-1","type":"event","command":"chat.progress","payload":{},"ts":1,"rev":1}"#.utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data(#"{"apiVersion":1,"id":"s-1","replyTo":"c-1","type":"response","command":"host.ping","result":{"x":1},"ts":1,"rev":1}"#.utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data("not json".utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data(repeating: 0x20, count: HostApi.limits.maxFrameBytes + 1)).failure != nil)
    }
}
```

`.failure` is the `Result` helper already declared in `HostApiFrameTests.swift`.

- [ ] **Step 3: Run it to verify it fails**

Run: `make test-shared-protocol`
Expected: compile failure: `type 'HostApiFrame' has no member 'request'` and `cannot find 'HostApiEvent' in scope`.

- [ ] **Step 4: Extend the rejection and add the client half of the codec**

In `HostApiFrame.swift`, replace `HostApiRejection` with:

```swift
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
```

Append to the end of the same file. It has to be the same file, because the extension uses the `private` `defs`, `jsonObject` and `millis`:

```swift
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

    /// One frame from a host. Anything that is not a valid v1 response, event or error frame (a v2 frame on
    /// this port, a newer host's unknown event) is a failure, which the client ignores.
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
```

- [ ] **Step 5: Declare the transport vocabulary**

`ios_app/SharedProtocol/Sources/SharedProtocol/HostConnection.swift`:

```swift
import Foundation

public enum HostConnectionState: Sendable, Equatable { case disconnected, connecting, connected }

/// The first credential a connect presents: a pairing PIN, or the device token a host issued for it.
public enum HostCredential: Sendable, Equatable { case pin(String), token(String) }

/// What a host pushes to the client, in Host API v1 vocabulary whichever wire carried it.
public enum HostEvent: Sendable, Equatable {
    /// A v1 event. Decode `payload` with its generated `HostApi…Event` type.
    case event(HostApiEvent, payload: Data, replyTo: String?)
    /// v2 only: an `Output{done:false}` status line for request `replyTo`. v1 has no progress event
    /// (Plan 2 decision 2), so a v1 host never sends this.
    case progress(replyTo: String, text: String)
    /// The served capability set changed (`host.capabilities`).
    case capabilities(Set<String>)
    /// An event `rev` skipped ahead (spec "Wire envelope"): discard stale feature state and re-snapshot
    /// the visible screens instead of guessing.
    case resync
    /// The host closed, or the socket died, after `connect` succeeded. `reason.code` is `auth_failed`
    /// (removed on the host, not retryable) or `host_unreachable` (retryable).
    case disconnected(reason: HostApiRejection)
}

/// The transport a store speaks (spec phase 4). The implementations are `HostApiV1Client` and the app's
/// `V2HostConnection`. Connecting is deliberately not on the protocol: v1 runs hello + auth and reports
/// an outcome, while v2 is today's `ConnectionService` pairing and backoff. Only `ConnectionService`
/// connects, through the concrete types.
@MainActor
public protocol HostConnection: AnyObject {
    /// 1 = Host API v1; 2 = the MobileProtocol v2 fallback.
    var apiVersion: Int { get }
    var state: HostConnectionState { get }
    var capabilities: Set<String> { get }
    /// One consumer (`ConnectionService`) routes events to the stores, as its v2 receive loop does today.
    var onEvent: ((HostEvent) -> Void)? { get set }
    /// Send one command and await its result (JSON matching the command's result schema). `id` lets the
    /// caller own correlation, which chat needs because events carry it back as `replyTo`; nil mints one.
    /// Throws `HostApiRejection`: the host's error frame, or `host_unreachable` (retryable only if the
    /// command is idempotent) when no reply comes.
    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data
    func close()
}

public extension HostConnection {
    func send<P: Encodable, R: Decodable>(_ command: HostApiCommand, _ payload: P, id: String? = nil,
                                          as: R.Type) async throws -> R {
        let result = try await send(command, payload: try JSONEncoder().encode(payload), id: id)
        return try JSONDecoder().decode(R.self, from: result)
    }
}
```

- [ ] **Step 6: Run the tests and the gates**

Run: `make test-shared-protocol && node scripts/generate-host-api.mjs --check && make host-api-check`
Expected: all SharedProtocol suites pass, including the existing `HostApiFrame` suite (the `HostApiRejection` defaults keep it equal), and `conformance-host-api: ok (12 commands, 7 events)`.

Run (unsandboxed): `cd mac && swift build 2>&1 | tail -3`
Expected: `Build complete!`. The Mac links SharedProtocol, and the new defaulted initializer keeps every `HostApiRejection(replyTo:code:message:)` call compiling.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-host-api.mjs ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift \
  ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift ios_app/SharedProtocol/Sources/SharedProtocol/HostConnection.swift \
  ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientFrameTests.swift
git commit -m "feat(shared-protocol): Host API v1 client frame codec and HostConnection vocabulary"
```

---

### Task 2: Rev tracker, negotiation state machine and endpoint rule (pure) [parallel-safe with Task 4]

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiClientLogic.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientLogicTests.swift`

**Interfaces:**
- Produces: `HostApiRevTracker`, with `baseline(_:)`, `observe(event:) -> Decision` (`.inOrder` / `.gap`), `reset()` and `rev`.
- Produces: `HostApiNegotiation`:
  - `handle(_ input: Input) -> Action`
  - inputs: `start(v1Endpoint:)`, `helloAnswered(apiVersion:requiresAuth:)`, `helloRefused(_)`, `silent`, `authAnswered`, `authRefused(_)`
  - actions: `openV1AndHello`, `sendAuth`, `ready`, `connectV2`, `fail(_)`, `ignore`
  - `phase`
- Produces: `HostApiEndpoint(_ string:) -> HostApiEndpoint?` with `url`.

- [ ] **Step 1: Write the failing test**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientLogicTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

@Suite("Host API client logic")
struct HostApiClientLogicTests {
    private let busy = HostApiRejection(replyTo: nil, code: "busy", message: "full", retryable: true)
    private let badPin = HostApiRejection(replyTo: "c-2", code: "auth_failed", message: "Wrong PIN")

    @Test("rev: in order after a baseline, a skip is a gap, and a response never moves the baseline back")
    func revTracker() {
        var t = HostApiRevTracker()
        #expect(t.observe(event: 3) == .gap, "no snapshot yet: the first event cannot be trusted")
        t.reset()
        t.baseline(4)
        #expect(t.observe(event: 5) == .inOrder)
        #expect(t.observe(event: 6) == .inOrder)
        #expect(t.observe(event: 9) == .gap, "9 > 6 + 1")
        #expect(t.observe(event: 10) == .inOrder, "the gap event becomes the new baseline")
        t.baseline(7)
        #expect(t.rev == 10)
        t.baseline(20)
        #expect(t.observe(event: 21) == .inOrder, "a response rev absorbs other sessions' events")
    }

    @Test("negotiation: no v1 endpoint goes straight to v2")
    func noEndpoint() {
        var n = HostApiNegotiation()
        #expect(n.handle(.start(v1Endpoint: false)) == .connectV2)
        #expect(n.phase == .v2)
    }

    @Test("negotiation: hello then auth reaches v1")
    func happyPath() {
        var n = HostApiNegotiation()
        #expect(n.handle(.start(v1Endpoint: true)) == .openV1AndHello)
        #expect(n.handle(.helloAnswered(apiVersion: 1, requiresAuth: true)) == .sendAuth)
        #expect(n.handle(.authAnswered) == .ready)
        #expect(n.phase == .v1)
    }

    @Test("negotiation: silence, a foreign version or a version refusal falls back to v2")
    func fallbacks() {
        for input: HostApiNegotiation.Input in [
            .silent,
            .helloAnswered(apiVersion: 2, requiresAuth: true),
            .helloRefused(.init(replyTo: "c-1", code: "capability_unavailable", message: "v1 only")),
            .helloRefused(.init(replyTo: "c-1", code: "unknown_command", message: "?")),
        ] {
            var n = HostApiNegotiation()
            _ = n.handle(.start(v1Endpoint: true))
            #expect(n.handle(input) == .connectV2, "\(input)")
        }
    }

    @Test("negotiation: once a v1 host answered, a refusal or silence never falls back to v2")
    func noFallbackAfterV1Answered() {
        var a = HostApiNegotiation()
        _ = a.handle(.start(v1Endpoint: true))
        #expect(a.handle(.helloRefused(busy)) == .fail(busy))

        var b = HostApiNegotiation()
        _ = b.handle(.start(v1Endpoint: true)); _ = b.handle(.helloAnswered(apiVersion: 1, requiresAuth: true))
        #expect(b.handle(.authRefused(badPin)) == .fail(badPin))

        var c = HostApiNegotiation()
        _ = c.handle(.start(v1Endpoint: true)); _ = c.handle(.helloAnswered(apiVersion: 1, requiresAuth: true))
        guard case .fail(let r) = c.handle(.silent) else { Issue.record("expected fail"); return }
        #expect(r.code == "host_unreachable"); #expect(r.retryable)
    }

    @Test("negotiation: out-of-order inputs are ignored")
    func ignored() {
        var n = HostApiNegotiation()
        #expect(n.handle(.authAnswered) == .ignore)
        _ = n.handle(.start(v1Endpoint: false))
        #expect(n.handle(.silent) == .ignore)
    }

    @Test("endpoint: plaintext only to loopback, wss refused until Plan 6, default path added")
    func endpoint() {
        #expect(HostApiEndpoint("ws://127.0.0.1:3016")?.url.absoluteString == "ws://127.0.0.1:3016/host-api/v1")
        #expect(HostApiEndpoint("ws://localhost:3017/host-api/v1")?.url.path == "/host-api/v1")
        #expect(HostApiEndpoint("ws://192.168.1.20:3016") == nil, "plaintext off loopback")
        #expect(HostApiEndpoint("wss://192.168.1.20:3016") == nil, "no pinning evaluator before Plan 6")
        #expect(HostApiEndpoint("ws://127.0.0.1") == nil, "the port is never assumed")
        #expect(HostApiEndpoint("http://127.0.0.1:3016") == nil)
        #expect(HostApiEndpoint("") == nil)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `make test-shared-protocol`
Expected: compile failure, `cannot find 'HostApiRevTracker' in scope`.

- [ ] **Step 3: Write the logic**

`ios_app/SharedProtocol/Sources/SharedProtocol/HostApiClientLogic.swift`:

```swift
import Foundation

/// The client's view of the host's `rev` (spec "Wire envelope"). Responses carry the host's current rev
/// and set a baseline; an event more than one past it is a gap, and the client re-snapshots.
public struct HostApiRevTracker: Sendable, Equatable {
    public enum Decision: Sendable, Equatable { case inOrder, gap }
    public private(set) var rev: Int?
    public init() {}

    public mutating func baseline(_ r: Int) { rev = max(rev ?? r, r) }

    public mutating func observe(event r: Int) -> Decision {
        defer { rev = max(rev ?? r, r) }
        guard let last = rev else { return .gap }
        return r > last + 1 ? .gap : .inOrder
    }

    public mutating func reset() { rev = nil }
}

/// One connect attempt's v1-or-v2 decision (spec "Compatibility with MobileProtocol v2"). v2 is chosen only
/// when no v1 host answered. After a v1 answer, every refusal is final for that attempt, so a revoked token
/// can never be hidden by a v2 fallback.
public struct HostApiNegotiation: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case idle, awaitingHello, awaitingAuth, v1, v2, failed }
    public enum Input: Sendable, Equatable {
        case start(v1Endpoint: Bool)
        case helloAnswered(apiVersion: Int, requiresAuth: Bool)
        case helloRefused(HostApiRejection)
        /// No valid v1 frame in time, or the socket failed.
        case silent
        case authAnswered
        case authRefused(HostApiRejection)
    }
    public enum Action: Sendable, Equatable { case openV1AndHello, sendAuth, ready, connectV2, fail(HostApiRejection), ignore }

    public private(set) var phase: Phase = .idle
    public init() {}

    public mutating func handle(_ input: Input) -> Action {
        switch (phase, input) {
        case (.idle, .start(let v1)):
            phase = v1 ? .awaitingHello : .v2
            return v1 ? .openV1AndHello : .connectV2
        case (.awaitingHello, .helloAnswered(let version, let requiresAuth)):
            guard version == HostApi.version else { phase = .v2; return .connectV2 }
            phase = requiresAuth ? .awaitingAuth : .v1
            return requiresAuth ? .sendAuth : .ready
        case (.awaitingHello, .helloRefused(let r)):
            // A host that does not speak our version may still serve v2.
            if r.code == "capability_unavailable" || r.code == "unknown_command" { phase = .v2; return .connectV2 }
            phase = .failed
            return .fail(r)
        case (.awaitingHello, .silent):
            phase = .v2
            return .connectV2
        case (.awaitingAuth, .authAnswered):
            phase = .v1
            return .ready
        case (.awaitingAuth, .authRefused(let r)):
            phase = .failed
            return .fail(r)
        case (.awaitingAuth, .silent):
            phase = .failed
            return .fail(HostApiRejection(replyTo: nil, code: "host_unreachable",
                                          message: "The host stopped answering during sign-in.", retryable: true))
        default:
            return .ignore
        }
    }
}

/// Where to reach a Host API v1 listener. Spec "Security": plaintext only on loopback.
public struct HostApiEndpoint: Sendable, Equatable {
    public let url: URL
    static let loopback: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]

    public init?(_ string: String) {
        guard var c = URLComponents(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), c.port != nil else { return nil }
        // shortcut: wss is refused until Plan 6 supplies the certificate-fingerprint evaluator
        // (HostApiTrustEvaluating); a self-signed LAN host must never be trusted unpinned.
        guard scheme == "ws", Self.loopback.contains(host) else { return nil }
        // The desktop listener upgrades only this path; the Mac ignores the path.
        if c.path.isEmpty || c.path == "/" { c.path = "/host-api/v1" }
        guard let url = c.url else { return nil }
        self.url = url
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `make test-shared-protocol`
Expected: the `Host API client logic` suite passes (7 tests), and the other suites stay green.

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/HostApiClientLogic.swift \
  ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiClientLogicTests.swift
git commit -m "feat(shared-protocol): Host API rev-gap tracker, v1/v2 negotiation and endpoint rule"
```

---

### Task 3: `HostApiV1Client` over a socket seam (needs Tasks 1–2)

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSocket.swift`
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV1Client.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV1ClientTests.swift`

**Interfaces:**
- Produces: `protocol HostApiSocket: AnyObject, Sendable`, with `send(_ text: String) async throws`, `receive() async throws -> Data` and `cancel()`.
- Produces: `protocol HostApiTrustEvaluating: Sendable`, with `evaluate(_ trust: SecTrust, host: String) -> Bool`. Plan 6 implements it.
- Produces: `URLSessionHostApiSocket(url:trust:)`.
- Produces: `HostApiV1Client(config:makeSocket:)`, which conforms to `HostConnection`, plus `connect(_ credential:) async -> ConnectOutcome`.
- `ConnectOutcome` has three cases: `.ready(hello:token:)`, `.notV1` and `.refused(_)`.
- `Config` has `clientName`, `clientVersion`, `helloTimeout = 3`, `requestTimeout = 15` and `pingInterval = 10`.

- [ ] **Step 1: Write the failing test**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV1ClientTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

/// A scripted host. `reply` answers each request the client sends; a test can also push frames or kill the socket.
final class FakeHostSocket: HostApiSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var _sent: [[String: Any]] = []
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private var iterator: AsyncThrowingStream<Data, Error>.AsyncIterator
    var reply: (_ command: String, _ id: String) -> [Data] = { _, _ in [] }

    init() {
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        self.continuation = continuation
        self.iterator = stream.makeAsyncIterator()
    }
    var sentCommands: [String] { lock.withLock { _sent.compactMap { $0["command"] as? String } } }
    var sent: [[String: Any]] { lock.withLock { _sent } }

    func send(_ text: String) async throws {
        let obj = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        lock.withLock { _sent.append(obj) }
        for frame in reply(obj["command"] as! String, obj["id"] as! String) { continuation.yield(frame) }
    }
    func receive() async throws -> Data {
        var it = iterator   // the iterator is reference-backed; copying keeps exclusivity simple
        defer { iterator = it }
        guard let next = try await it.next() else { throw URLError(.networkConnectionLost) }
        return next
    }
    func push(_ frame: Data) { continuation.yield(frame) }
    func fail() { continuation.finish(throwing: URLError(.networkConnectionLost)) }
    func cancel() { continuation.finish() }
}

@MainActor
@Suite("HostApiV1Client")
struct HostApiV1ClientTests {
    static let hello = HostApiHostHelloResult(apiVersion: 1, apiVersions: [1], capabilities: ["host", "chat", "approvals"],
                                              hostKind: "mac", hostName: "Test Mac", protocolVersion: 3, requiresAuth: true)
    static let token = String(repeating: "t", count: 32)
    let socket = FakeHostSocket()

    func client(helloTimeout: TimeInterval = 0.2, requestTimeout: TimeInterval = 0.3) -> HostApiV1Client {
        HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", helloTimeout: helloTimeout,
                                      requestTimeout: requestTimeout, pingInterval: 60),
                        makeSocket: { [socket] in socket })
    }

    /// A v1 host that answers hello and both auth commands at `rev`.
    func happyHost(rev: Int = 0, caps: [String] = ["host", "chat", "approvals"]) {
        socket.reply = { command, id in
            switch command {
            case "host.hello": return [try! HostApiFrame.response(replyTo: id, command: .hostHello, result: Self.hello, rev: rev)]
            case "host.auth.pair": return [try! HostApiFrame.response(replyTo: id, command: .hostAuthPair,
                                           result: HostApiHostAuthPairResult(capabilities: caps, token: Self.token), rev: rev)]
            case "host.auth.token": return [try! HostApiFrame.response(replyTo: id, command: .hostAuthToken,
                                            result: HostApiHostAuthTokenResult(capabilities: caps), rev: rev)]
            default: return []
            }
        }
    }

    @Test("PIN connect: hello then pair, returns the new token, granted capabilities win")
    func pinConnect() async {
        happyHost(caps: ["host", "chat"])
        let c = client()
        let outcome = await c.connect(.pin("123456"))
        #expect(outcome == .ready(hello: Self.hello, token: Self.token))
        #expect(c.state == .connected)
        #expect(c.capabilities == ["host", "chat"])
        #expect(socket.sentCommands == ["host.hello", "host.auth.pair"])
        let hello = socket.sent[0]["payload"] as? [String: Any]
        #expect(hello?["platform"] as? String == "ios")
        #expect(hello?["apiVersions"] as? [Int] == [1])
    }

    @Test("token connect never sends the PIN and returns no new token")
    func tokenConnect() async {
        happyHost()
        let outcome = await client().connect(.token(Self.token))
        #expect(outcome == .ready(hello: Self.hello, token: nil))
        #expect(socket.sentCommands == ["host.hello", "host.auth.token"])
    }

    @Test("no answer to hello is notV1; so is a version refusal")
    func notV1() async {
        let silent = await client().connect(.pin("123456"))
        #expect(silent == .notV1)

        socket.reply = { _, id in [HostApiFrame.error(replyTo: id, code: "capability_unavailable", message: "v1 only", retryable: false, rev: 0)] }
        #expect(await client().connect(.pin("123456")) == .notV1)
    }

    @Test("a v1 auth refusal is final, with the host's code and retryability")
    func refused() async {
        socket.reply = { command, id in
            command == "host.hello"
                ? [try! HostApiFrame.response(replyTo: id, command: .hostHello, result: Self.hello, rev: 0)]
                : [HostApiFrame.error(replyTo: id, code: "auth_failed", message: "Wrong PIN", retryable: false, rev: 0)]
        }
        guard case .refused(let r) = await client().connect(.pin("123456")) else { Issue.record("expected refused"); return }
        #expect(r.code == "auth_failed"); #expect(!r.retryable)
    }

    @Test("an unsolicited busy before hello is answered is a refusal, not a v2 fallback")
    func busyBeforeHello() async {
        socket.reply = { _, _ in [HostApiFrame.error(replyTo: nil, code: "busy", message: "full", retryable: true, rev: 0)] }
        guard case .refused(let r) = await client().connect(.pin("123456")) else { Issue.record("expected refused"); return }
        #expect(r.code == "busy"); #expect(r.retryable)
    }

    @Test("send correlates by id, surfaces error frames and times out as host_unreachable")
    func sendCorrelation() async throws {
        happyHost()
        let c = client()
        _ = await c.connect(.token(Self.token))
        socket.reply = { command, id in
            switch command {
            case "chat.cancel": return [try! HostApiFrame.response(replyTo: id, command: .chatCancel, result: HostApiChatCancelResult(cancelled: true), rev: 0)]
            case "chat.history.clear": return [HostApiFrame.error(replyTo: id, code: "denied", message: "Off on the Mac", retryable: false, rev: 0)]
            default: return []
            }
        }
        #expect(try await c.send(.chatCancel, HostApiChatCancelRequest(), as: HostApiChatCancelResult.self).cancelled)
        await #expect(throws: HostApiRejection(replyTo: "c-x", code: "denied", message: "Off on the Mac")) {
            _ = try await c.send(.chatHistoryClear, HostApiChatHistoryClearRequest(), id: "c-x", as: HostApiChatHistoryClearResult.self)
        }
        do {
            _ = try await c.send(.chatSend, HostApiChatSendRequest(text: "hi"), id: "c-y", as: HostApiChatSendResult.self)
            Issue.record("expected a timeout")
        } catch let r as HostApiRejection {
            #expect(r.code == "host_unreachable")
            #expect(r.retryable == false, "chat.send is not idempotent")
        }
    }

    @Test("an event rev gap emits resync before the event; capabilities events update the set")
    func revGapAndCapabilities() async throws {
        happyHost(rev: 4)
        let c = client()
        var events: [HostEvent] = []
        c.onEvent = { events.append($0) }
        _ = await c.connect(.token(Self.token))
        socket.push(try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: "a"), rev: 5, replyTo: "c-1"))
        socket.push(try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: "b"), rev: 9, replyTo: "c-1"))
        socket.push(try HostApiFrame.event("host.capabilities", payload: HostApiHostCapabilitiesEvent(capabilities: ["host"]), rev: 10))
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(events.count == 5)
        #expect(events[0] == .event(.chatDelta, payload: try JSONEncoder().encode(HostApiChatDeltaEvent(text: "a")), replyTo: "c-1"))
        #expect(events[1] == .resync)
        #expect(events[3] == .capabilities(["host"]))
        #expect(c.capabilities == ["host"])
    }

    @Test("a socket that dies after connect reports disconnected host_unreachable; an unsolicited auth_failed reports auth_failed")
    func drops() async throws {
        happyHost()
        let c = client()
        var events: [HostEvent] = []
        c.onEvent = { events.append($0) }
        _ = await c.connect(.token(Self.token))
        socket.push(HostApiFrame.error(replyTo: nil, code: "auth_failed", message: "This device was removed on the Mac.", retryable: false, rev: 0))
        try await Task.sleep(nanoseconds: 50_000_000)
        guard case .disconnected(let r) = events.last else { Issue.record("expected disconnected"); return }
        #expect(r.code == "auth_failed")
        #expect(c.state == .disconnected)

        let other = FakeHostSocket()
        other.reply = socket.reply
        let d = HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", pingInterval: 60), makeSocket: { other })
        var dEvents: [HostEvent] = []
        d.onEvent = { dEvents.append($0) }
        _ = await d.connect(.token(Self.token))
        other.fail()
        try await Task.sleep(nanoseconds: 50_000_000)
        guard case .disconnected(let lost) = dEvents.last else { Issue.record("expected disconnected"); return }
        #expect(lost.code == "host_unreachable"); #expect(lost.retryable)
    }

    @Test("send while disconnected throws host_unreachable without touching the socket")
    func sendDisconnected() async {
        await #expect(throws: HostApiRejection.self) {
            _ = try await client().send(.hostPing, HostApiHostPingRequest(), as: HostApiHostPingResult.self)
        }
        #expect(socket.sentCommands.isEmpty)
    }
}
```

The `events.count == 5` expectation is three events, plus one `.resync` before the gap event, plus one `.capabilities` before the capabilities event. The `.capabilities` notice comes before that event's `.event` entry.

- [ ] **Step 2: Run it to verify it fails**

Run: `make test-shared-protocol`
Expected: compile failure, `cannot find type 'HostApiSocket' in scope`.

- [ ] **Step 3: Write the socket seam**

`ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSocket.swift`:

```swift
import Foundation
import Security

/// The one socket a `HostApiV1Client` talks through: URLSession in the app, a scripted fake in tests.
public protocol HostApiSocket: AnyObject, Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> Data
    func cancel()
}

/// Plan 6 seam (spec "Security": "The host certificate fingerprint is carried in the pairing QR and pinned
/// by the client"). It decides whether a TLS server trust is the paired host.
public protocol HostApiTrustEvaluating: Sendable {
    func evaluate(_ trust: SecTrust, host: String) -> Bool
}

/// `URLSessionWebSocketTask` behind `HostApiSocket`. It has one ephemeral session per socket, invalidated
/// on `cancel`, so a reconnect never leaks a session. A TLS challenge goes to `trust`; with none, every
/// TLS host is refused rather than trusted through the system store.
public final class URLSessionHostApiSocket: NSObject, HostApiSocket, URLSessionDelegate, @unchecked Sendable {
    private let trust: HostApiTrustEvaluating?
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!

    public init(url: URL, trust: HostApiTrustEvaluating? = nil) {
        self.trust = trust
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = HostApi.limits.maxFrameBytes
        task.resume()
    }

    public func send(_ text: String) async throws { try await task.send(.string(text)) }

    public func receive() async throws -> Data {
        switch try await task.receive() {
        case .string(let s): return Data(s.utf8)
        case .data(let d): return d
        @unknown default: return Data()
        }
    }

    public func cancel() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            return completionHandler(.performDefaultHandling, nil)
        }
        guard let trust, trust.evaluate(serverTrust, host: challenge.protectionSpace.host) else {
            return completionHandler(.cancelAuthenticationChallenge, nil)
        }
        completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
}
```

- [ ] **Step 4: Write the client**

`ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV1Client.swift`:

```swift
import Foundation

/// Host API v1 over one WebSocket (spec "Handshake", "Reconnect after iOS suspends"). It owns hello, auth,
/// request correlation, a ping watchdog and `rev`-gap detection. It has no reconnect loop: the app's
/// existing backoff calls `connect` again with the token.
@MainActor
public final class HostApiV1Client: HostConnection {
    public struct Config: Sendable {
        public var clientName: String
        public var clientVersion: String
        public var helloTimeout: TimeInterval
        public var requestTimeout: TimeInterval
        public var pingInterval: TimeInterval
        public init(clientName: String, clientVersion: String, helloTimeout: TimeInterval = 3,
                    requestTimeout: TimeInterval = 15, pingInterval: TimeInterval = 10) {
            self.clientName = clientName; self.clientVersion = clientVersion
            self.helloTimeout = helloTimeout; self.requestTimeout = requestTimeout; self.pingInterval = pingInterval
        }
    }

    public enum ConnectOutcome: Sendable, Equatable {
        /// Authenticated. `token` is set when this connect paired with a PIN; the caller must store it.
        case ready(hello: HostApiHostHelloResult, token: String?)
        /// No v1 answer: use the v2 transport.
        case notV1
        /// A v1 host refused: bad PIN, revoked token, throttle, busy.
        case refused(HostApiRejection)
    }

    public let apiVersion = 1
    public private(set) var state: HostConnectionState = .disconnected
    public private(set) var capabilities: Set<String> = []
    public var onEvent: ((HostEvent) -> Void)?

    private let config: Config
    private let makeSocket: () -> HostApiSocket
    private var socket: HostApiSocket?
    private var pending: [String: (command: HostApiCommand, continuation: CheckedContinuation<Data, Error>)] = [:]
    private var revs = HostApiRevTracker()
    private var generation = 0
    private var readTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?

    /// No reply in time, or the socket failed. It never leaves the client: `send` turns it into `host_unreachable`.
    private struct Silence: Error {}

    public init(config: Config, makeSocket: @escaping () -> HostApiSocket) {
        self.config = config
        self.makeSocket = makeSocket
    }

    public func connect(_ credential: HostCredential) async -> ConnectOutcome {
        teardown()
        let gen = generation
        let s = makeSocket()
        socket = s
        state = .connecting
        startReading(s, generation: gen)
        var negotiation = HostApiNegotiation()
        _ = negotiation.handle(.start(v1Endpoint: true))

        let hello: HostApiHostHelloResult
        do {
            let request = HostApiHostHelloRequest(
                apiVersions: [HostApi.version],
                clientName: HostApiFrame.clamp(config.clientName.isEmpty ? "iPhone" : config.clientName, maxUTF16: 120),
                clientVersion: HostApiFrame.clamp(config.clientVersion.isEmpty ? "0" : config.clientVersion, maxUTF16: 64),
                platform: "ios")
            hello = try JSONDecoder().decode(HostApiHostHelloResult.self,
                                             from: try await self.request(.hostHello, request, timeout: config.helloTimeout))
        } catch let r as HostApiRejection {
            return finish(negotiation.handle(.helloRefused(r)))
        } catch {
            return finish(negotiation.handle(.silent))
        }
        switch negotiation.handle(.helloAnswered(apiVersion: hello.apiVersion, requiresAuth: hello.requiresAuth)) {
        case .sendAuth: break
        case .ready: return ready(hello, token: nil, gen)
        case let other: return finish(other)
        }
        capabilities = Set(hello.capabilities)
        do {
            switch credential {
            case .pin(let pin):
                let r = try JSONDecoder().decode(HostApiHostAuthPairResult.self, from: try await request(
                    .hostAuthPair, HostApiHostAuthPairRequest(pin: pin), timeout: config.requestTimeout))
                capabilities = Set(r.capabilities)
                _ = negotiation.handle(.authAnswered)
                return ready(hello, token: r.token, gen)
            case .token(let token):
                let r = try JSONDecoder().decode(HostApiHostAuthTokenResult.self, from: try await request(
                    .hostAuthToken, HostApiHostAuthTokenRequest(token: token), timeout: config.requestTimeout))
                capabilities = Set(r.capabilities)
                _ = negotiation.handle(.authAnswered)
                return ready(hello, token: nil, gen)
            }
        } catch let r as HostApiRejection {
            return finish(negotiation.handle(.authRefused(r)))
        } catch {
            return finish(negotiation.handle(.silent))
        }
    }

    public func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        guard state == .connected else {
            throw HostApiRejection(replyTo: id, code: "host_unreachable", message: "Not connected to the host.", retryable: true)
        }
        let value = try JSONDecoder().decode(HostApiJSONValue.self, from: payload)
        do {
            return try await request(command, value, id: id, timeout: config.requestTimeout)
        } catch is Silence {
            // Spec "Wire envelope": only an idempotent command may be retried with the same id.
            throw HostApiRejection(replyTo: id, code: "host_unreachable", message: "The host did not answer in time.",
                                   retryable: command.idempotent)
        }
    }

    /// Silent: the caller chose to close and needs no event.
    public func close() { teardown() }

    // MARK: - Internals

    private func ready(_ hello: HostApiHostHelloResult, token: String?, _ gen: Int) -> ConnectOutcome {
        guard gen == generation, socket != nil else {
            return .refused(.init(replyTo: nil, code: "host_unreachable", message: "The connection closed while signing in.", retryable: true))
        }
        state = .connected
        startPing(generation: gen)
        return .ready(hello: hello, token: token)
    }

    private func finish(_ action: HostApiNegotiation.Action) -> ConnectOutcome {
        teardown()
        switch action {
        case .connectV2: return .notV1
        case .fail(let r): return .refused(r)
        default: return .refused(.init(replyTo: nil, code: "internal", message: "Host API negotiation reached an unexpected step."))
        }
    }

    private func teardown() {
        generation += 1
        readTask?.cancel(); readTask = nil
        pingTask?.cancel(); pingTask = nil
        socket?.cancel(); socket = nil
        let waiting = pending
        pending.removeAll()
        for (_, p) in waiting { p.continuation.resume(throwing: Silence()) }
        revs.reset()
        state = .disconnected
    }

    private func request<P: Encodable>(_ command: HostApiCommand, _ payload: P, id: String? = nil,
                                       timeout: TimeInterval) async throws -> Data {
        guard let socket else { throw Silence() }
        let id = id ?? HostApiFrame.newClientId()
        guard pending[id] == nil else {
            throw HostApiRejection(replyTo: id, code: "busy", message: "That request id is still waiting for a reply.")
        }
        let frame = String(decoding: try HostApiFrame.request(id: id, command: command, payload: payload), as: UTF8.self)
        let gen = generation
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = (command, continuation)
            Task { [weak self] in
                do { try await socket.send(frame) } catch { self?.resolve(id, gen, throwing: Silence()) }
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.resolve(id, gen, throwing: Silence())
            }
        }
    }

    private func resolve(_ id: String, _ gen: Int, throwing error: Error) {
        guard gen == generation else { return }
        pending.removeValue(forKey: id)?.continuation.resume(throwing: error)
    }

    private func startReading(_ s: HostApiSocket, generation gen: Int) {
        readTask = Task { [weak self] in
            while true {
                let data: Data
                do { data = try await s.receive() } catch { self?.socketEnded(gen); return }
                guard let self, gen == self.generation else { return }
                self.handle(data)
            }
        }
    }

    private func startPing(generation gen: Int) {
        pingTask = Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: UInt64((self?.config.pingInterval ?? 10) * 1_000_000_000))
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                do { _ = try await self.request(.hostPing, HostApiHostPingRequest(), timeout: self.config.requestTimeout) }
                catch is Silence { self.socketEnded(gen); return }
                catch { /* a refusal still proves the host is alive */ }
            }
        }
    }

    private func socketEnded(_ gen: Int) {
        guard gen == generation else { return }
        let wasConnected = state == .connected
        teardown()
        if wasConnected {
            onEvent?(.disconnected(reason: .init(replyTo: nil, code: "host_unreachable",
                                                 message: "The connection to the host was lost.", retryable: true)))
        }
    }

    private func handle(_ data: Data) {
        guard case .success(let frame) = HostApiFrame.parseInbound(data) else { return }
        switch frame {
        case let .response(replyTo, command, result, rev):
            revs.baseline(rev)
            guard let p = pending.removeValue(forKey: replyTo) else { return }
            if p.command == command {
                p.continuation.resume(returning: result)
            } else {
                p.continuation.resume(throwing: HostApiRejection(replyTo: replyTo, code: "internal",
                    message: "The host answered \(p.command.rawValue) with \(command.rawValue)."))
            }
        case let .error(replyTo, rejection, rev):
            if let rev { revs.baseline(rev) }
            if let replyTo, let p = pending.removeValue(forKey: replyTo) {
                p.continuation.resume(throwing: rejection)
            } else if rejection.code == "auth_failed" || state != .connected {
                // Unsolicited: the device was removed on the host, or the host refused the connection
                // (busy) before answering. Every waiter gets the host's reason, not a timeout.
                let wasConnected = state == .connected
                let waiting = pending
                pending.removeAll()
                for (_, p) in waiting { p.continuation.resume(throwing: rejection) }
                if wasConnected { teardown(); onEvent?(.disconnected(reason: rejection)) }
            }
        case let .event(name, payload, replyTo, rev):
            if revs.observe(event: rev) == .gap { onEvent?(.resync) }
            if name == .hostCapabilities,
               let e = try? JSONDecoder().decode(HostApiHostCapabilitiesEvent.self, from: payload) {
                capabilities = Set(e.capabilities)
                onEvent?(.capabilities(capabilities))
            }
            onEvent?(.event(name, payload: payload, replyTo: replyTo))
        }
    }
}
```

The `withCheckedThrowingContinuation` body is a non-`Sendable` closure, so it inherits the main actor and may touch `pending`.

- [ ] **Step 5: Run the tests**

Run: `make test-shared-protocol`
Expected: `HostApiV1Client` passes (9 tests), the other suites stay green, and the full run takes under 10 s (the shortest timeout is 0.2 s).

Run (unsandboxed): `cd mac && swift build 2>&1 | tail -3`
Expected: `Build complete!`.

- [ ] **Step 6: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSocket.swift \
  ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV1Client.swift \
  ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV1ClientTests.swift
git commit -m "feat(shared-protocol): Host API v1 client with hello, auth, ping watchdog and rev resync"
```

---

### Task 4: `HostApiV2ChatBridge`, the v2 ⇄ v1 mapping for chat + approvals (pure) [parallel-safe with Tasks 2 and 3]

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV2ChatBridge.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV2ChatBridgeTests.swift`

**Interfaces:**
- Consumes: `HostEvent`, `HostApiEvent` (Task 1), the generated payloads, and the v2 types `LlmIdeChat`, `LlmIdeCancel`, `LlmIdeChatHistoryList`/`Reply`/`Clear`/`ClearAck`, `ApprovalRequest`/`Answer`/`Cleared`, `ToolApprovalRequest`/`Answer`, `CommandError`.
- Produces:
  - `HostApiV2ChatBridge.outbound(_:payload:id:cancelTarget:) throws -> Data?`
  - `inbound(type:json:data:) -> [HostEvent]`
  - `snapshotResult(_:)`, `clearResult(_:)`
  - `approvalRequest(_:)`, `toolApprovalRequest(_:)`, `approvalCleared(_:)`

- [ ] **Step 1: Write the failing test**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV2ChatBridgeTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

@Suite("HostApiV2ChatBridge")
struct HostApiV2ChatBridgeTests {
    private let enc = JSONEncoder()
    private func json(_ d: Data) -> [String: Any] { try! JSONSerialization.jsonObject(with: d) as! [String: Any] }
    private func inbound<T: Encodable>(_ v: T, type: String) throws -> [HostEvent] {
        let d = try enc.encode(v)
        return HostApiV2ChatBridge.inbound(type: type, json: json(d), data: d)
    }
    /// Every v1 event the bridge emits must be a valid v1 event frame.
    private func assertValid(_ events: [HostEvent]) throws {
        for case .event(let name, let payload, let replyTo) in events {
            let value = try JSONDecoder().decode(HostApiJSONValue.self, from: payload)
            _ = try HostApiFrame.event(name.rawValue, payload: value, rev: 1, replyTo: replyTo)
        }
    }

    @Test("outbound v2 frames are byte-identical to what LlmIdeChatStore sent before")
    func outboundBytes() throws {
        let send = try enc.encode(HostApiChatSendRequest(attachments: [.init(name: "a.md", text: "x")], text: "hi"))
        #expect(try HostApiV2ChatBridge.outbound(.chatSend, payload: send, id: "u-1", cancelTarget: nil)
                == enc.encode(LlmIdeChat(commandId: "u-1", text: "hi", files: [ChatFileText(name: "a.md", text: "x")])))
        let plain = try enc.encode(HostApiChatSendRequest(text: "hi"))
        #expect(try HostApiV2ChatBridge.outbound(.chatSend, payload: plain, id: "u-2", cancelTarget: nil)
                == enc.encode(LlmIdeChat(commandId: "u-2", text: "hi", files: [])))
        #expect(try HostApiV2ChatBridge.outbound(.chatCancel, payload: enc.encode(HostApiChatCancelRequest()), id: "x", cancelTarget: "u-1")
                == enc.encode(LlmIdeCancel(commandId: "u-1")))
        #expect(try HostApiV2ChatBridge.outbound(.chatCancel, payload: enc.encode(HostApiChatCancelRequest()), id: "x", cancelTarget: nil) == nil)
        #expect(try HostApiV2ChatBridge.outbound(.chatSnapshot, payload: enc.encode(HostApiChatSnapshotRequest(limit: 50)), id: "x", cancelTarget: nil)
                == enc.encode(LlmIdeChatHistoryList(limit: 50)))
        #expect(try HostApiV2ChatBridge.outbound(.chatHistoryClear, payload: enc.encode(HostApiChatHistoryClearRequest()), id: "x", cancelTarget: nil)
                == enc.encode(LlmIdeChatHistoryClear()))
        #expect(try HostApiV2ChatBridge.outbound(.approvalsAnswer, payload: enc.encode(HostApiApprovalsAnswerRequest(answers: ["Q": "Yes"], commandId: "u-1", requestId: "r-1")), id: "x", cancelTarget: nil)
                == enc.encode(ApprovalAnswer(commandId: "u-1", requestId: "r-1", answers: ["Q": "Yes"])))
        for (decision, allow) in [("allow_once", true), ("deny", false)] {
            #expect(try HostApiV2ChatBridge.outbound(.toolApprovalsAnswer, payload: enc.encode(HostApiToolApprovalsAnswerRequest(commandId: "u-1", decision: decision, requestId: "r-2")), id: "x", cancelTarget: nil)
                    == enc.encode(ToolApprovalAnswer(commandId: "u-1", requestId: "r-2", allow: allow)))
        }
        #expect(try HostApiV2ChatBridge.outbound(.hostPing, payload: enc.encode(HostApiHostPingRequest()), id: "x", cancelTarget: nil) == nil)
    }

    @Test("output: progress stays progress; done becomes delta + done; empty chunks emit nothing")
    func output() throws {
        #expect(try inbound(Output(commandId: "u-1", payload: .init(stream: "Reading file…", done: false)), type: "output")
                == [.progress(replyTo: "u-1", text: "Reading file…")])
        #expect(try inbound(Output(commandId: "u-1", payload: .init(stream: "", done: false)), type: "output").isEmpty)
        let done = try inbound(Output(commandId: "u-1", payload: .init(stream: "The answer", done: true)), type: "output")
        #expect(done == [.event(.chatDelta, payload: try enc.encode(HostApiChatDeltaEvent(text: "The answer")), replyTo: "u-1"),
                         .event(.chatDone, payload: try enc.encode(HostApiChatDoneEvent(requestId: "u-1")), replyTo: "u-1")])
        try assertValid(done)
        #expect(try inbound(Output(commandId: "u-1", payload: .init(stream: nil, done: true)), type: "output")
                == [.event(.chatDone, payload: try enc.encode(HostApiChatDoneEvent(requestId: "u-1")), replyTo: "u-1")])
    }

    @Test("error frames become chat.error, with or without a command id")
    func errors() throws {
        let owned = try inbound(CommandError(commandId: "u-1", message: "Boom"), type: "error")
        #expect(owned == [.event(.chatError, payload: try enc.encode(HostApiChatErrorEvent(message: "Boom")), replyTo: "u-1")])
        let global = try inbound(CommandError(commandId: nil, message: "Down"), type: "error")
        #expect(global == [.event(.chatError, payload: try enc.encode(HostApiChatErrorEvent(message: "Down")), replyTo: nil)])
    }

    @Test("approval frames round-trip v2 → v1 event → the same v2 view model")
    func approvals() throws {
        let request = ApprovalRequest(commandId: "u-1", requestId: "r-1", questions: [
            MobileApprovalQuestion(question: "Run it?", header: "Approve",
                                   options: [MobileApprovalOption(label: "Yes", description: "now"), MobileApprovalOption(label: "No", description: nil)],
                                   multiSelect: false)])
        let events = try inbound(request, type: MobileProtocol.Tag.approvalRequest)
        try assertValid(events)
        guard case .event(.approvalRequest, let p, "u-1") = events.first else { Issue.record("approval.request"); return }
        #expect(HostApiV2ChatBridge.approvalRequest(try JSONDecoder().decode(HostApiApprovalRequestEvent.self, from: p)) == request)

        let tool = ToolApprovalRequest(commandId: "u-1", requestId: "r-2", toolName: "Edit", summary: "Edit a.swift",
                                       filePath: "a.swift", oldString: "a", newString: "b", contentPreview: nil,
                                       command: nil, truncated: false, replaceAll: false, overwrites: nil)
        let toolEvents = try inbound(tool, type: MobileProtocol.Tag.toolApprovalRequest)
        try assertValid(toolEvents)
        guard case .event(.toolApprovalRequest, let tp, _) = toolEvents.first else { Issue.record("toolApproval.request"); return }
        #expect(HostApiV2ChatBridge.toolApprovalRequest(try JSONDecoder().decode(HostApiToolApprovalRequestEvent.self, from: tp)) == tool)

        let cleared = ApprovalCleared(commandId: "u-1", requestId: "r-1", reason: "Answered on the Mac")
        let clearedEvents = try inbound(cleared, type: MobileProtocol.Tag.approvalCleared)
        try assertValid(clearedEvents)
        guard case .event(.approvalCleared, let cp, _) = clearedEvents.first else { Issue.record("approval.cleared"); return }
        #expect(HostApiV2ChatBridge.approvalCleared(try JSONDecoder().decode(HostApiApprovalClearedEvent.self, from: cp)) == cleared)
    }

    @Test("history reply and clear ack map to their v1 results; other frames map to nothing")
    func replies() throws {
        let reply = try enc.encode(LlmIdeChatHistoryReply(messages: [ChatTurn(role: "user", content: "hi"), ChatTurn(role: "assistant", content: "yo")]))
        #expect(HostApiV2ChatBridge.snapshotResult(reply) == HostApiChatSnapshotResult(messages: [.init(content: "hi", role: "user"), .init(content: "yo", role: "assistant")]))
        #expect(HostApiV2ChatBridge.clearResult(try enc.encode(LlmIdeChatHistoryClearAck(ok: false))) == HostApiChatHistoryClearResult(cleared: false))
        #expect(HostApiV2ChatBridge.inbound(type: "loop_state", json: [:], data: Data("{}".utf8)).isEmpty)
    }
}
```

The v2 reply frame is `Output(commandId:payload: OutputPayload(stream:done:))` (`LlmIdeChatMessages.swift`).

- [ ] **Step 2: Run it to verify it fails**

Run: `make test-shared-protocol`
Expected: compile failure, `cannot find 'HostApiV2ChatBridge' in scope`.

- [ ] **Step 3: Write the bridge**

`ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV2ChatBridge.swift`:

```swift
import Foundation

/// The chat + approvals slice of MobileProtocol v2, spoken in Host API v1 vocabulary, so a store behind
/// `HostConnection` sees the same commands and events on a v1 host and on the v2 fallback. This is the
/// inverse of the Mac's `HostApiV2Translator`. It is pure: no socket, no state.
public enum HostApiV2ChatBridge {
    /// The v2 frame for a v1 command, or nil when the command has no v2 form here. `cancelTarget` is the
    /// chat request a v2 `Cancel` names; v1 `chat.cancel` names none.
    public static func outbound(_ command: HostApiCommand, payload: Data, id: String, cancelTarget: String?) throws -> Data? {
        let d = JSONDecoder(), e = JSONEncoder()
        switch command {
        case .chatSend:
            let p = try d.decode(HostApiChatSendRequest.self, from: payload)
            return try e.encode(LlmIdeChat(commandId: id, text: p.text,
                                           files: (p.attachments ?? []).map { ChatFileText(name: $0.name, text: $0.text) }))
        case .chatCancel:
            return try cancelTarget.map { try e.encode(LlmIdeCancel(commandId: $0)) }
        case .chatSnapshot:
            let p = try d.decode(HostApiChatSnapshotRequest.self, from: payload)
            return try e.encode(LlmIdeChatHistoryList(limit: p.limit ?? HostApi.limits.defaultListItems))
        case .chatHistoryClear:
            return try e.encode(LlmIdeChatHistoryClear())
        case .approvalsAnswer:
            let p = try d.decode(HostApiApprovalsAnswerRequest.self, from: payload)
            return try e.encode(ApprovalAnswer(commandId: p.commandId, requestId: p.requestId, answers: p.answers))
        case .toolApprovalsAnswer:
            let p = try d.decode(HostApiToolApprovalsAnswerRequest.self, from: payload)
            return try e.encode(ToolApprovalAnswer(commandId: p.commandId, requestId: p.requestId, allow: p.decision == "allow_once"))
        default:
            return nil
        }
    }

    /// The v1 events for one inbound v2 frame of the chat slice; [] for any other frame type.
    public static func inbound(type: String, json: [String: Any], data: Data) -> [HostEvent] {
        let d = JSONDecoder()
        func event<P: Encodable>(_ name: HostApiEvent, _ payload: P, _ replyTo: String?) -> HostEvent? {
            (try? JSONEncoder().encode(payload)).map { .event(name, payload: $0, replyTo: replyTo) }
        }
        switch type {
        case MobileProtocol.Tag.output:
            guard let id = json["commandId"] as? String, let p = json["payload"] as? [String: Any] else { return [] }
            let text = p["stream"] as? String ?? ""
            guard p["done"] as? Bool == true else { return text.isEmpty ? [] : [.progress(replyTo: id, text: text)] }
            return [text.isEmpty ? nil : event(.chatDelta, HostApiChatDeltaEvent(text: text), id),
                    event(.chatDone, HostApiChatDoneEvent(requestId: id), id)].compactMap { $0 }
        case MobileProtocol.Tag.error:
            guard let e = try? d.decode(CommandError.self, from: data) else { return [] }
            return [event(.chatError, HostApiChatErrorEvent(message: e.message), e.commandId)].compactMap { $0 }
        case MobileProtocol.Tag.approvalRequest:
            guard let r = try? d.decode(ApprovalRequest.self, from: data) else { return [] }
            let questions = r.questions.map { q in
                HostApiApprovalRequestEventQuestionsItem(
                    header: q.header, multiSelect: q.multiSelect,
                    options: q.options.map { .init(description: $0.description, label: $0.label) }, question: q.question)
            }
            return [event(.approvalRequest, HostApiApprovalRequestEvent(commandId: r.commandId, questions: questions,
                                                                        requestId: r.requestId), r.commandId)].compactMap { $0 }
        case MobileProtocol.Tag.approvalCleared:
            guard let c = try? d.decode(ApprovalCleared.self, from: data) else { return [] }
            return [event(.approvalCleared, HostApiApprovalClearedEvent(commandId: c.commandId, reason: c.reason,
                                                                        requestId: c.requestId), c.commandId)].compactMap { $0 }
        case MobileProtocol.Tag.toolApprovalRequest:
            guard let t = try? d.decode(ToolApprovalRequest.self, from: data) else { return [] }
            return [event(.toolApprovalRequest, HostApiToolApprovalRequestEvent(
                command: t.command, commandId: t.commandId, contentPreview: t.contentPreview, filePath: t.filePath,
                newString: t.newString, oldString: t.oldString, overwrites: t.overwrites, replaceAll: t.replaceAll,
                requestId: t.requestId, summary: t.summary, toolName: t.toolName, truncated: t.truncated), t.commandId)].compactMap { $0 }
        default:
            return []
        }
    }

    public static func snapshotResult(_ data: Data) -> HostApiChatSnapshotResult? {
        (try? JSONDecoder().decode(LlmIdeChatHistoryReply.self, from: data)).map {
            HostApiChatSnapshotResult(messages: $0.messages.map { .init(content: $0.content, role: $0.role) })
        }
    }

    public static func clearResult(_ data: Data) -> HostApiChatHistoryClearResult? {
        (try? JSONDecoder().decode(LlmIdeChatHistoryClearAck.self, from: data)).map { HostApiChatHistoryClearResult(cleared: $0.ok) }
    }

    // v1 event payloads mapped onto the v2 structs the chat views already render.

    public static func approvalRequest(_ e: HostApiApprovalRequestEvent) -> ApprovalRequest {
        ApprovalRequest(commandId: e.commandId, requestId: e.requestId, questions: e.questions.map { q in
            MobileApprovalQuestion(question: q.question, header: q.header,
                                   options: q.options.map { MobileApprovalOption(label: $0.label, description: $0.description) },
                                   multiSelect: q.multiSelect)
        })
    }

    public static func toolApprovalRequest(_ e: HostApiToolApprovalRequestEvent) -> ToolApprovalRequest {
        ToolApprovalRequest(commandId: e.commandId, requestId: e.requestId, toolName: e.toolName, summary: e.summary,
                            filePath: e.filePath, oldString: e.oldString, newString: e.newString,
                            contentPreview: e.contentPreview, command: e.command, truncated: e.truncated,
                            replaceAll: e.replaceAll, overwrites: e.overwrites)
    }

    public static func approvalCleared(_ e: HostApiApprovalClearedEvent) -> ApprovalCleared {
        ApprovalCleared(commandId: e.commandId, requestId: e.requestId, reason: e.reason)
    }
}
```

If the `assertValid` check fails on a field length, it means a v2 value exceeds a v1 schema limit, for example a tool `summary` that is too long. Clamp that field with `HostApiFrame.clamp` to the schema's `maxLength` (read it from `schema/host-api/v1/events.schema.json`). Do not relax the test.

- [ ] **Step 4: Run the tests**

Run: `make test-shared-protocol`
Expected: `HostApiV2ChatBridge` passes (5 tests), and the other suites stay green.

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV2ChatBridge.swift \
  ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiV2ChatBridgeTests.swift
git commit -m "feat(shared-protocol): v2 chat and approvals bridge in Host API v1 vocabulary"
```

---

### Task 5: App transport: v1 token, `V2HostConnection`, negotiation in `ConnectionService` (needs Tasks 1–4)

**Files:**
- Modify: `ios_app/MyApp/Services/ConnectionStore.swift`
- Create: `ios_app/MyApp/Services/V2HostConnection.swift`
- Modify: `ios_app/MyApp.xcodeproj/project.pbxproj`
- Modify: `ios_app/MyApp/Services/ConnectionService.swift`

**Interfaces:**
- Produces: `ConnectionStore.hostApiToken`, `saveHostApiToken(_:) -> Bool` and `hostApiEndpoint: HostApiEndpoint?`.
- Produces: `ConnectionService.host: HostConnection`, `hostApiVersion: Int` (published), `v2Host: V2HostConnection` and `sendV2Frame(_:userFacing:) -> Bool`.
- Produces: `V2HostConnection.receive(type:json:data:)` and `connectionEnded()`.
- In this task the chat store still uses its old v2 calls. Task 6 flips it, so this commit changes nothing a user can see.

- [ ] **Step 1: Keychain account and endpoint in `ConnectionStore`**

Add `import SharedProtocol`. In `CredentialKeychain.Account` add `case hostApiToken = "host-api-token"`. In `ConnectionStore`:

```swift
    /// Host API v1 device token (spec "Security": in Keychain on iOS). Separate from the v2 `deviceToken`:
    /// the Mac keeps v1 and v2 devices apart. Empty until a v1 pairing.
    @Published private(set) var hostApiToken: String
```

- Initialise it in `init` with `CredentialKeychain.load(account: .hostApiToken) ?? ""`.
- Change `hasDevice` to `!deviceIP.isEmpty && (!deviceToken.isEmpty || !hostApiToken.isEmpty || !devicePIN.isEmpty)`.
- In `clearToken()`, also clear `hostApiToken` and delete `.hostApiToken`. A fresh PIN and `clearCredentials()` then drop both tokens.
- In `clear()`, also set `hostApiToken = ""` and delete `.hostApiToken`.
- Add these members:

```swift
    /// Same contract as `saveToken`, for the v1 token. It drops the PIN, which the host rotated.
    @discardableResult
    func saveHostApiToken(_ token: String) -> Bool {
        guard !token.isEmpty, CredentialKeychain.save(token, account: .hostApiToken) else { return false }
        hostApiToken = token
        devicePIN = ""
        CredentialKeychain.delete(account: .pin)
        return true
    }

    /// Where to try Host API v1 first; nil means go straight to v2. That is every release build until spec
    /// phase 6 (WSS + pinning) puts the v1 port in Bonjour and the QR. Development only: a DEBUG build reads
    /// `LLMIDE_HOST_API_URL` from the Xcode scheme (Run → Environment), e.g. `ws://127.0.0.1:3016/host-api/v1`
    /// for the Simulator against a DEBUG Mac or desktop host started with `LLMIDE_HOST_API_DEV=1`.
    var hostApiEndpoint: HostApiEndpoint? {
        #if DEBUG
        return ProcessInfo.processInfo.environment["LLMIDE_HOST_API_URL"].flatMap(HostApiEndpoint.init)
        #else
        return nil
        #endif
    }
```

The Debug configuration already sets `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG` (`project.pbxproj`).

- [ ] **Step 2: Create `V2HostConnection.swift`**

`ios_app/MyApp/Services/V2HostConnection.swift`:

```swift
import Foundation
import SharedProtocol

/// `HostConnection` over today's MobileProtocol v2 socket (spec "Compatibility with MobileProtocol v2").
/// `ConnectionService` still owns pairing, heartbeat and backoff; this only translates the chat + approvals
/// slice through `HostApiV2ChatBridge`, so the moved store speaks one vocabulary on either wire.
@MainActor
final class V2HostConnection: HostConnection {
    let apiVersion = 2
    var onEvent: ((HostEvent) -> Void)?

    private unowned let service: ConnectionService
    /// The chat request Stop cancels. v1 `chat.cancel` names none, but a v2 `Cancel` needs one. This is the
    /// latest `chat.send` until its done or error, the same id the store's `currentCommandId` held.
    private var lastChatSend: String?
    private enum Reply { case snapshot, clear }
    private var waiters: [Reply: [(id: UUID, continuation: CheckedContinuation<Data, Error>)]] = [:]
    private static let replyTimeout: TimeInterval = 15

    init(service: ConnectionService) { self.service = service }

    var state: HostConnectionState {
        switch service.connectionStatus {
        case .connected: return .connected
        case .connecting: return .connecting
        case .disconnected: return .disconnected
        }
    }

    /// v2 has no `host` or `approvals` capability; both come with any v2 connection that serves chat.
    var capabilities: Set<String> {
        let caps = service.macCapabilities ?? MobileProtocol.Capability.legacy
        return caps.contains(MobileProtocol.Capability.chat) ? caps.union(["host", "approvals"]) : caps.union(["host"])
    }

    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        let id = id ?? UUID().uuidString
        let enc = JSONEncoder()
        guard let frame = try HostApiV2ChatBridge.outbound(command, payload: payload, id: id, cancelTarget: lastChatSend) else {
            if command == .chatCancel { return try enc.encode(HostApiChatCancelResult(cancelled: false)) }
            throw HostApiRejection(replyTo: id, code: "capability_unavailable",
                                   message: "This Mac does not serve \(command.rawValue) over MobileProtocol v2.")
        }
        switch command {
        case .chatSend:
            // Unguarded, exactly as LlmIdeChatStore sent it before this adapter (the store checks the status).
            service.sendTextFrame(String(decoding: frame, as: UTF8.self))
            lastChatSend = id
            return try enc.encode(HostApiChatSendResult(accepted: true, requestId: id))
        case .chatSnapshot:
            guard service.sendV2Frame(frame) else { throw Self.unreachable(id) }
            return try await awaitReply(.snapshot, requestId: id)
        case .chatHistoryClear:
            guard service.sendV2Frame(frame, userFacing: true) else { throw Self.unreachable(id) }
            return try await awaitReply(.clear, requestId: id)
        case .chatCancel:
            return try enc.encode(HostApiChatCancelResult(cancelled: service.sendV2Frame(frame)))
        case .approvalsAnswer:
            return try enc.encode(HostApiApprovalsAnswerResult(accepted: service.sendV2Frame(frame)))
        case .toolApprovalsAnswer:
            return try enc.encode(HostApiToolApprovalsAnswerResult(accepted: service.sendV2Frame(frame)))
        default:
            throw HostApiRejection(replyTo: id, code: "capability_unavailable", message: "Not served over MobileProtocol v2.")
        }
    }

    func close() { service.closeConnection() }

    /// ConnectionService's v2 dispatch hands over the chat slice's frames here.
    func receive(type: String, json: [String: Any], data: Data) {
        switch type {
        case MobileProtocol.Tag.llmIdeChatHistoryReply:
            if let r = HostApiV2ChatBridge.snapshotResult(data), let d = try? JSONEncoder().encode(r) {
                resolve(.snapshot, token: nil, with: .success(d))
            }
        case MobileProtocol.Tag.llmIdeChatHistoryClearAck:
            if let r = HostApiV2ChatBridge.clearResult(data), let d = try? JSONEncoder().encode(r) {
                resolve(.clear, token: nil, with: .success(d))
            }
        default:
            for event in HostApiV2ChatBridge.inbound(type: type, json: json, data: data) {
                if case .event(let name, _, let replyTo) = event,
                   (name == .chatDone && replyTo == lastChatSend) || (name == .chatError && (replyTo == nil || replyTo == lastChatSend)) {
                    lastChatSend = nil
                }
                onEvent?(event)
            }
        }
    }

    /// The socket went away (ConnectionService.invalidateSocket): no pending reply will come. `lastChatSend`
    /// is kept on purpose: today a Stop after a silent reconnect still sends Cancel for the store's current id.
    func connectionEnded() {
        for kind in [Reply.snapshot, .clear] {
            while waiters[kind]?.isEmpty == false { resolve(kind, token: nil, with: .failure(Self.unreachable(nil))) }
        }
    }

    private func awaitReply(_ kind: Reply, requestId: String) async throws -> Data {
        let token = UUID()
        return try await withCheckedThrowingContinuation { c in
            waiters[kind, default: []].append((token, c))
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.replyTimeout * 1_000_000_000))
                self?.resolve(kind, token: token, with: .failure(Self.unreachable(requestId)))
            }
        }
    }

    /// v2 replies carry no id, and the Mac answers in order, so `token == nil` resolves the oldest waiter.
    private func resolve(_ kind: Reply, token: UUID?, with result: Result<Data, Error>) {
        var list = waiters[kind] ?? []
        guard let index = token == nil ? list.indices.first : list.firstIndex(where: { $0.id == token }) else { return }
        let waiter = list.remove(at: index)
        waiters[kind] = list
        waiter.continuation.resume(with: result)
    }

    private static func unreachable(_ id: String?) -> HostApiRejection {
        HostApiRejection(replyTo: id, code: "host_unreachable", message: "Not connected to your Mac.", retryable: true)
    }
}
```

- [ ] **Step 3: Register the file in `project.pbxproj`**

Pick two unused ids. First check that `grep -c 'A7B80010CC0000000000000A\|A7B80010CC0000000000000B' ios_app/MyApp.xcodeproj/project.pbxproj` prints `0`; if it doesn't, choose other ids and check again. Then add four lines, each beside its `LlmIdeChatStore.swift` sibling:
- PBXBuildFile: `A7B80010CC0000000000000A /* V2HostConnection.swift in Sources */ = {isa = PBXBuildFile; fileRef = A7B80010CC0000000000000B /* V2HostConnection.swift */; };`
- PBXFileReference: `A7B80010CC0000000000000B /* V2HostConnection.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = V2HostConnection.swift; sourceTree = "<group>"; };`
- the Services group `children` (after `A7B80010CC00000000000004 /* LlmIdeChatStore.swift */,`): `A7B80010CC0000000000000B /* V2HostConnection.swift */,`
- the Sources build phase (after `A7B80010CC00000000000003 /* LlmIdeChatStore.swift in Sources */,`): `A7B80010CC0000000000000A /* V2HostConnection.swift in Sources */,`

- [ ] **Step 4: `ConnectionService`: transport, negotiation, v1 lifecycle**

Make these edits in `ConnectionService.swift`, in this order.

1. Add these properties next to `macCapabilities`:

```swift
    /// The transport the chat + approvals slice speaks (spec phase 4). It is v2 (today's socket, through
    /// `V2HostConnection`) unless negotiation found a v1 host. The other stores still use `sendEncodable` (v2).
    var host: HostConnection { v1Client ?? v2Host }
    /// 1 while a Host API v1 connection is up, 2 otherwise. Views gate the v2-only screens on it (Plan 4 decision 6).
    @Published private(set) var hostApiVersion = 2
    private(set) lazy var v2Host: V2HostConnection = {
        let h = V2HostConnection(service: self)
        h.onEvent = { [weak self] in self?.route($0) }
        return h
    }()
    private var v1Client: HostApiV1Client?
```

2. Split `connectDirect`. Keep everything up to and including `let generation = connectionGeneration`. Then insert:

```swift
        // Spec "Compatibility with MobileProtocol v2": try host.hello first, but only at a v1 endpoint that is
        // actually known. Port 3016 is never assumed (Plan 4 decision 1).
        var negotiation = HostApiNegotiation()
        if !isDemo, let endpoint = connectionStore?.hostApiEndpoint,
           negotiation.handle(.start(v1Endpoint: true)) == .openV1AndHello {
            connectV1(endpoint, ip: ip, port: port, pin: pin, generation: generation)
            return
        }
        connectV2(ip: ip, port: port, pin: pin, generation: generation)
    }

    /// Today's v2 connect, unchanged: URL, Pairing frame, pairing deadline, receive loop.
    private func connectV2(ip: String, port: Int, pin: String, generation: Int) {
```

Move the rest of the old body (from `var components = URLComponents()` to `receiveMessage(generation: generation)`) into `connectV2` unchanged. `connectV2` sets `connectionStatus = .connecting` only when called from the v1 fallback, where it is already `.connecting`, so the body needs no change.

3. Add the v1 path:

```swift
    private func connectV1(_ endpoint: HostApiEndpoint, ip: String, port: Int, pin: String, generation: Int) {
        let client = HostApiV1Client(
            config: .init(clientName: UIDevice.current.name,
                          clientVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"),
            makeSocket: { URLSessionHostApiSocket(url: endpoint.url) })
        client.onEvent = { [weak self] in self?.route($0) }
        let token = connectionStore?.hostApiToken ?? ""
        let credential: HostCredential = token.isEmpty ? .pin(pin) : .token(token)
        Task { @MainActor [weak self] in
            let outcome = await client.connect(credential)
            guard let self, generation == self.connectionGeneration else { client.close(); return }
            switch outcome {
            case .ready(let hello, let newToken):
                self.v1Client = client
                self.hostApiVersion = 1
                self.macProtocolVersion = hello.protocolVersion
                self.macCapabilities = client.capabilities
                self.errorMessage = nil
                self.reconnectAttempt = 0
                self.connectionStore?.updateDeviceName(hello.hostName)
                if let newToken {
                    self.directPIN = nil
                    if self.connectionStore?.saveHostApiToken(newToken) == false {
                        self.errorMessage = "Connected, but the pairing token could not be saved to the Keychain — you will need to pair again next time."
                    }
                }
                self.connectionStatus = .connected
            case .notV1:
                self.connectV2(ip: ip, port: port, pin: pin, generation: generation)
            case .refused(let r):
                self.handleV1Refusal(r)
            }
        }
    }

    /// A v1 host refused: the same outcomes as v2's `auth_failed`. Retryable (throttle, busy) keeps the
    /// pairing and backs off; anything else clears the credentials and returns to pairing.
    private func handleV1Refusal(_ r: HostApiRejection) {
        errorMessage = r.message.isEmpty ? "Your Mac refused the connection." : r.message
        if r.retryable {
            reconnectAttempt = max(reconnectAttempt, 1)
            invalidateSocket()
            connectionStatus = .disconnected
            scheduleReconnect()
            return
        }
        directPIN = nil
        connectionStore?.clearCredentials()
        disconnect(clearDirect: true)
    }

    /// Transport events → app state and stores. Task 6 adds the chat store routing.
    private func route(_ event: HostEvent) {
        switch event {
        case .capabilities(let caps):
            macCapabilities = caps
        case .disconnected(let reason):
            guard hostApiVersion == 1 else { return }
            if !reason.retryable { return handleV1Refusal(reason) }
            if errorMessage == nil { errorMessage = "Disconnected from the Mac. Retrying…" }
            invalidateSocket()
            connectionStatus = .disconnected
            scheduleReconnect()
        case .event, .progress, .resync:
            break
        }
    }
```

`connectionStatus` is set last in `.ready` so the `didSet` and the views' "on connected, reload" hooks see `hostApiVersion == 1` and the v1 capabilities already in place.

4. In `invalidateSocket()`, append:

```swift
        v1Client?.close()
        v1Client = nil
        hostApiVersion = 2
        v2Host.connectionEnded()
```

5. Split the guard in `sendEncodable` into a shared helper, so the adapter's frames get the exact same connected check:

```swift
    /// sendEncodable's guard, shared with `V2HostConnection`, which sends frames it has already encoded.
    private func canSendV2(userFacing: Bool) -> Bool {
        guard connectionStatus == .connected, webSocketTask != nil || isDemo else {
            if userFacing {
                errorMessage = connectionStatus == .connecting
                    ? "Still connecting to your Mac — wait for Live status, then try again."
                    : "Not connected to your Mac — reconnect from Settings."
            }
            return false
        }
        return true
    }

    @discardableResult
    func sendV2Frame(_ data: Data, userFacing: Bool = false) -> Bool {
        guard canSendV2(userFacing: userFacing) else { return false }
        sendTextFrame(String(decoding: data, as: UTF8.self), userFacing: userFacing)
        return true
    }
```

`sendEncodable`'s first `guard … else { … return false }` becomes `guard canSendV2(userFacing: userFacing) else { return false }`. The rest of it is unchanged.

- [ ] **Step 5: Build**

Run (unsandboxed):
```bash
cd ios_app && xcodebuild -project MyApp.xcodeproj -target MyApp -configuration Debug \
  -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO SYMROOT="$TMPDIR/ios-build" build 2>&1 | tail -5
```
Expected: `** BUILD SUCCEEDED **`. Also run `make test-shared-protocol`, which should still be green.

Behaviour check by reading: with no `LLMIDE_HOST_API_URL`, `connectDirect` reaches `connectV2` with the same arguments and the same body as before, so every v2 path is unchanged. `git diff` of `ConnectionService.swift` shows only moves and additions inside `connectDirect`, plus the guard extraction.

- [ ] **Step 6: Commit**

```bash
git add ios_app/MyApp/Services/ConnectionStore.swift ios_app/MyApp/Services/V2HostConnection.swift \
  ios_app/MyApp.xcodeproj/project.pbxproj ios_app/MyApp/Services/ConnectionService.swift
git commit -m "feat(ios): HostConnection transport with v1 negotiation and the v2 adapter"
```

---

### Task 6: Move the chat + approvals store behind `HostConnection` [parallel-safe with Tasks 7 and 8]

**Files:**
- Modify: `ios_app/MyApp/Services/LlmIdeChatStore.swift`
- Modify: `ios_app/MyApp/Services/ConnectionService.swift` (dispatch and `route` only)

**Interfaces:**
- Produces: `LlmIdeChatStore.handle(_ event: HostEvent)`.
- Removes: `handleInbound(type:data:)` and `handleOutput(commandId:payload:)`.
- Unchanged: the public surface views use (`llmIdeMessages`, `isStreaming`, `pendingApproval`, `pendingToolApproval`, `approvalNotice`, `sendLlmideChat`, `loadSharedHistory`, `clearLlmIdeChat`, `cancelStreaming`, `submitApproval`, `submitToolApproval`, `clearPendingPrompts`, `ownsCommand`, `handleChatError`, `resetForNewDevice`, `preservingAttachments`, `approvalPauseGlyph`, `idleWindow`).

- [ ] **Step 1: Store sends through `HostConnection`**

In `LlmIdeChatStore`, add `private var progressCommandIds: Set<String> = []` with the doc comment "Turns whose bubble shows v2 status lines: the reply replaces them, as the v2 `done` chunk did." Then rewrite these methods. Keep every comment that still applies, and remove each one that names an old frame.

```swift
    func sendLlmideChat(_ text: String, files: [ChatFileText] = []) {
        guard connection?.connectionStatus == .connected else {
            connection?.errorMessage = "Not connected to your Mac — wait for Live status, then try again."
            return
        }
        let (id, _) = mintStreamingTurn(messages: &llmIdeMessages, commandIds: &llmIdeCommandIds, userText: text)
        isStreaming = true
        currentCommandId = id
        startStreamTimeout(for: id, idleSeconds: idleWindow(for: id))
        let request = HostApiChatSendRequest(attachments: files.isEmpty ? nil : files.map { .init(name: $0.name, text: $0.text) }, text: text)
        Task { [weak self] in
            do {
                _ = try await self?.connection?.host.send(.chatSend, request, id: id, as: HostApiChatSendResult.self)
            } catch {
                self?.chatSendFailed(id, error)
            }
        }
    }

    /// Before the transport move, an encode failure set this message and disconnected; a host refusal
    /// (v1 `denied`, `busy`, …) arrived as an `error` frame. Both end the turn the same way.
    private func chatSendFailed(_ id: String, _ error: Error) {
        let r = error as? HostApiRejection
        connection?.errorMessage = r?.message ?? "Failed to encode chat message: \(error.localizedDescription)"
        handleChatError(commandId: id)
        if r == nil || r?.code == "internal" { connection?.disconnect() }
    }

    func loadSharedHistory() {
        Task { [weak self] in
            guard let result = try? await self?.connection?.host.send(
                .chatSnapshot, HostApiChatSnapshotRequest(limit: 50), as: HostApiChatSnapshotResult.self) else { return }
            self?.applySnapshot(result)
        }
    }

    private func applySnapshot(_ reply: HostApiChatSnapshotResult) {
        guard !isStreaming else { return }
        let restored = reply.messages.enumerated().map { index, message in
            ChatMessage(historyIndex: index, role: message.role == "assistant" ? .assistant : .user, text: message.content)
        }
        // Carry local-only `imageData` across the swap: the server transcript has no images, so a just-sent
        // thumbnail used to vanish from its bubble the moment the reply completed.
        llmIdeMessages = Self.preservingAttachments(from: llmIdeMessages, into: restored)
    }

    func clearLlmIdeChat() {
        llmIdeMessages.removeAll()
        Task { [weak self] in
            do {
                if try await self?.connection?.host.send(.chatHistoryClear, HostApiChatHistoryClearRequest(),
                                                          as: HostApiChatHistoryClearResult.self).cleared == true {
                    self?.llmIdeMessages.removeAll()
                }
            } catch let r as HostApiRejection where r.code != "host_unreachable" {
                self?.connection?.errorMessage = r.message   // a v1 refusal; on v2 the Mac's error frame says it
            } catch {}
        }
    }

    func cancelStreaming() {
        guard currentCommandId != nil else { return }
        sendCancel()
    }

    private func sendCancel() {
        Task { [weak self] in
            _ = try? await self?.connection?.host.send(.chatCancel, HostApiChatCancelRequest(), as: HostApiChatCancelResult.self)
        }
    }
```

In `submitApproval`, replace the `sendEncodable(ApprovalAnswer(…))` call with:

```swift
        let answer = HostApiApprovalsAnswerRequest(answers: answers, commandId: request.commandId, requestId: request.requestId)
        Task { [weak self] in
            do { _ = try await self?.connection?.host.send(.approvalsAnswer, answer, as: HostApiApprovalsAnswerResult.self) }
            catch let r as HostApiRejection where r.code != "host_unreachable" { self?.connection?.errorMessage = r.message }
            catch {}
        }
```

`submitToolApproval` gets the same change, with `HostApiToolApprovalsAnswerRequest(commandId: request.commandId, decision: allow ? "allow_once" : "deny", requestId: request.requestId)` and `.toolApprovalsAnswer`.

In `startStreamTimeout`, replace `self.connection?.sendEncodable(LlmIdeCancel(commandId: commandId))` with `self.sendCancel()`. `handleChatError(commandId:)` runs first, as it does today, and on v2 the adapter's cancel target is still that id, because the adapter clears it only on done or error from the Mac.

Change `idleWindow(for:)` to:

```swift
    /// Long window once `commandId` has parked on an approval (sticky until done, see
    /// `approvalPausedCommandIds`), and always on Host API v1: it sends no progress frames to restart the
    /// breaker, so the short window would cancel every turn longer than two minutes (Plan 4 decision 7).
    func idleWindow(for commandId: String) -> UInt64 {
        approvalPausedCommandIds.contains(commandId) || connection?.host.apiVersion == 1 ? 960 : 120
    }
```

- [ ] **Step 2: Store receives `HostEvent`s**

Replace `handleInbound(type:data:)` and `handleOutput(commandId:payload:)` with:

```swift
    func handle(_ event: HostEvent) {
        let d = JSONDecoder()
        switch event {
        case .progress(let id, let text):
            // v2 status line: appended, restarts the idle breaker, and the pause glyph makes the window sticky.
            guard ownsCommand(id), !text.isEmpty else { return }
            appendToLastAssistant(&llmIdeMessages, text)
            progressCommandIds.insert(id)
            if text.contains(Self.approvalPauseGlyph) { approvalPausedCommandIds.insert(id) }
            startStreamTimeout(for: id, idleSeconds: idleWindow(for: id))
        case .event(.chatDelta, let payload, let replyTo?):
            guard ownsCommand(replyTo), let e = try? d.decode(HostApiChatDeltaEvent.self, from: payload), !e.text.isEmpty else { return }
            // The reply replaces any status lines (the v2 `done` chunk did); later chunks append.
            if progressCommandIds.remove(replyTo) != nil { setLastAssistant(&llmIdeMessages, e.text) }
            else { appendToLastAssistant(&llmIdeMessages, e.text) }
            startStreamTimeout(for: replyTo, idleSeconds: idleWindow(for: replyTo))
        case .event(.chatDone, let payload, _):
            guard let e = try? d.decode(HostApiChatDoneEvent.self, from: payload), ownsCommand(e.requestId) else { return }
            finishTurn(e.requestId)
        case .event(.chatError, let payload, let replyTo):
            if let replyTo {
                guard ownsCommand(replyTo) else { return }
                handleChatError(commandId: replyTo)
            } else {
                handleChatError()
            }
            // On v2, ConnectionService already showed the `error` frame's message; on v1 nobody else will.
            if connection?.host.apiVersion == 1, let e = try? d.decode(HostApiChatErrorEvent.self, from: payload), e.message != "Cancelled" {
                connection?.errorMessage = e.message
            }
        case .event(.approvalRequest, let payload, _):
            // Only this surface's own turn: both stores see every approval frame on v2.
            guard let e = try? d.decode(HostApiApprovalRequestEvent.self, from: payload) else { return }
            let request = HostApiV2ChatBridge.approvalRequest(e)
            if !request.questions.isEmpty, ownsCommand(request.commandId) {
                approvalNotice = nil
                pendingApproval = request
            }
        case .event(.toolApprovalRequest, let payload, _):
            guard let e = try? d.decode(HostApiToolApprovalRequestEvent.self, from: payload) else { return }
            let request = HostApiV2ChatBridge.toolApprovalRequest(e)
            if ownsCommand(request.commandId) {
                approvalNotice = nil
                pendingApproval = nil
                pendingToolApproval = request
            }
        case .event(.approvalCleared, let payload, _):
            // Only for the card actually on screen: a late clear for an older question must not take down a newer one.
            guard let e = try? d.decode(HostApiApprovalClearedEvent.self, from: payload) else { return }
            let cleared = HostApiV2ChatBridge.approvalCleared(e)
            if pendingApproval?.requestId == cleared.requestId { pendingApproval = nil; approvalNotice = cleared.reason }
            if pendingToolApproval?.requestId == cleared.requestId { pendingToolApproval = nil; approvalNotice = cleared.reason }
        case .resync:
            // A missed-event gap (spec "Wire envelope"): take a fresh snapshot. It is applied once not streaming.
            loadSharedHistory()
        case .event, .capabilities, .disconnected:
            break
        }
    }

    /// The old `if done { … }` block of handleOutput, verbatim, keyed by the finished request.
    private func finishTurn(_ id: String) {
        streamTimeoutTask?.cancel()
        isStreaming = false
        if pendingApproval?.commandId == id { pendingApproval = nil }
        if pendingToolApproval?.commandId == id { pendingToolApproval = nil }
        llmIdeCommandIds.remove(id)
        approvalPausedCommandIds.remove(id)
        progressCommandIds.remove(id)
        if currentCommandId == id { currentCommandId = nil }
        loadSharedHistory()
    }
```

Also clear `progressCommandIds` wherever `approvalPausedCommandIds` is cleared: `remove(commandId)` and `removeAll()` in `handleChatError`, and `removeAll()` in `resetForNewDevice`. Keep the old comments on each line.

The `.event(.chatDelta, …, nil)` case (a delta without `replyTo`) falls through to `case .event, …: break`. Hosts always set `replyTo` on chat events.

- [ ] **Step 3: Route the chat slice's frames through the adapter**

In `ConnectionService.handleMessage`:
- Change `case "llmide_chat_history_reply", "llmide_chat_history_clear_ack":` to call `v2Host.receive(type: type, json: json, data: data)` instead of `llmIdeStore?.handleInbound`.
- In `case "approval_request", "approval_cleared", "tool_approval_request":`, replace the `llmIdeStore?.handleInbound(type: type, data: data)` line with `v2Host.receive(type: type, json: json, data: data)`. Keep the `explorerStore` line.
- In `case "output":`, replace `llmIdeStore?.handleOutput(commandId: commandId, payload: payload)` with a call before the `if let payload` block: `v2Host.receive(type: "output", json: json, data: data)`. Keep the `explorerStore?.handleOutput` call inside the block.
- In `case "error":`, replace the trailing ownership chain (`if let cid, llmIdeStore?.ownsCommand(cid) == true { … } else if … explorer … } else if cid == nil { … }`) with:

```swift
                // The chat slice ends its own turns (V2HostConnection → chat.error; the store checks ownership).
                // The explorer branches are the old chain's other two arms, unchanged.
                v2Host.receive(type: MobileProtocol.Tag.error, json: json, data: data)
                if let cid, llmIdeStore?.ownsCommand(cid) != true, explorerStore?.ownsCommand(cid) == true {
                    explorerStore?.handleChatError(commandId: cid)
                } else if cid == nil {
                    explorerStore?.handleChatError()
                }
```

Keep the `errorMessage` block above it as it is. In `route(_:)`, change `case .event, .progress, .resync: break` to `case .event, .progress, .resync: llmIdeStore?.handle(event)`.

Behaviour check by reading, against the old code:

| Before | After |
|---|---|
| a chat-owned error called only chat | it reaches chat through the adapter; explorer doesn't own the id |
| an explorer-owned error called only explorer | the chat store ignores the id it doesn't own |
| an error with no id called both | both still run |
| progress was appended | `.progress` is appended |
| the done chunk replaced the bubble | the delta replaces it when progress showed; otherwise it fills the empty placeholder |
| done had no chunk | the progress text stays until the history reload, as before |

- [ ] **Step 4: Build and test**

Run (unsandboxed): the `xcodebuild … -sdk iphoneos …` command from Task 5 Step 5.
Expected: `** BUILD SUCCEEDED **`, and `grep -n 'handleOutput\|handleInbound' ios_app/MyApp/Services/LlmIdeChatStore.swift` prints nothing.

Run: `make test-shared-protocol`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add ios_app/MyApp/Services/LlmIdeChatStore.swift ios_app/MyApp/Services/ConnectionService.swift
git commit -m "refactor(ios): move the chat and approvals store behind HostConnection"
```

---

### Task 7: Capability gating for a v1 connection [parallel-safe with Tasks 6 and 8]

**Files:**
- Modify: `ios_app/MyApp/Views/RootTabView.swift`
- Modify: `ios_app/MyApp/Views/Control/LlmIdeControlView.swift`

**Interfaces:**
- Consumes: `ConnectionService.supports(_:)`, which reads `macCapabilities`. On v1, Task 5 fills it from the hello, the auth grant and `host.capabilities`.
- Consumes: `hostApiVersion`.

- [ ] **Step 1: Hide what a v1 host does not serve**

In `RootTabView.swift`:
- Wrap the `ProjectView(deviceName:)` tab in `if ProjectView.Section.allCases.contains(where: { connection.supports($0.capability) }) { … }`. Every segment needs a v2 capability; on v1 none is advertised, so the tab goes away. A v2 Mac advertises at least the legacy set, so its tabs are unchanged.
- In `.onChange(of: connection.macCapabilities)`, add as the first line: `if selection == .project, !ProjectView.Section.allCases.contains(where: { connection.supports($0.capability) }) { selection = .chat }`.
- Change the first line of `refreshMacData()` to:

```swift
        // Host API v1 serves chat + approvals only (Plan 4); these stores still speak v2 and would send nothing.
        guard isConnected, connection.hostApiVersion == 2 else { return }
```

In `LlmIdeControlView.swift`, the `canSend` computed property (around line 358) gains `&& connection.supports(MobileProtocol.Capability.chat)`. A v2 Mac always serves chat (`agent_chat` is never excluded), so this changes nothing on v2.

Activity, Usage, Docs and Generate are already gated by `supports`, and they hide on v1 without further changes.

- [ ] **Step 2: Build**

Run (unsandboxed): the `xcodebuild … -sdk iphoneos …` command from Task 5 Step 5.
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add ios_app/MyApp/Views/RootTabView.swift ios_app/MyApp/Views/Control/LlmIdeControlView.swift
git commit -m "feat(ios): hide v2-only screens on a Host API v1 connection"
```

---

### Task 8: Docs, deferred manual rows and plan status [parallel-safe with Tasks 6 and 7]

**Files:**
- Modify: `docs/mobile/verification.md`
- Modify: `docs/mobile/quick-start.md`
- Modify: `schema/host-api/v1/README.md`
- Modify: `docs/superpowers/MASTER-PLAN.md`

- [ ] **Step 1: Deferred manual rows (not gates)**

In `docs/mobile/verification.md`, add a section `## Host API v1 from the iPhone app (deferred to the product stage)`. Introduce it with this line: "User decision 2026-11-04: these are run at the product stage and do not gate Plan 4. Until spec phase 6 (WSS + pinning), v1 only works from the Simulator against a DEBUG host started with `LLMIDE_HOST_API_DEV=1`. Set `LLMIDE_HOST_API_URL=ws://127.0.0.1:3016/host-api/v1` in the Xcode scheme." Then add a table with these rows:

| # | Check | Expected |
|---|---|---|
| H1 | Fresh pair over v1 with the Mac PIN | Chat tab only; the Mac log shows a Host API v1 connection; Keychain holds `host-api-token`; the PIN is gone |
| H2 | Send, Stop, clear history, answer a question, Allow once or Deny a tool prompt | Same results as on v2, with no status lines during the turn |
| H3 | Quit and relaunch the DEBUG Mac without the flag | The phone falls back to v2 within about 3 s, and every tab is back |
| H4 | Background the Simulator app for 1 minute, then return | It reconnects by token and the transcript reloads |
| H5 | Remove the device on the Mac | The phone gets `auth_failed` and returns to pairing |
| H6 | Release build, or no `LLMIDE_HOST_API_URL` | v2 exactly as before (rows F1–F17) |

Under the S4 checklist row, add: "On a Host API v1 connection the idle breaker uses the 960 s window from the start (Plan 4 decision 7)."

- [ ] **Step 2: Developer how-to and client codec**

In `docs/mobile/quick-start.md`, add a short "Developer: Host API v1 in the Simulator" subsection that repeats the scheme variable, the host flag and the fallback rule (decisions 1 and 2), and links this plan.

In `schema/host-api/v1/README.md`, add a "Clients" paragraph saying:
- Swift clients build requests with `HostApiFrame.request` and parse host frames with `HostApiFrame.parseInbound`;
- event names are the generated `HostApiEvent`;
- `HostApiV1Client` is the reference client;
- the iOS v2 fallback maps the chat slice through `HostApiV2ChatBridge`.

- [ ] **Step 3: Master plan**

In `docs/superpowers/MASTER-PLAN.md`, add this line below the Plan 2 line: `- [~] Host API v1 Plan 4, iOS transport: HostConnection, v1 client + v2 fallback, chat + approvals moved; plan plans/2026-11-04-host-api-ios-transport.md; manual rows H1–H6 deferred (you)`. Narrow the existing "Plans 3 to 6" line so it no longer claims Plan 4.

- [ ] **Step 4: Check and commit**

Run: `make docs-check`
Expected: passes. If a drift guard names one of these files, fix the wording and leave the guard unchanged.

```bash
git add docs/mobile/verification.md docs/mobile/quick-start.md schema/host-api/v1/README.md docs/superpowers/MASTER-PLAN.md
git commit -m "docs(mobile): Host API v1 iOS transport how-to and deferred checks"
```

---

## Limits

- **On a real iPhone, v1 waits for Plan 6.** Both hosts serve v1 only on a plaintext loopback development listener, and the client refuses `wss://` until Plan 6's pinning evaluator plugs into `HostApiTrustEvaluating`. Until then v1 works only from the Simulator against a DEBUG host. The v2 fallback keeps the shipped app working, and release builds never try v1 (decision 1).
- **v1 is chat + approvals only.** On a v1 connection every other screen is hidden. Do not let a release build prefer v1 until these later slices have moved. Each needs its v1 commands added to the contract first:
  - Explorer chat (`ExplorerChatStore`, including its own approval cards and sessions)
  - Auto Tasks
  - Loop
  - Mac status
  - Projects
  - Files
  - Source Control
  - Issues
  - Self-Heal
  - Generation and llm-doc
  - Usage
  - Activity
- **Discovery and QR still carry only the v2 port.** Advertising the v1 port and the fingerprint is Plan 6 (spec "Host discovery").
- **v1 has no progress event.** A long turn shows nothing until the reply. The idle breaker uses the 960 s window on v1. `chat.progress` is a contract change for a later plan.
- **The Mac's `rev` is host-wide.** A second v1 client makes this phone see gaps and take extra `chat.snapshot`s. That is harmless, and a per-session rev would be a host change.
- **No automatic retry.** The client reports `host_unreachable` with `retryable` set from `idempotent`, and no caller retries yet.
- **"Forget this Mac" does not call `host.auth.revoke`.** This matches v2 today, where forgetting is phone-side only.
- **Demo mode stays on v2.**
- **The app target has no unit-test target.** App glue is checked by the device-SDK build and by the deferred manual rows. All decision logic sits in SharedProtocol, where it is tested.

## Workflow

Subagent-driven, with one fresh implementer per task and each task reviewed before the next.
- **Parallel groups:** Tasks 2 and 4 together after Task 1; Tasks 6, 7 and 8 together after Task 5. Each parallel implementer stages only its own files. If `git commit` meets `.git/index.lock`, retry after a short wait; never use `git add -A`.
- Tasks 3 and 5 touch auth, tokens and Keychain. Review them on Sonnet or a stronger model. Task 6 is the no-behaviour-change move, so review it on the most capable model against the before/after table in its Step 3.
- `swift build` and `xcodebuild` run unsandboxed (SwiftPM and the Xcode build need it).
- Commit on `main` and do not push.

## Commands

```bash
node scripts/generate-host-api.mjs && node scripts/generate-host-api.mjs --check   # generated Swift + drift gate
make host-api-check                                                                  # Node conformance gate
make test-shared-protocol                                                            # codec, logic, v1 client, v2 bridge
cd mac && swift build 2>&1 | tail -3                                                 # Mac still links SharedProtocol (unsandboxed)
cd ios_app && xcodebuild -project MyApp.xcodeproj -target MyApp -configuration Debug \
  -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO SYMROOT="$TMPDIR/ios-build" build   # what ios-ci runs (unsandboxed)
make docs-check
```

## Self-review

**Spec coverage, phase 4:**
- `HostConnection` introduced: Task 1.
- v1 adapter: Task 3, with hello, `host.auth.pair`/`host.auth.token`, correlation, the ping watchdog and `rev`-gap resync.
- Existing v2 fallback: Tasks 4 and 5.
- "First attempts `host.hello` … otherwise … v2": decisions 1 and 2, `HostApiNegotiation` (Task 2) and `connectDirect` (Task 5).
- Capability gating, "nothing pretends to work": Task 7.
- Token in Keychain, reusing `CredentialKeychain`: Task 5.
- "Reconnect after iOS suspends": the existing backoff plus token auth plus the views' on-connected reloads (decision 10), with `.resync` on a gap (Task 6).
- "Move screens behind it without changing behaviour", slice by slice: Task 6 moves chat + approvals, and its before/after table covers each path. The other slices are listed in Limits.
- Generated types only: Task 1 generates `HostApiEvent`. Every v1 payload uses `HostApiPayloads.swift`, and mapping to the v2 view models is explicit (decision 4).
- Plan 6 seam: `HostApiTrustEvaluating`, plus the `HostApiEndpoint` rule (decision 8).
- "Each phase ends with the conformance suite, a build, and a manual pairing check": the gates are in Commands. The manual check is rows H1–H6, deferred by the user's decision and not a gate.

**Placeholders:** none. One step tells the executor to check existing state first: the free pbxproj ids in Task 5 Step 3, with the grep that checks them.

**Type consistency:**
- `HostEvent` cases (Task 1) are produced by `HostApiV1Client` (Task 3) and `HostApiV2ChatBridge` (Task 4), and consumed by `ConnectionService.route` (Task 5) and `LlmIdeChatStore.handle` (Task 6).
- `HostApiRejection.retryable` (Task 1) is read by `HostApiNegotiation` (Task 2), the client (Task 3) and `handleV1Refusal` (Task 5).
- `HostApiV1Client.ConnectOutcome` (Task 3) is consumed by `connectV1` (Task 5).
- `V2HostConnection.receive`/`connectionEnded` and `ConnectionService.sendV2Frame` (Task 5) are used by Task 6's dispatch.
- `hostApiVersion` (Task 5) is read by Tasks 6 and 7.
