# iOS App ↔ Mac App — Native Link & Control

**Date:** 2026-07-22
**Status:** Design (pending approval)
**Scope:** Bring the iOS remote-control app into the repo under `ios_app/`, rebrand it to llm-ide, and make the macOS app the native control server the iPhone pairs with — replacing the external Node "computer-agent" middleman.

---

## 1. Goals & Non-Goals

### Goals
1. Move the existing iOS app (currently `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios`) into this repo under `ios_app/`.
2. Rebrand the iOS app to llm-ide (display name "LLM IDE", bundle id `com.llmide.mobile`, llm-ide theme).
3. Port the Mac-side agent responsibilities (WebSocket server, Bonjour discovery, PIN auth, screen capture, input injection, llm-ide proxy) **into the Mac app itself as native Swift** — no Node process.
4. Establish a **shared protocol package** consumed by both the Mac and iOS targets so the wire format cannot drift.
5. Deliver two control surfaces on the iPhone: **remote desktop** (screen + input) **and** dedicated llm-ide controls (chat, deep links, app/menu control).

### Non-Goals
- No Mac-app button to open/build the Xcode project (decided against; the iOS app is built directly in Xcode with light repo tooling only).
- No changes to the `:3456` backend (`extension/server.mjs`) — the Mac app already reaches it via `LlmIdeAPIClient`.
- No cloud relay; control stays LAN-local (Bonjour + WebSocket + PIN), matching today's trust model.
- The external `auto_swift_aicontrol` repo is **not** deleted or moved; it remains as a reference. This repo simply stops depending on it.
- TLS (`wss://`) is a future enhancement, not in scope; this design keeps the current PIN-over-`ws://` LAN model for parity.

---

## 2. Settled Decisions

| Decision | Choice |
|---|---|
| Control surface | Remote desktop **+** dedicated llm-ide controls |
| Transport | **Native** — the Mac app is the server (no Node middleman) |
| "Link" meaning | Runtime pairing (Bonjour + PIN/QR) **+** shared protocol module |
| Branding | Rebrand iOS app to llm-ide |
| Single-client policy | **Replace** — newest valid connection wins |
| Wire protocol | Unchanged from the existing app (iPhone changes are minimal) |

---

## 3. Architecture & Repo Structure

### New `ios_app/` layout
```
llm-ide/
├── ios_app/
│   ├── MyApp.xcodeproj/              # moved in, rebranded
│   ├── MyApp/                         # iOS sources (rebranded; consumes SharedProtocol)
│   └── SharedProtocol/               # NEW local SPM package, consumed by BOTH targets
│       ├── Package.swift              # platforms: .macOS(.v14), .iOS(.v16)
│       └── Sources/SharedProtocol/    # Codable message types + protocol constants
├── mac/Package.swift                  # + .package(path: "../ios_app/SharedProtocol")
└── mac/Sources/LlmIdeMac/Services/
    ├── MobileControlManager.swift        # refactored: OWNS the native server (no child spawn)
    ├── MobileWebSocketServer.swift       # NEW — Network.framework NWListener
    ├── MobileBonjourAdvertiser.swift     # NEW — NetService _llmide._tcp
    ├── MobileScreenCapture.swift         # NEW — ScreenCaptureKit in-process (port of ScreenStreamer.swift)
    ├── MobileInputInjector.swift         # NEW — CGEvent mouse/keyboard
    ├── MobileCommandRouter.swift         # repurposed: INBOUND dispatch (iPhone → handlers)
    └── MobileConnectionInfo.swift        # kept: LAN/Tailscale IP + PIN + QR display
```

### Shared protocol package (`ios_app/SharedProtocol`)
Pure `Codable` types + constants — no UI, no networking — so it builds for both macOS 14 and iOS 16. Consumed by:
- **Mac app**: SwiftPM local path dependency in `mac/Package.swift`.
- **iOS app**: local SPM package added to the Xcode project.

This is the single seam between the two apps; both sides import the same types, so the wire format cannot drift.

