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
    ├──► LLM-IDE Chat → LlmIdeAPIClient (:3456)
    ├──► Explorer sessions → ChatSessionStore
    ├──► Auto Tasks → AutoCodeUpdateService / AutoTaskSettings
    └──► Loop → the loopEngineering auto task + LoopRunJournal
        │
        ▼
LLM-IDE Server (Node.js @ :3456)
    └── Main backend server
```

`MobileControlManager` dispatches Auto Tasks and Loop requests through `MobileFeatureBridge` protocol — when either feature is compiled out (via `LLMIDE_FEATURES`), the phone receives a degrade reply instead of routing to the feature's service.

**Build-time exclusion:** Mobile Control is excludable at build time via the `mobile_sync` feature (settings key `LLMIDE_FEATURES=…`). When excluded, the 15-file mobile unit (MobileControlManager, WebSocket server, Bonjour advertiser, PIN cache, bridges, and iPhone pairing UI) is removed entirely, along with the SharedProtocol product dependency (iOS wire types). The core `MobileFeatureBridge` protocol stays in-tree to support dynamic downgrades when other features are excluded (Phase 2d).

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
