# Quick Start: Mobile Control for LLM-IDE

> Pair your iPhone with the Mac app. The Mac app runs the pairing server — **no
> separate Node process.**

## What you get

The iPhone app is a **native data companion** for your Mac — structured JSON
over WebSocket, not a pixel screen mirror:

- **Explore** — list/load/chat Mac explorer sessions (same `ChatSessionStore` as Mac). Attach PDF/Markdown/text files from the iPhone; the Mac runs code-assist with **your Mac Settings** (model + workspace).
- **Auto** — master enable, per-task toggles, run/stop, counts, and history
- **Chat** — ask LLM-IDE questions (Mac proxies to `:3456`)

The home screen shows **live Auto Task and Explorer summaries** synced from the
Mac. Open each surface for full control. This is more reliable than screen
mirroring: no Screen Recording permission, no JPEG lag, and edits persist on the Mac.

> Install from **`ios_app/MyApp.xcodeproj`**. Rebuild after pulling.

## Prerequisites

- LLM-IDE Mac app running with **Mobile Control → Start**
- LLM-IDE backend reachable at `http://127.0.0.1:3456` (Mac **Settings → Backend**
  or `cd extension && node server.mjs`)
- iPhone on the same Wi-Fi as the Mac (or Tailscale on both)
- iOS app built from `ios_app/` (Xcode → run on device)

**Not required:** macOS Screen Recording or Accessibility (those were only for the
removed remote-desktop experiment).

**Helpful on iPhone:** Local Network permission (Bonjour discovery).

## Step 1: Enable Mobile Control on the Mac

1. Open LLM-IDE → **Settings → Mobile Control**
2. Turn on **Enable Mobile Control**
3. Press **Start** — status should show **Running**
4. Note the **IP**, **port** (`3006`), **PIN**, or scan the **pairing QR**

Tick **Start Mobile Control on app launch** if you want the server up automatically.

## Step 2: Pair from the iPhone

Open the LLM-IDE iOS app, then either:

- **Scan the QR** from Mac Settings
- **Pick the Mac** from Bonjour discovery and enter the PIN
- **Enter IP + PIN manually** (Tailscale IP works across networks)

Wire flow:

1. iPhone → `{"type":"pairing","pin":"<PIN>"}`
2. Mac → `{"type":"connected","deviceName":"…"}`
3. Home shows **Live** with Auto Task + Explorer summaries — tap **Open Explorer** or **Open Auto Tasks**

## Verify

```bash
# Pairing (Mac app must be Running)
swift scripts/mobile/verify-native-pairing.swift

# Backend (needed for Chat)
curl -s http://127.0.0.1:3456/health

# Port check — should be LlmIdeMac only
lsof -i :3006
```

## Troubleshooting

### iPhone shows “waiting for screen” or asks for Screen Recording

You have an **old iOS build** from the remote-desktop era. Delete the app,
reinstall from `ios_app/MyApp.xcodeproj`, pair again. The current app shows a
**native dashboard** (Auto + Explorer cards) when **Live**, not a screen mirror.

### Auto or Explore looks empty

- Tap **↻** on the home screen or open the sheet and refresh
- Confirm Mobile Control **Running** on the Mac
- Auto Tasks require the Mac app running with auto-code wired (same as on Mac)

### iPhone can't find the Mac

- Confirm Mobile Control **Running** on the Mac
- Same Wi-Fi or Tailscale on both devices
- `dns-sd -B _llmide._tcp local.` — or use manual IP + PIN

### Pairing fails (wrong PIN)

- Use the PIN currently shown in Mac Settings (Refresh if unsure)
- Keychain: `security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w`

### Port 3006 busy

```bash
lsof -i :3006
```

Quit whatever holds the port, then **Start** Mobile Control again.

### Chat doesn't respond (Live but no reply)

- `curl http://127.0.0.1:3456/health` must succeed
- Mac **Settings → Backend** → Running
- Log in to LLM-IDE on the Mac if the backend requires auth

## Architecture

```
iPhone (ios_app)
    │  Bonjour + ws://<mac>:3006/ws?pin=…
    │  {"type":"pairing","pin":"…"}
    ▼
LlmIdeMac (MobileControlManager :3006)
    │  PIN in Keychain · single active client
    └── HTTP → server.mjs (:3456) for Chat / Explore / Auto
```

## Key files

| Area | Path |
|------|------|
| Mac server | `mac/Sources/LlmIdeMac/Services/MobileWebSocketServer.swift`, `MobileControlManager.swift` |
| Mac settings UI | `mac/Sources/LlmIdeMac/Views/Settings/MobileControlSettingsSection.swift` |
| Wire protocol | `ios_app/SharedProtocol/` |
| iOS app | `ios_app/MyApp/` |
| Loopback test | `scripts/mobile/verify-native-pairing.swift` |

## Related

- [verification.md](./verification.md)
