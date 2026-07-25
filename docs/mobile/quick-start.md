# Quick Start: Mobile Control for LLM-IDE

> Pair your iPhone with the Mac app. The Mac app runs the pairing server — **no
> separate Node process.**

## Companion mode (current)

The iPhone app is a **companion**, not a remote desktop:

- **Chat** — ask LLM-IDE questions (Mac proxies to `:3456`)
- **Explore** — Mac explorer-chat sessions
- **Auto** — Mac auto-task controls

Screen mirroring and remote input were **cancelled**. **Screen Recording is not
required** on Mac or iPhone for pairing or chat.

> Install the iOS app from **`ios_app/MyApp.xcodeproj`** in this repo. An older
> build that still shows “waiting for screen…” is obsolete — delete it from your
> phone and reinstall from Xcode.

## Prerequisites

- LLM-IDE Mac app running with **Mobile Control → Start**
- LLM-IDE backend reachable at `http://127.0.0.1:3456` (Mac **Settings → Backend**
  or `cd extension && node server.mjs`)
- iPhone on the same Wi-Fi as the Mac (or Tailscale on both)
- iOS app built from `ios_app/` (Xcode → run on device)

**Not required for iPhone pairing:** macOS Accessibility, macOS Screen Recording.

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
3. iPhone toolbar shows **Live** — tap **Chat**, **Explore**, or **Auto**

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

### iPhone shows “waiting for screen” or Screen Recording

You have an **old iOS build** (remote-desktop UI). Delete the app, reinstall
from `ios_app/MyApp.xcodeproj`, pair again. With the current app you should see
**Chat / Explore / Auto** in the toolbar when **Live**.

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
- [docs/archive/mobile-control-complete.md](../archive/mobile-control-complete.md) — superseded (Node agent era)
