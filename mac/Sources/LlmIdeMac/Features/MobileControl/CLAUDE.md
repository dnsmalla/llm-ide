# Mobile Control System

LLM-IDE includes a native mobile companion: the **Mac app** runs a WebSocket server on `:3006` by default (configurable in Settings → Mobile Control; if busy, the next free port up to +9 binds automatically and Bonjour `_llmide._tcp` + the pairing QR advertise the actual port; PIN pairing), and the **iOS app** in `ios_app/` connects as a client. Chat requests are proxied to the local backend at `http://127.0.0.1:3456`.

> The external Node `computer-agent` (`auto_swift_aicontrol`) is **retired**. Remote desktop / screen streaming / input injection were cancelled; the iPhone is a chat/explorer/auto-tasks companion only.

## Architecture

```
iPhone App (SwiftUI, ios_app/)
    │ Bonjour + WebSocket + PIN auth
    ▼
LLM-IDE Mac app (native NWListener WebSocket on :3006)
    │ MobileControlManager.handleInbound
    ├──► LLM-IDE Chat → chatHost (MobileChatHosting) → Chat's shared .quick engine → :3456
    ├──► Explorer chats/sessions → chatHost → Chat's .explorer engines + session store
    ├──► Auto Tasks → AutoCodeUpdateService / AutoTaskSettings
    └──► Loop → the loopEngineering auto task + LoopRunJournal
        │
        ▼
LLM-IDE Server (Node.js @ :3456)
    └── Main backend server
```

`MobileControlManager` dispatches Auto Tasks and Loop requests through `MobileFeatureBridge` protocol — when either feature is compiled out (via `LLMIDE_FEATURES`), the phone receives a degrade reply instead of routing to the feature's service.

The Auto Task and Loop bridges are **not** in this folder: `MobileAutoTaskBridge` lives in `Features/AutoTask/Services/` and `MobileLoopBridge` in `Features/Loop/Services/`. They see the manager only as `MobileBridgeHosting` (`Core/Contracts/`), which the manager implements in `Services/MobileControlManager+BridgeHost.swift` — that file owns their whole wire mapping (tag → `MobileAutoTaskRequest`/`MobileLoopRequest`, `MobileAutoTaskReply`/`MobileLoopReply` → `SharedProtocol` types), because the bridges compile with `auto_tasks` even when `mobile_sync` (and so `SharedProtocol`) is out. A new `auto_task_*`/`loop_*` tag must update the routing Set, that decode switch, the request enum and the bridge's `switch`; `MobileFeatureBridgeTests` pins the Set against the decode.