### Removals / deprecations (cleanup payoff of going native)
- `MobileControlManager`'s child-process spawn (`npm start`), `LaunchPathResolver` agent-path detection, and the agent-folder browse UI.
- The hardcoded `iosAppPath = "~/Desktop/.../apps/ios"` in Settings.
- The entire external Node computer-agent dependency.
- `MobileCommandRouter`'s outbound HTTP-to-`:3006` calls become internal function calls.

### Backend invariant
Nothing in `extension/` changes. The Mac app already talks to `:3456` via `LlmIdeAPIClient`; that client is reused for the chat proxy.

---

## 4. Components

### 4.1 Shared protocol package (`SharedProtocol`)

**Constants**
- Service type: `_llmide._tcp`
- Default port, heartbeat interval (10s), timeout (25s)

**Inbound (iPhone → Mac)**
- `Heartbeat`
- `StartViewing`, `StopViewing`
- `RemoteInput` — action union: `move` / `click` / `doubleClick` / `rightClick` / `down` / `up` (with normalized `x,y ∈ 0…1` + optional `button`), `scroll` (`deltaY`), `key` (`key` + `modifiers`), `text` (`text`)
- `LlmIdeChat` (`text`, `history`, optional `image`)
- `LlmIdeDeepLink` (`url`, e.g. `llmide://transcript`)
- `LaunchApp` (`appName`), `QuitApp` (`appName`), `MenuClick` (`appName`, `path: [String]`)

**Outbound (Mac → iPhone)**
- `Connected` (`deviceName`)
- `HeartbeatAck` (`ts`)
- `AuthFailed` (`message`)
- `Ack` (`commandId`, `message`, optional `started`/`ok`)
- `Output` (`commandId`, `stream`, `done`) — streamed reply chunks
- `Error` (`message`)

Binary JPEG frames are raw bytes (detected by JPEG magic prefix) and are **not** modeled in the package.

### 4.2 Mac app — native server

| Component | Role | Depends on |
|---|---|---|
| `MobileControlManager` (refactored) | Lifecycle supervisor: start/stop server, Bonjour, capture; holds the single active client; surfaces status to UI. No child process. | all server components |
| `MobileWebSocketServer` | `NWListener` WebSocket on the configured port; PIN auth on upgrade (wrong PIN → `AuthFailed` + close 4001); routes inbound text frames to the router; binary frames are send-only (JPEG). | SharedProtocol |
| `MobileBonjourAdvertiser` | Publishes `_llmide._tcp` with port + device name. | — |
| `MobileScreenCapture` | ScreenCaptureKit **in-process** (port of existing `ScreenStreamer.swift`, already Swift) → JPEG frames at target fps/quality; drops frames under backpressure. Requires Screen Recording. | ScreenCaptureKit / AVFoundation |
| `MobileInputInjector` | `CGEvent` mouse move/click/scroll/drag + keyboard (sticky modifiers, named keys, text). Replaces nut-js. Requires Accessibility. | CoreGraphics / ApplicationServices |
| `MobileCommandRouter` (repurposed) | Inbound dispatch: decodes a `SharedProtocol` message → calls the right handler (capture start/stop, input, `LlmIdeAPIClient` chat, deep-link open, app/menu control). Emits `Ack`/`Output`/`Error`. | SharedProtocol, LlmIdeAPIClient, capture, injector |
| `MobileConnectionInfo` (kept) | LAN + Tailscale IPs (`getifaddrs`), PIN (Keychain), QR payload for the UI. | — |

