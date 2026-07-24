# Mobile Code Cleanup & Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove accumulated dead code, collapse duplication into reusable helpers/components, decompose overgrown types, and fix two correctness smells — across the mobile effort (SharedProtocol + Mac mobile services + iOS), which grew across Phases 1-4 + B + C and a product pivot.

**Source:** the three cleanup audits (SharedProtocol / Mac / iOS). Each task references the audit findings (file:line).

**Branch:** `refactor/mobile-cleanup` from `main` (commit `1fbda18`). All builds + the 19 SharedProtocol tests must stay green after every task. No behavior change except the two correctness fixes (Task 8) and the intentional dead-code removal. Conventional commits (`refactor:`); do not push.

## Global Constraints
- Behavior-preserving except Task 8 (correctness) and dead-code removal. Wire formats (`type` tags, JSON shapes) must NOT change — existing tests + the iOS/Mac consumers are the gate.
- SharedProtocol structs use `let type = "…"` with no custom `init(from:)` → Mac dispatch MUST stay the envelope `{type}` switch (do not regress to sequential decode).
- `LaunchPathResolver.findServerDirectory` is LIVE (BackendManager) — do not touch it.
- After each task: `cd ios_app/SharedProtocol && swift test` (19), `cd mac && swift build`, and (when iOS touched) `xcodebuild … iOS Simulator build` must all pass.

---

## R1 — Dead code

### Task 1: Mac dead code
**Files:** delete `mac/Sources/LlmIdeMac/Services/MobileCommandRouter.swift`; modify `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` + `Views/CodeAssistant+Voice.swift` (remove `mobileRouter` state + the 6 call sites: `notifyTyping`/`sendVoiceTranscript`/`sendMessage`/`scrollUp`/`scrollDown`/`goBack`); `mac/Sources/LlmIdeMac/Models/Config.swift` (drop `mobileControlAgentPath` + its init load); minor: `MobileBonjourAdvertiser.swift` (delete the no-op `netService(_:didNotPublish:)` OR plumb an onError — pick delete), `MobilePin.swift` (drop unreachable `MobilePinError.encodingFailed`), `MobileConnectionInfo.swift` (drop the `AgentPin` shim, call `MobilePin.read()` directly).
- [ ] Read the audit's Mac findings (DC1-DC5, S3) for exact call-site line refs.
- [ ] Delete `MobileCommandRouter.swift` + remove its 6 call sites + `mobileRouter` state.
- [ ] Drop `Config.mobileControlAgentPath` (+ init line).
- [ ] Minor Mac dead bits.
- [ ] `cd mac && swift build` → SUCCEEDED.
- [ ] Commit `refactor(mac): remove dead MobileCommandRouter + dormant config`.