**Phone chat reaches Chat only through `chatHost`.** MobileControl is sealed: it may not name any Chat type (`ChatEngine`, `ChatEngineRegistry`, `ChatSession`, `ChatSessionStore`, `QuickChatContext`, …). Everything the chat arms need — `llmide_chat` / history / clear on the shared quick chat, `explore_chat` turns, `explore_*` session list/load/new/rename/delete, parked-approval relay (`onExternalApproval`, `parkedApproval`, `submitPhone*`) — goes through `MobileControlManager.chatHost: (any MobileChatHosting)?` and the `MobileChatTurnEngine` handles it returns (`Core/Contracts/MobileChatHosting.swift`, Core/Foundation types only). Chat implements it in `Features/Chat/Services/ChatMobileHost.swift`, which also owns `ExplorerMobileEngineResolver` (the off-screen `.explorer` engine pool, registered as `ChatEngineRegistry`'s external holder when the host is built); Shell sets `manager.chatHost = ChatMobileHost()` in `FeatureCatalog.bootMobile`. A nil host answers each chat request with `replyFeatureUnavailable(feature: "Chat", …)`. A new chat capability extends the protocol (and `ChatMobileHost`) rather than reaching into Chat; tests that drive the manager's chat paths must set `chatHost` themselves.

**Build-time exclusion:** Mobile Control is excludable at build time via the `mobile_sync` feature (settings key `LLMIDE_FEATURES=…`). When excluded, the whole `Features/MobileControl/` folder (MobileControlManager, WebSocket server, Bonjour advertiser, PIN cache, its own per-feature bridges, and iPhone pairing UI) is removed entirely, along with the SharedProtocol product dependency (iOS wire types). The core `MobileFeatureBridge` protocol stays in-tree to support dynamic downgrades when other features are excluded (Phase 2d).

## Quick Start

```bash
# Terminal 1: Start LLM-IDE server
cd ~/llm-ide/extension && node server.mjs

# Terminal 2: Mac app — Settings → Mobile Control → Start
# (or launch LlmIdeMac with mobile control auto-start enabled)

# Terminal 3: iOS app (Xcode)
cd ~/llm-ide/ios_app && open MyApp.xcodeproj
# Run on physical iPhone (same Wi-Fi or Tailscale)
```

## Features

- **LLM-IDE Chat** — Ask questions from iPhone (streamed via Mac → :3456)
- **Explorer** — List and chat with Mac explorer sessions
- **Auto Tasks** — Toggle and inspect scheduled auto-code tasks
- **Loop** — Start/stop the active project's Loop — the whole run or a single stage — watch the live log, read finished runs (control only; stages and budgets are edited on the Mac)
- **Device Discovery** — Bonjour/mDNS (`_llmide._tcp`) or Direct IP + PIN
- **PIN Authentication** — 6-digit PIN + QR code (`llmide://pair?…`). Pairing trades the PIN for a **per-device token** (`MobilePairedDeviceStore`, hashed on disk; the phone keeps it in its Keychain) and the PIN **rotates** right after; the phone reconnects with the token. Settings → Mobile Control lists paired devices with **Revoke**. The PIN is one-time (rotates on every successful pairing); older phones (no `deviceId`) still pair but get no token and must re-pair with the new PIN

## Tier gate and desktop confirmations

- **One table, one gate.** `PhoneTierTable` (Services/) classifies EVERY wire message type (R, C, T0, T1, T2, D, plus
  link and Mac-to-phone). `handleInbound` consults it before any bridge sees a frame; unknown, Mac-to-phone and
  desktop-only types are refused with a typed code (`MobileRefusalCode`). A new tag in `MobileProtocol.Tag` without a
  row fails `PhoneTierTableTests`. Bridges keep their own switch and payload checks (defence in depth).
- **Desktop confirmation.** Phone-started actions that write code or leave the machine (Auto Task implement and
  review-merge, Self-Heal apply/discard) go through `PhoneDesktopApprovalGate`: native modal, default Cancel, 120 s
  timeout denies, one at a time, 3 per 5 minutes. Features reach it only through `MobileBridgeHosting.requestDesktopApproval`.
  Re-check switch, setting and project AFTER the approval, before acting.
- **Queued phone work is re-validated when it executes** (switch and active project), not only at receipt.

## Adding a phone capability (the bridge registry + Phone access)

- New bridges go through `MobileControlManager.register(bridge:messageTypes:capabilities:)` (see
  `MobilePhoneToolBridges.swift`) — no new slot or routing Set needed. Each capability can sit behind a
  `PhoneAccess` switch (`PhoneAccessSettings`): it is advertised only while the switch is ON, **and the
  handler must re-check the switch on every request** (a phone may hold an old capability list).
- Anything that edits files, posts as the user or approves a tool defaults **OFF**. Replies must be shaped
  for the phone's pending request (never a bare `CommandError(commandId: <type>)`), so a screen can't spin.
- Switches that gate control from the phone, all default **OFF**: `autoTaskControl` (Auto Task **run** only: toggles, config and templates are desktop-only, and implement/review-merge also need a desktop confirmation),
  `loopControl` (`loop_start*`), `generationRun`, plus `fileBrowse` for Explore search and `@file` refs. They are
  enforced in the handlers, not through advertised capabilities, so an old phone sees the screens and gets a typed refusal.
- Never take a path from the phone as a filesystem path: resolve ids on the Mac (recents, incidents) or
  check the path against the Mac's own list (git status). Re-check symlink TARGETS, open regular files only.
- **Redact through `PhoneRedaction`, never `IncidentRedactor` directly.** Its regexes backtrack
  quadratically on one huge unbroken token (a 200 000-character line took ~7 minutes); `PhoneRedaction`
  cuts each line first. Run it off the main actor.
- **Log frames through `MobileLogPolicy`** (type + byte size), never a preview of frame content: the
  log pane is on screen and frames carry chat text, file content and tokens.
- Pure decision/shaping functions are `nonisolated static` so tests can pin them (see the `Mobile*BridgeTests`).
  Test files that name mobile-only types must be added to `mobileTestExcludes` in `mac/Package.swift`.

## Permissions Required

- **macOS**: None for mobile chat (Accessibility/Screen Recording are for caption capture elsewhere, not mobile pairing)
- **iOS**: Local Network (Bonjour discovery)

## Documentation

- **Quick Start**: `docs/mobile/quick-start.md`
- **Verification**: `docs/mobile/verification.md`
- **Loopback check**: `scripts/mobile/verify-native-pairing.swift`

## Key Files (Mac)

```
mac/Sources/LlmIdeMac/Features/MobileControl/Services/
├── MobileControlManager.swift   # WebSocket dispatch + backend proxy
├── MobileWebSocketServer.swift  # NWListener on :3006
├── MobileBonjourAdvertiser.swift
└── MobilePin.swift              # Pairing PIN (Keychain)

ios_app/SharedProtocol/          # Codable wire types (Mac + iOS)
ios_app/MyApp/Services/
├── ConnectionService.swift      # WebSocket client + pairing
└── DeviceDiscovery.swift        # Bonjour browser
```