**PIN storage** — generated on first run, stored in the macOS Keychain (mirroring the iOS side's Keychain use), surfaced in Settings + encoded in the QR.

**Settings UI** — switches from "browse for the agent folder" to "show IP / PIN / QR + Screen Recording & Accessibility prompts + start/stop."

Every Mac-native responsibility has a direct Swift replacement (ScreenCaptureKit, CGEvent, Network.framework, NetService), so nothing requires the Node process.

### 4.3 iOS app changes
- **Rebrand**: bundle id → `com.llmide.mobile`, display name "LLM IDE", theme tokens → llm-ide colors; signing team unchanged.
- **Consume `SharedProtocol`**: `ControlService`'s hand-rolled message dictionaries become the shared `Codable` types — same wire format, far less drift.
- **Discovery**: Bonjour service type → `_llmide._tcp` (one constant, sourced from the package).
- **Transport**: unchanged — still `ws://<ip>:<port>/ws?pin=`. Because the protocol is identical, `RemoteDesktopView`, `LlmIdeControlView`, gestures, voice, and QR pairing keep working.

---

## 5. Data Flow

### 5.1 Pairing & discovery
1. Mac app starts `MobileControlManager` → `MobileBonjourAdvertiser` publishes `_llmide._tcp`; `MobileWebSocketServer` listens.
2. iPhone `DeviceDiscovery` browses `_llmide._tcp`, lists the Mac by device name.
3. User taps the Mac (or scans the QR the Mac app shows, encoding `llmide://pair?ip=&port=&pin=`) → `ControlService` opens `ws://<ip>:<port>/ws?pin=<PIN>`.
4. `MobileWebSocketServer` validates PIN on upgrade → emits `Connected{deviceName}`; iPhone sends `StartViewing`.

### 5.2 Screen streaming (Mac → iPhone, one-way)
1. `StartViewing` → `MobileScreenCapture` begins a ScreenCaptureKit session, encodes JPEG frames at target fps/quality.
2. Frames sent as **binary** WS messages, only when socket buffered amount < backpressure threshold (drops frames under congestion).
3. `StopViewing` / disconnect → capture session torn down.
4. iPhone decodes off-main, orders by sequence number, renders in `RemoteDesktopView`.

### 5.3 Input injection (iPhone → Mac)
1. Gestures in `RemoteDesktopView` produce a `RemoteInput` action with normalized 0–1 coords (+ scroll delta / key / text).
2. Sent as a text frame → `MobileCommandRouter` decodes → `MobileInputInjector` scales normalized coords to real screen dims, fires matching `CGEvent`(s).
3. Sticky modifiers and named keys handled in the injector (parity with current nut-js behavior).

### 5.4 LLM IDE commands (iPhone → Mac → :3456, reply streamed back)
1. iPhone sends `LlmIdeChat` (or `LlmIdeDeepLink`, `LaunchApp`, `MenuClick`).
2. `MobileCommandRouter` → for chat, calls existing `LlmIdeAPIClient` (Mac app already authenticates to `:3456`); reply streamed back as `Output{stream, done}` chunks.
3. Deep links and app/menu control go through `NSWorkspace` / `osascript` — same actions the Node agent performed, now native.

### 5.5 Directionality
With the Mac app being the server, the old `MobileCommandRouter` *outbound* path (Mac app → `:3006`) disappears — those become direct in-process calls into capture/injector. The Mac app's only outbound network is to its own `:3456` backend (already exists via `LlmIdeAPIClient`).

---

## 6. Error Handling

**Connection lifecycle / heartbeat**
- 10s heartbeat, 25s timeout (parity with current iOS client). Missed acks → manager drops the client, stops capture, re-advertises availability; iPhone's exponential-backoff reconnect re-establishes.
- **Single active client = "replace"**: a new connection with a valid PIN replaces the prior session (newest wins), so a phone that crashed and rejoined is never locked out.

**Auth failures**
- Wrong PIN on upgrade → server completes handshake, sends `AuthFailed{message}`, closes 4001 (clear reason on the phone, no silent drop).
- PIN in macOS Keychain (generated on first run), shown in Settings + encoded in the QR.

**Permission failures (the two hard requirements)**
- **Screen Recording** missing → `MobileScreenCapture` fails fast; manager surfaces "Screen Recording required"; Settings links to System Settings. Server still serves chat/deep-links; only capture is gated.
- **Accessibility** missing → `CGEvent`s silently no-op at the OS level, so the injector detects missing consent on first use and surfaces "Accessibility required" rather than letting clicks vanish silently.

**Capture & network resilience**
- ScreenCaptureKit session errors → 3 consecutive failures push `Error` to the phone and stop the stream (same threshold as current agent); iPhone shows "stream stopped."
- Frame backpressure: if buffered amount exceeds threshold, frames are dropped (never queued) to keep latency low under congestion.

**Backend (`:3456`) failures**
- Chat proxy reuses `LlmIdeAPIClient`'s existing handling: 401 → token refresh + retry, 429 → honor `Retry-After`, other errors → `Error` to the phone. If the backend is down, chat degrades gracefully while screen/input keep working.

**Validation discipline** (project invariant): every inbound message decoded via shared `Codable` types; unknown/malformed messages dropped with an `Error` ack rather than crashing the server. Binary from the client is ignored.

---

## 7. Testing

**Automated (`swift test`)**
- **Shared protocol**: Codable encode/decode round-trip for every message type.
- **`MobileCommandRouter`**: dispatch tests with protocol seams (mock capture/injector/client) — assert the right handler fires and the correct `Ack`/`Output`/`Error` is emitted.
- **`MobileInputInjector`**: pure-math unit tests — normalized→pixel scaling, modifier/key mapping — without firing real events.
- **`MobileWebSocketServer`**: loopback integration — handshake / wrong-PIN `AuthFailed`+close / heartbeat ack / single-client replace.

**Seam + manual**
- **`MobileScreenCapture`**: ScreenCaptureKit can't be exercised without a real screen + permission, so the JPEG-encoding/backpressure logic is extracted behind a testable seam; the OS call is covered by the manual checklist.

**iOS app**
- Add a minimal test target for `ControlService` message encoding via `SharedProtocol` (the project has no iOS tests today).

**Manual checklist** (physical iPhone + Mac, both permissions granted)
- [ ] iPhone discovers the Mac via Bonjour (`_llmide._tcp`)
- [ ] PIN pairing works; QR pairing works
- [ ] Wrong PIN shows a clear `AuthFailed`
- [ ] Screen stream starts on `StartViewing`, stops on `StopViewing`
- [ ] Tap/drag/scroll/keyboard inject correctly (Accessibility granted)
- [ ] llm-ide chat streams a reply; deep link opens the right tab
- [ ] Phone killed + rejoined reconnects (replace policy)
- [ ] Missing Screen Recording → capture gated, chat still works
- [ ] Missing Accessibility → clear status, no silent no-op

**Gate**: every phase ends with `swift build` + `swift test` green (the pre-push hook already enforces this).

---

## 8. Phasing & Migration

Each phase is independently shippable and ends green.

1. **Structure + shared protocol** — create `ios_app/SharedProtocol` (all types + constants), wire into `mac/Package.swift`, move + rebrand the iOS app into `ios_app/` consuming the package. Codable round-trip tests. No runtime behavior yet.
2. **Native server core** — `MobileWebSocketServer` + `MobileBonjourAdvertiser` + PIN (Keychain) + heartbeat; refactor `MobileControlManager` to own it (drop child-spawn + agent-folder UI + hardcoded path); Settings → IP/PIN/QR. iPhone can discover, pair, connect.
3. **llm-ide command channel** — inbound `MobileCommandRouter` dispatch for chat (`LlmIdeAPIClient`), deep links, app/menu control; streamed `Output`. Highest value, no screen perms.
4. **Screen capture** — port `ScreenStreamer.swift` → in-process `MobileScreenCapture`; `StartViewing`/`StopViewing`; backpressure drop; Screen Recording UX.
5. **Input injection** — `MobileInputInjector` (CGEvent), normalized scaling, sticky modifiers; Accessibility UX.
6. **Polish + docs** — reconnect/replace-client, error UX, QR from Mac app; rewrite `docs/mobile/*`, supersede Node-agent integration docs.

Phases 3–5 can be reordered; chat (3) is recommended before capture/input because it is highest-value and lowest-risk.

**Migration**: the external `auto_swift_aicontrol` repo is left in place as reference (not deleted); this repo stops depending on it. `docs/archive/compact-mobile-integration.md` and `docs/archive/mobile-control-complete.md` are superseded by the new `docs/mobile/*`.

---

## 9. Resolved Decisions (review defaults applied)

- **Port**: keep `3006` (minimizes iOS-side churn; no Node agent remains to clash with).
- **Bonjour service type**: `_aicontrol._tcp` → `_llmide._tcp`, with the matching `NSBonjourServices` entry updated in the iOS `Info.plist`.
- **iPad**: keep support (device family 1,2 is already configured).
