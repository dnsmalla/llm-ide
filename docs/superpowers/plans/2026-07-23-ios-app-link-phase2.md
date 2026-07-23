# iOS App ↔ Mac App Native Link — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS app a native control server the iPhone can discover (Bonjour), pair with (PIN), and connect to (WebSocket) — replacing the external Node "computer-agent" launch model. After Phase 2, an iPhone on the LAN can discover the Mac, pair via PIN, and hold a connected WebSocket session with heartbeat. (Screen streaming, input injection, and llm-ide chat commands are Phases 3–5.)

**Architecture:** Inside the Mac app, `MobileWebSocketServer` uses `NWListener` + `NWProtocolWebSocket.Options` (Network.framework, no third-party WebSocket lib) to accept one active client (replace policy). `MobileBonjourAdvertiser` publishes `_llmide._tcp` via `NetService`. PIN is generated on first run and stored in the macOS Keychain (via the existing `KeychainStore`). `MobileControlManager` is refactored from "spawn a child process" to "own the native server + advertiser." PIN auth is **message-based**: the iPhone's first frame is a `Pairing{pin}` (`SharedProtocol`); the Mac validates and replies `Connected`/`AuthFailed`. The Settings panel drops the agent-folder picker and gains a pairing QR.

**Tech Stack:** Swift (macOS 14+), Network.framework (`NWListener`, `NWProtocolWebSocket`), Foundation `NetService` (Bonjour), Security framework (Keychain), SwiftUI, XCTest.

**Continues from:** Phase 1 (commit `6794953` on `main`) — `ios_app/SharedProtocol` exists with `MobileProtocol` constants and the `Heartbeat`/`HeartbeatAck`/`Connected`/`AuthFailed` message types.

## Global Constraints

(Verbatim values every task implicitly inherits.)