### Task 2: iOS dead code
**Files:** `ios_app/MyApp/Views/Control/RemoteDesktopView.swift` (trim to host: toolbar + Chat/Explore/Auto sheets + banners/toast/status — delete the ~1000-line screen/touch/zoom/key-palette/voice body + dead `@State` + private types `PulsingWaveform`/`HiddenKeyboardInput`); rename `RemoteDesktopView` → `MobileHomeView` (update `ContentView`); `ios_app/MyApp/Services/ControlService.swift` (remove the dead surface: `messages`/`sendPrompt`/`stopPrompt`/`clearChat`/`screenImage`/`startViewing`/`stopViewing`/`sendRemoteInput`/`decodeFrame`+seq tracking/binary-JPEG receive branch/`launchApp`/`sendKey`/`sendText`/`openLlmIde`/`closeLlmIde`/`clickMenu`/`sendCommand` + the dead `ack` receive branch + the `messages` fallbacks in output/error handlers).
- [ ] Read the audit's iOS findings (D1/D2/D3/D4) for exact line refs.
- [ ] Trim+rename RemoteDesktopView → MobileHomeView (host only); update ContentView + any references.
- [ ] Remove the dead ControlService surface + dead `ack` branch + `messages` fallbacks.
- [ ] Drop the `aicontrol://` QR arm (this repo's Mac emits `llmide://` only) — or keep if unsure; note it.
- [ ] iOS sim build SUCCEEDED + `swift test` (19) + mac build.
- [ ] Commit `refactor(ios): remove dead remote-desktop body + legacy surface (MobileHomeView)`.

---

## R2 — Dedup → reusable

### Task 3: SharedProtocol dedup + structure
**Files:** `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift` (+ split into `ConnectionMessages.swift`/`LlmIdeChatMessages.swift`/`ExplorerMessages.swift`/`AutoTaskMessages.swift`, keep `MobileProtocol.swift` for the constants enum).
- [ ] Delete the 25 redundant `CodingKeys` blocks (audit lists every line range) — verify JSON unchanged via the existing round-trip tests (they must stay green).
- [ ] Split the file into 4 by feature (move shared leaf types `ChatTurn`/`ChatImage`/`ChatFileText` with the chat file).
- [ ] Centralize the 24 `type`-tag strings as `MobileProtocol.Tag` constants; reference them from each struct's `let type = …`.
- [ ] `swift test` (19) green; mac + iOS builds (consumers reference the types — ensure no breakage).
- [ ] Commit `refactor(shared-protocol): drop redundant CodingKeys, split file, centralize tags`.

### Task 4: Mac dedup helpers
**Files:** `MobileControlManager.swift` (+ `MobileWebSocketServer.swift` for the shared decoder).
- [ ] Add `private let decoder = JSONDecoder()` (+ `encoder`) reused across `handleInbound` cases + the WS server.
- [ ] Add `private func reply(_ message: some Encodable) { Task { await server?.send(message) } }`; replace the ~17 `Task { await server?.send(...) }` sites.
- [ ] Consolidate `ChatTurn`↔`CodeAssistTurn` mapping (both directions) into one place (e.g. extensions on `ChatTurn`).
- [ ] Factor the duplicated "Auto-tasks not configured" path → `replyNotConfigured(_ commandId:)`.
- [ ] mac build 0 warnings; `swift test` (19).
- [ ] Commit `refactor(mac): dedup handleInbound (shared decoder, reply helper, turn mapping)`.

### Task 5: iOS dedup helpers + shared UI components
**Files:** `ControlService.swift` (senders); new `ios_app/MyApp/Views/Shared/` components; the 3 chat views.
- [ ] Add `private func sendEncodable<T: Encodable>(_:)`; collapse the 9 identical senders.
- [ ] Extract the shared streaming-chat logic into one helper (history-window + placeholder + commandId); note/resolve the `.suffix(10)` vs `.suffix(8)` inconsistency.
- [ ] Extract reusable components: `ChatBubble`, `ChatInputBar`, `StatusBanner` (.connection/.error), `EmptyChatState`; adopt in `LlmIdeControlView`/`ExplorerChatView`/`AutoTaskView`.
- [ ] Move duplicated `haptic(_:)` + `relativeTime(from:)` to `DesignSystem`/`Date` extensions.
- [ ] Add new files to the Xcode target (pbxproj); iOS sim build SUCCEEDED.
- [ ] Commit `refactor(ios): dedup senders + shared chat components`.

---

## R3 — Structure

### Task 6: Decompose Mac `handleInbound`
**Files:** `MobileControlManager.swift`.
- [ ] Split the 137-line switch by feature prefix: `llmide_chat`→`handleChat`; `explore_*`→`handleExplore(env,data)` (own switch); `auto_task_*`→`handleAutoTask(env,data)` (own switch); default → log. Keep the envelope `{type}` decode + the R2 helpers.
- [ ] mac build; `swift test` (19).
- [ ] Commit `refactor(mac): decompose handleInbound by feature`.

### Task 7: Split iOS `ControlService` into stores
**Files:** `ControlService.swift` → `ConnectionService` (socket/pairing/heartbeat/reconnect/sendTextFrame/sendEncodable/errorMessage/connectionStatus) + `LlmIdeChatStore` + `ExplorerChatStore` + `AutoTaskStore`, each injected with the `ConnectionService`. Update the views + ContentView wiring.
- [ ] This is the biggest structural change — each store owns its state + commandId set + its own `output`/`error` handling (which also fixes the shared-`llmStreaming` smell, see Task 8). Preserve all wire behavior.
- [ ] iOS sim build SUCCEEDED; mac build; `swift test` (19).
- [ ] Commit `refactor(ios): split ControlService into per-feature stores`.

---

## R4 — Correctness

### Task 8: Fix shared-streaming flag + error-handler mismatch
**Files:** the stores (post-Task-7) + the iOS `"error"` receive path.
- [ ] Replace the single shared `llmStreaming` with per-store "in-flight" derived from each store's commandId set (`!ids.isEmpty`); update the views' `canSend` to read their store's in-flight.
- [ ] **Verify then fix** the iOS `"error"` handler: it reads `json["payload"]["message"]` (nested) but `CommandError` serializes flat `{type,commandId,message}`. Confirm whether error messages actually surface; if not, fix the decode to read `json["message"]` (flat) so `CommandError` errors reach the phone.
- [ ] iOS sim build; `swift test` (19); manual: trigger an error (e.g. stop the backend, send a chat) → confirm it surfaces on the phone.
- [ ] Commit `fix(ios): per-surface streaming state + surface CommandError messages`.

---

## Done — Definition of Done
- [ ] Dead code removed (MobileCommandRouter, RemoteDesktopView remote body → MobileHomeView, dead ControlService surface, dormant Config).
- [ ] Duplication collapsed (25 CodingKeys, senders, reply/decoder helpers, shared UI components).
- [ ] Structure: `handleInbound` decomposed; `ControlService` split into stores; SharedProtocol split + tags centralized.
- [ ] Correctness: per-surface streaming; `CommandError` errors surface on the phone.
- [ ] All builds green; 19 SharedProtocol tests green; wire formats unchanged.