- Bonjour service type: `_llmide._tcp` (matches Phase 1's `MobileProtocol.serviceType`); advertised on port `3006` (`MobileProtocol.defaultPort`).
- Heartbeat interval `10`s, timeout `25`s (`MobileProtocol` constants). WebSocket `autoReplyPing = true` handles protocol pings; the app-level heartbeat uses the `Heartbeat`/`HeartbeatAck` messages.
- PIN: 6-digit numeric string, stored in the macOS Keychain under account `mobile::pin` via `KeychainStore` (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), generated on first run.
- Pairing QR payload: `llmide://pair?ip=<lan-or-tailscale>&port=3006&pin=<pin>`.
- Single active client policy: **replace** (a new valid pairing replaces any existing client).
- Mac target stays `@MainActor @Observable` for `MobileControlManager`; `swift-tools-version: 6.0`, `swiftLanguageModes: [.v5]` (do not change). Do not regress the SharedProtocol dependency.
- `MobileControlManager`'s existing observable surface (`status`, `logLines`, `lastError`, and the `Status` enum) must keep working for `LlmIdeMacApp` and `MobileControlSettingsSection`.
- Conventional Commits; one concern per commit; do not push.
- Server-side WebSocket via Network.framework only (no Swift WebSocket library dependency).

## File Structure

**Created (Mac)**
- `mac/Sources/LlmIdeMac/Services/MobileWebSocketServer.swift` — `NWListener` + `NWProtocolWebSocket` server; one active client; pairing + heartbeat; inbound-message callback.
- `mac/Sources/LlmIdeMac/Services/MobileBonjourAdvertiser.swift` — `NetService` publisher for `_llmide._tcp`.
- `mac/Sources/LlmIdeMac/Services/MobilePin.swift` — Keychain-backed PIN (ensure/read/regenerate) via `KeychainStore`.

**Created (SharedProtocol)**
- Append `Pairing(pin:)` to `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift` + test.

**Modified (Mac)**
- `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` — refactored to own the server/advertiser/PIN; `start()`/`stop()` no longer take an agent path; spawn/adopt/probe/npm code removed.
- `mac/Sources/LlmIdeMac/Services/MobileConnectionInfo.swift` — `AgentPin` reads from Keychain (`MobilePin`) instead of `~/.aicontrol.json`; add `qrPayload` to the snapshot.
- `mac/Sources/LlmIdeMac/Views/Settings/MobileControlSettingsSection.swift` — drop agent-folder browse/auto-detect rows; add a QR view; keep IP/Port/PIN copy rows, permissions, start/stop, log pane.
- `mac/Sources/LlmIdeMac/Models/Config.swift` — `mobileControlAgentPath` left in place but unused (dormant); no new required fields (port/PIN are derived constants, not user config).
- `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` — `autoStartMobileControl()` calls `mobileControl.start()` (no path); drop the `LaunchPathResolver` call.

**Modified (iOS)**
- `ios_app/MyApp/Services/ControlService.swift` — after connect, send `Pairing{pin}` as the first frame; map `Connected`/`AuthFailed` (was: pin only in the URL query).
- `ios_app/MyApp/Services/ConnectionStore.swift` — PIN is sent in the `Pairing` message (URL keeps `ws://<ip>:<port>/ws`, no query pin required).

**Deprecated/removed**
- `mac/Sources/LlmIdeMac/Services/LaunchPathResolver.swift` `resolveMobileAgentPath`/`looksLikeAgent`/`findServerDirectory` — mobile-agent probing becomes dead code; remove the mobile half (keep any non-mobile `findServerDirectory` if `BackendManager` still uses it — verify before deleting).

---

## Task 1: SharedProtocol `Pairing` message (TDD)

**Files:**
- Modify: `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift` (append)
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/ConnectionMessagesTests.swift` (append)

**Interfaces:**
- Produces: `SharedProtocol.Pairing` — `public struct Pairing: Codable, Equatable { public let type = "pairing"; public let pin: String; public init(pin: String) }` encoding to `{"type":"pairing","pin":"…."}`.

- [ ] **Step 1: Write the failing test**

Append to `ConnectionMessagesTests.swift`:

```swift
    func testPairingRoundTrips() throws {
        let original = Pairing(pin: "123456")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Pairing.self, from: data)
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.type, "pairing")
        XCTAssertEqual(decoded.pin, "123456")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios_app/SharedProtocol && swift test`
Expected: FAIL — `cannot find 'Pairing' in scope`.

- [ ] **Step 3: Implement**

Append to `MobileProtocol.swift` (after `AuthFailed`):

```swift
/// Client → server: first message after connecting; carries the pairing PIN.
public struct Pairing: Codable, Equatable {
    public let type = "pairing"
    public let pin: String
    public init(pin: String) { self.pin = pin }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios_app/SharedProtocol && swift test`
Expected: PASS (now 8 tests).

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol
git commit -m "feat(shared-protocol): add Pairing(pin:) message"
```

---

## Task 2: Keychain PIN (`MobilePin`)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/MobilePin.swift`
- Read first: `mac/Sources/LlmIdeMac/Services/KeychainStore.swift` (mirror its account/`kSecAttrAccessible` pattern)

**Interfaces:**
- Produces: `enum MobilePin` with `static func ensure() throws -> String` (read existing or generate+store a fresh 6-digit PIN), `static func read() -> String?`, `static func regenerate() throws -> String`.

- [ ] **Step 1: Read `KeychainStore.swift`** and confirm the exact account-string convention and accessibility constant it uses (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), so `MobilePin` matches.

- [ ] **Step 2: Implement `MobilePin.swift`**

```swift
import Foundation

/// Generates and stores the 6-digit mobile-pairing PIN in the macOS Keychain
/// (account `mobile::pin`), mirroring `KeychainStore`'s accessibility policy.
/// Replaces the old file-based `~/.aicontrol.json` PIN.
enum MobilePin {
    /// The account name under which the PIN is stored.
    static let account = "mobile::pin"

    /// Returns the stored PIN, generating and persisting a fresh one on first call.
    static func ensure() throws -> String {
        if let existing = read() { return existing }
        return try regenerate()
    }

    /// Reads the stored PIN, or nil if none.
    static func read() -> String? {
        KeychainStore.read(account: account)
    }

    /// Generates a new random 6-digit PIN, overwrites any stored PIN, returns it.
    static func regenerate() throws -> String {
        // SystemRandomNumberGenerator — sufficient entropy for a 6-digit LAN PIN.
        var rng = SystemRandomNumberGenerator()
        let n = Int.random(in: 0...999_999, using: &rng)
        let pin = String(format: "%06d", n)
        try KeychainStore.write(account: account, value: pin)
        return pin
    }
}
```

> NOTE: `KeychainStore.read(account:)` / `write(account:value:)` are placeholders for the ACTUAL method signatures in `KeychainStore.swift` — use the real ones you found in Step 1. If `KeychainStore` uses a different shape (e.g. `read(service:account:)`), adapt accordingly and keep the `mobile::pin` account string.

- [ ] **Step 3: Verify it compiles**

Run: `cd mac && swift build`
Expected: BUILD SUCCEEDED. (If `KeychainStore` signatures differ, fix the calls and rebuild.)

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MobilePin.swift
git commit -m "feat(mac): add Keychain-backed MobilePin"
```

---

## Task 3: `MobileBonjourAdvertiser`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/MobileBonjourAdvertiser.swift`

**Interfaces:**
- Produces: `final class MobileBonjourAdvertiser` with `init(name: String, port: Int)`, `func start()`, `func stop()`. Publishes `_llmide._tcp`.

- [ ] **Step 1: Implement**

```swift
import Foundation

/// Publishes the Mac as `_llmide._tcp` on the LAN so the iPhone can discover it.
/// Thin wrapper over NetService; Bonjour itself is not unit-testable, so this
/// class is exercised via the manual checklist.
final class MobileBonjourAdvertiser: NSObject {
    private let name: String
    private let port: Int
    private var service: NetService?

    init(name: String, port: Int) {
        self.name = name
        self.port = port
    }

    func start() {
        guard service == nil else { return }
        let service = NetService(domain: "", type: MobileProtocol.serviceType + ".", name: name, port: Int32(port))
        service.delegate = self
        service.publish()
        self.service = service
    }

    func stop() {
        service?.stop()
        service = nil
    }
}

extension MobileBonjourAdvertiser: NetServiceDelegate {
    // No-op defaults; surface publish failures to the log if desired.
    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        // Left intentionally minimal — logged by the manager if needed.
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd mac && swift build`
Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MobileBonjourAdvertiser.swift
git commit -m "feat(mac): add MobileBonjourAdvertiser"
```

---

## Task 4: `MobileWebSocketServer` (native server + pairing + heartbeat)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/MobileWebSocketServer.swift`

**Interfaces:**
- Consumes: `SharedProtocol` (`Pairing`, `Connected`, `AuthFailed`, `Heartbeat`, `HeartbeatAck`), `MobilePin`.
- Produces: `final class MobileWebSocketServer`:
  - `typealias InboundHandler = (Data) -> Void`
  - `init(port: Int, deviceName: String, validatePin: (String) -> Bool, onInbound: @escaping InboundHandler, onLog: @escaping (String) -> Void)`
  - `func start() throws`, `func stop()`
  - `func send(_ message: some Encodable) async` — JSON-encodes and sends to the active client (no-op if none).

- [ ] **Step 1: Implement**

```swift
import Foundation
import Network
import SharedProtocol

/// Native WebSocket server (Network.framework). Accepts one active client at a
/// time (replace policy). Auth is message-based: the client's first text frame
/// must be a `Pairing{pin}`; on match the server sends `Connected` and begins
/// app-level heartbeat; on mismatch it sends `AuthFailed` and closes.
final class MobileWebSocketServer {
    private let port: Int
    private let deviceName: String
    private let validatePin: (String) -> Bool
    private let onInbound: InboundHandler
    private let onLog: (String) -> Void
    private let queue = DispatchQueue(label: "llmide.mobile.ws")
    private var listener: NWListener?
    private var client: NWConnection?
    private var paired = false

    typealias InboundHandler = (Data) -> Void

    init(port: Int, deviceName: String,
         validatePin: @escaping (String) -> Bool,
         onInbound: @escaping InboundHandler,
         onLog: @escaping (String) -> Void) {
        self.port = port
        self.deviceName = deviceName
        self.validatePin = validatePin
        self.onInbound = onInbound
        self.onLog = onLog
    }

    func start() throws {
        let opts = NWProtocolWebSocket.Options()
        opts.autoReplyPing = true
        opts.maximumMessageSize = 1_048_576
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(opts, at: 0)
        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        listener.start(queue: queue)
        self.listener = listener
        onLog("WebSocket listening on :\(port)")
    }

    func stop() {
        client?.cancel()
        client = nil
        listener?.cancel()
        listener = nil
        paired = false
    }

    /// JSON-encode and send to the active client (no-op if none/paired==false).
    func send(_ message: some Encodable) async {
        guard let client, paired else { return }
        guard let data = try? JSONEncoder().encode(message),
              let string = String(data: data, encoding: .utf8) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "msg", metadata: [metadata])
        client.send(content: string.data(using: .utf8), contentContext: context,
                    isComplete: true, completion: .contentProcessed { _ in })
    }

    private func handle(_ conn: NWConnection) {
        // Single-client "replace": drop any existing client first.
        client?.cancel()
        client = conn
        paired = false
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.onLog("Client connected — awaiting pairing")
                self?.receive()
            case .failed, .cancelled:
                self?.onLog("Client disconnected")
                self?.client = nil
                self?.paired = false
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private func receive() {
        guard let client else { return }
        client.receiveMessage { [weak self] data, _, _, error in
            guard let self, let data, error == nil else { return }
            if !self.paired {
                self.handlePairing(data: data)
            } else {
                self.routeInbound(data: data)
            }
            self.receive()   // continue the receive loop
        }
    }

    private func handlePairing(data: Data) {
        guard let pairing = try? JSONDecoder().decode(Pairing.self, from: data) else {
            onLog("First frame was not a Pairing message — closing")
            closeWithAuthFailure()
            return
        }
        if validatePin(pairing.pin) {
            paired = true
            onLog("Client paired")
            Task { await self.send(Connected(deviceName: deviceName)) }
        } else {
            onLog("Wrong PIN — rejecting")
            closeWithAuthFailure()
        }
    }

    private func closeWithAuthFailure() {
        Task {
            await self.send(AuthFailed(message: "Wrong PIN"))
            self.client?.cancel()
            self.client = nil
            self.paired = false
        }
    }

    private func routeInbound(data: Data) {
        // Heartbeat is handled here; everything else is forwarded to the manager
        // (Phase 3 wires chat/commands; Phase 4/5 wire viewing/input).
        if let hb = try? JSONDecoder().decode(Heartbeat.self, from: data),
           hb.type == "heartbeat" {
            Task { await self.send(HeartbeatAck(ts: Date().timeIntervalSince1970)) }
            return
        }
        onInbound(data)
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd mac && swift build`
Expected: BUILD SUCCEEDED. (If `KeychainStore`/`Network` APIs differ, fix and rebuild. The `send(_:)` uses `NWProtocolWebSocket.Metadata(opcode: .text)` and `NWConnection.ContentContext` — confirmed Network.framework APIs.)

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MobileWebSocketServer.swift
git commit -m "feat(mac): add native MobileWebSocketServer (pairing + heartbeat)"
```

> TESTING NOTE: There is currently no Mac test target (`Package.swift` test target was removed). Rather than risk re-adding it under an uncertain toolchain, the server is verified by a **loopback integration check** in Task 8's manual checklist (start the manager, connect a `URLSessionWebSocketTask` from a tiny scratch Swift script, send `Pairing`, assert `Connected`). Automated encode/decode of every message is already covered by SharedProtocol's tests.

---

## Task 5: Refactor `MobileControlManager` to own the native server

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift`

**Interfaces:**
- Consumes: `MobileWebSocketServer`, `MobileBonjourAdvertiser`, `MobilePin` (Tasks 2–4), `SharedProtocol`.
- Produces: `MobileControlManager` with the SAME observable surface (`status`, `logLines`, `lastError`, `Status` enum) but `func start()` (no `agentPath`), `func stop()`. Removes `start(agentPath:)`, `spawn`, `waitForReadyThenRun`, `autoDetectNpm`, `probeInfo`, `isPortInUse`, the env-allowlist, `Process`/`Pipe` code, and `adoptedExternal`.

- [ ] **Step 1: Replace the implementation**

Rewrite the class so that:
- `start()`:
  1. `status = .starting`.
  2. `let pin = (try? MobilePin.ensure()) ?? MobilePin.read() ?? "000000"`.
  3. Build `MobileWebSocketServer(port: MobileProtocol.defaultPort, deviceName: Self.deviceName(), validatePin: { candidate in candidate == pin }, onInbound: { [weak self] data in self?.handleInbound(data) }, onLog: { [weak self] line in Task { @MainActor in self?.append(.info, line) } })`.
  4. `try server.start()`; on throw → `status = .crashed(exitCode: -1)`, set `lastError`, return.
  5. `advertiser = MobileBonjourAdvertiser(name: Self.deviceName(), port: MobileProtocol.defaultPort); advertiser.start()`.
  6. `status = .running`.
- `stop()`: `server?.stop(); advertiser?.stop(); status = .stopped`.
- Keep `append(_ stream:_ text:)` (renamed from the log helper) feeding `logLines` (cap 5_000) and `clearLog()`.
- `handleInbound(_:)`: for Phase 2 just logs the inbound data (Phase 3 dispatches chat/commands). 
- Add `private static func deviceName() -> String`: `SCDynamicStoreCopyComputerName(nil, nil) as String? ?? ProcessInfo.processInfo.hostName` (`import SystemConfiguration`).
- Keep the `init()` `willTerminateNotification` → `stop()` hook.
- DELETE: `start(agentPath:)`, `spawn`, `waitForReadyThenRun`, `autoDetectNpm`, `probeInfo`, `isPortInUse`, the `Process`/`Pipe` readers, the env-allowlist, `adoptedExternal`, `pid`, `stopIfOwned` (rename consumers to `stop`), and `logChatCommand` if unused (check `CodeAssistantPanel`/`MobileCommandRouter` first — if still referenced, keep it).
- Keep `static let defaultAgentPort = 3006` (or reference `MobileProtocol.defaultPort`) so `MobileConnectionInfo` still compiles.

- [ ] **Step 2: Fix call sites**

`LlmIdeMacApp.swift`: `autoStartMobileControl()` becomes:
```swift
@MainActor private func autoStartMobileControl() {
    if config.mobileControlEnabled {
        mobileControl.start()
    }
}
```
and the quit hook calls `mobileControl.stop()` (was `stopIfOwned()`).
`MobileControlSettingsSection.swift`: Start button calls `mobileControl.start()`; Stop calls `mobileControl.stop()`.

- [ ] **Step 3: Verify it builds**

Run: `cd mac && swift build`
Expected: BUILD SUCCEEDED. Fix any remaining references to removed members.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MobileControlManager.swift mac/Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "refactor(mac): MobileControlManager owns the native server (no child process)"
```

---

## Task 6: Connection info (Keychain PIN) + Settings QR

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/MobileConnectionInfo.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/MobileControlSettingsSection.swift`

**Interfaces:**
- `AgentPin.read()` → `MobilePin.read()` (Keychain) instead of the JSON file.
- `MobileConnectionInfo` gains `let qrPayload: String?`.
- Settings shows a QR image for `qrPayload`.

- [ ] **Step 1: Switch the PIN source**

In `MobileConnectionInfo.swift`, replace the `AgentPin.read()` body (`~/.aicontrol.json` parse) with:
```swift
static func read() -> String? { MobilePin.read() }
```
(Keep the `enum AgentPin` name to avoid churn, or rename to `MobilePinSource` and update the one call site in `MobileConnectionInfo.current()`.)

- [ ] **Step 2: Add `qrPayload` to the snapshot**

In `struct MobileConnectionInfo`, add:
```swift
let qrPayload: String?
```
and in `current(port:)`, after assembling `lanIP`/`tailscaleIP`/`pin`, compute:
```swift
let host = tailscaleIP ?? lanIP
let qr = (host.map { "llmide://pair?ip=\($0)&port=\(port)&pin=\(pin ?? "")" })
```
return `MobileConnectionInfo(tailscaleIP: tailscaleIP, lanIP: lanIP, port: port, pin: pin, qrPayload: qr)`.

- [ ] **Step 3: Add a QR view to Settings**

In `MobileControlSettingsSection.swift`:
- Remove the `pathRow` ("Agent folder" TextField + Browse + Auto-detect) and `pickAgentDir`/`detectAgentPath`/`savePath`/`agentDraft`.
- Where the connection block is shown, add a QR block that renders `connection.qrPayload` using a CoreImage `CIFilter.qrCodeGenerator()` into an `NSImage` (≈200pt). If `qrPayload` is nil, show "Connect to Wi-Fi or Tailscale to generate a pairing QR."
- Keep the Tailscale/LAN/Port/PIN copyable rows, the permissions block, the auto-start checkbox, status pill, start/stop button, lastError, and the log pane.
- Drop the hardcoded `iosAppPath` constant and `iosHint`.

A minimal QR helper to inline in the file:
```swift
private func qrImage(for string: String) -> NSImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(string.data(using: .utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let ciImage = filter.outputImage else { return nil }
    let scale = 8.0
    let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let rep = NSCIImageRep(ciImage: scaled)
    let nsImage = NSImage(size: rep.size)
    nsImage.addRepresentation(rep)
    return nsImage
}
```

- [ ] **Step 4: Verify it builds**

Run: `cd mac && swift build`
Expected: BUILD SUCCEEDED.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/MobileConnectionInfo.swift mac/Sources/LlmIdeMac/Views/Settings/MobileControlSettingsSection.swift
git commit -m "feat(mac): Keychain PIN + pairing QR in Mobile settings"
```

---

## Task 7: Dead-code cleanup + Config

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LaunchPathResolver.swift`
- Modify: `mac/Sources/LlmIdeMac/Models/Config.swift`

- [ ] **Step 1: Audit `LaunchPathResolver` usage**

Run: `cd mac && grep -RIn "resolveMobileAgentPath\|looksLikeAgent\|findServerDirectory" Sources`

If `findServerDirectory` is still used by `BackendManager`/`autoStartBackend()`, KEEP it. Remove ONLY the mobile half: `resolveMobileAgentPath`, `looksLikeAgent`, and the `auto_swift_aicontrol` candidate probing. If `findServerDirectory` is also dead, remove it too and the whole file.

- [ ] **Step 2: Remove confirmed-dead mobile code**

Delete `resolveMobileAgentPath` and `looksLikeAgent` (and `findServerDirectory` only if Step 1 shows no callers). Confirm `swift build` still succeeds.

- [ ] **Step 3: Leave `Config.mobileControlAgentPath` dormant**

Do NOT delete the `Config` key (it would change the persisted-defaults shape for existing users). Add a comment marking it dormant. (`mobileControlEnabled` and `mobileControlAutoStart` stay in use.)

- [ ] **Step 4: Verify build + commit**

```bash
cd mac && swift build
git add -A mac/Sources/LlmIdeMac/Services/LaunchPathResolver.swift mac/Sources/LlmIdeMac/Models/Config.swift
git commit -m "refactor(mac): remove dead mobile-agent path resolution"
```

---

## Task 8: iOS ControlService handshake (message-based pairing)

**Files:**
- Modify: `ios_app/MyApp/Services/ControlService.swift`
- Modify: `ios_app/MyApp/Services/ConnectionStore.swift` (only if it owns the URL)

**Interfaces:**
- Consumes: `SharedProtocol.Pairing`, `Connected`, `AuthFailed`.
- Produces: on connect, the iPhone sends `Pairing{pin}` first; treats `Connected` as paired and `AuthFailed` as a wrong-PIN failure.

- [ ] **Step 1: Read `ControlService.connectDirect()` and its receive loop** to find where the WS opens and where inbound messages are decoded (so the pairing send + handling are placed correctly).

- [ ] **Step 2: Send `Pairing` immediately after connect**

After the socket opens (the point where the current code currently waits for `connected`), send the PIN as a `Pairing` message:
```swift
let pairing = Pairing(pin: pin)
if let data = try? JSONEncoder().encode(pairing),
   let string = String(data: data, encoding: .utf8) {
    try? await sendText(string)   // use the existing send path used for other JSON messages
}
```
Use the SAME send mechanism the file already uses for other outbound JSON messages (do not introduce a second path). Keep the URL as `ws://<ip>:<port>/ws` — the `?pin=` query is no longer required but may remain harmlessly.

- [ ] **Step 3: Handle `Connected` / `AuthFailed` in the receive loop**

Where inbound JSON is dispatched on `type`:
- `"connected"` → mark paired, call the existing `startViewing`/onConnect handler (this already exists today).
- `"auth_failed"` → surface a wrong-PIN error (set the existing connection-error state and stop reconnecting, mirroring today's behavior).

- [ ] **Step 4: Verify the iOS build**

Run: `cd ios_app && xcodebuild -project MyApp.xcodeproj -scheme MyApp -destination 'generic/platform=iOS Simulator' -configuration Debug build CODE_SIGNING_ALLOWED=NO`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add ios_app/MyApp/Services/ControlService.swift ios_app/MyApp/Services/ConnectionStore.swift
git commit -m "feat(ios): message-based Pairing handshake with the Mac app"
```

---

## Task 9: Loopback integration check + docs

**Files:**
- Scratch verification script (not committed, or committed under `scripts/mobile/`): a tiny Swift program that opens `URLSessionWebSocketTask` to `ws://127.0.0.1:3006/ws`, sends `Pairing{pin:<PIN from Keychain>}`, and prints the `Connected` reply.
- Modify: `docs/mobile/quick-start.md` (and `docs/mobile/verification.md`) to describe the native server.

- [ ] **Step 1: Loopback pairing check**

With the Mac app running and Mobile Control enabled (Settings → enable + Start):
1. Read the PIN: `security find-generic-password -s '<KeychainStore service>' -a 'mobile::pin' -w` (use the real service name from `KeychainStore`).
2. Run the scratch client; send `{"type":"pairing","pin":"<pin>"}`; assert the reply is `{"type":"connected","deviceName":"…"}`.
3. Send `{"type":"pairing","pin":"000000"}` (wrong); assert `{"type":"auth_failed",…}` then close.
4. Send `{"type":"heartbeat"}`; assert `{"type":"heartbeat_ack",…}`.

If step 1's `security` call format differs, adjust to the `KeychainStore` account scheme found in Task 2.

- [ ] **Step 2: Rewrite `docs/mobile/quick-start.md`**

Replace the "start the external computer-agent / `npm start`" instructions with: enable Mobile Control in the Mac app Settings → it runs the native server on `:3006` + advertises `_llmide._tcp` → open the iOS app → discover/pair. Note that the Node `computer-agent` is no longer used.

- [ ] **Step 3: Commit**

```bash
git add docs/mobile/quick-start.md docs/mobile/verification.md
git commit -m "docs: Phase 2 native Mac server pairing quick-start"
```

---

## Phase 2 Done — Definition of Done

- [ ] `cd ios_app/SharedProtocol && swift test` passes (now 8 tests, incl. `Pairing`).
- [ ] `cd mac && swift build` succeeds; no references to removed members (`start(agentPath:)`, `spawn`, `probeInfo`, `resolveMobileAgentPath`).
- [ ] `cd ios_app && xcodebuild … iOS Simulator build` succeeds.
- [ ] Mac app: enabling Mobile Control starts the native server on `:3006` + advertises `_llmide._tcp`; Settings shows IP/PIN/QR; no agent-folder UI.
- [ ] Loopback check: correct PIN → `Connected`; wrong PIN → `AuthFailed`+close; `Heartbeat` → `HeartbeatAck`.
- [ ] `docs/mobile/*` updated to the native-server model.

## Follow-on Phases (separate plans)

- **Phase 3** — llm-ide command channel: inbound dispatch in `MobileControlManager.handleInbound` for chat (via `LlmIdeAPIClient`), `llmide://` deep links, app/menu control; streamed `Output`. Add `LlmIdeChat`/`LlmIdeDeepLink`/`LaunchApp`/`QuitApp`/`MenuClick`/`Ack`/`Output`/`Error` to SharedProtocol.
- **Phase 4** — screen capture (in-process ScreenCaptureKit) + `StartViewing`/`StopViewing`.
- **Phase 5** — input injection (CGEvent) + `RemoteInput`.
- **Phase 6** — polish + llm-ide color-palette swap + `aicontrol://` QR-scheme rename + final docs.
