# Quick Start: Mobile Control for LLM IDE

> Pair your iPhone with the Mac app in one step. The Mac app itself runs the
> pairing server — **no separate Node process to launch.**

## How it works now (Phase 2)

The Mac app is a **native WebSocket server**. When you enable Mobile Control,
the Mac app listens on `127.0.0.1:3006`, advertises itself over Bonjour as
`_llmide._tcp`, and shows a pairing QR in Settings. The iPhone app discovers
the Mac, you enter (or scan) the 6-digit PIN, and you're paired.

> **The external Node `computer-agent` (`~/Desktop/auto_sys/.../services/computer-agent`)
> is NO LONGER USED.** You do not need to run `npm start`, edit its `.env`, or
> keep its terminal open. Pairing, auth, and the WebSocket listener all live
> inside the Mac app now. The previous "three terminals" flow is retired.

## Prerequisites

- The LLM IDE Mac app installed and running (it talks to the local backend at
  `http://127.0.0.1:3456` for chat — that backend must be reachable).
- macOS **Accessibility** permission granted to the Mac app (System Settings →
  Privacy & Security). Screen Recording is only needed once Phase 4/5
  screen-capture/input lands; not required to pair today.
- An iPhone on the same Wi-Fi network as the Mac (or reachable via Tailscale).
- The LLM IDE iOS app (Xcode project under `ios_app/`).

## Step 1: Enable Mobile Control in the Mac app

1. Open the LLM IDE Mac app → **Settings → Mobile Control**.
2. Turn on **Enable Mobile Control**.
3. Press **Start**.

The Mac app now:

- Starts the native WebSocket server on `127.0.0.1:3006`.
- Advertises `_llmide._tcp` over Bonjour so iPhones on the LAN can find it.
- Generates (or reuses) a 6-digit PIN stored in the macOS Keychain.
- Shows the **IP**, **port**, **PIN**, and a **pairing QR** in the Settings panel.

The QR encodes an `llmide://pair?ip=<host>&port=<port>&pin=<pin>` URL. If
Tailscale is up, the panel prefers the Tailscale address (works across
networks); otherwise it uses the local Wi-Fi address.

> **Tip:** tick **Start Mobile Control on app launch** if you want the server
> to come up automatically every time you open the Mac app.

## Step 2: Pair from the iPhone

Open the LLM IDE iOS app on your phone, then do **one** of:

- **Scan the QR** displayed in the Mac app's Settings — the iOS app fills in the
  address, port, and PIN automatically.
- **Let it discover the Mac** via Bonjour, then enter the 6-digit PIN shown in
  Settings.
- **Enter the address + PIN manually** (useful if Bonjour is blocked on the
  network).

The iOS app sends its first WebSocket frame as
`{"type":"pairing","pin":"<PIN>"}`. The Mac app replies with
`{"type":"connected","deviceName":"…"}` and the socket is now paired. From
there the iOS app runs a heartbeat and (in later phases) chat, viewing, and
input.

## That's it

You now have:

- Pairing + session over a native, in-process WebSocket (no Node helper).
- Message-based PIN auth backed by the macOS Keychain.
- Bonjour discovery and an `llmide://pair` QR for one-tap setup.
- **End-to-end LLM IDE chat**: pair iPhone → ask in iOS chat sheet → Mac proxies to `:3456` → reply streams back.
- The Mac app bridging chat requests to the LLM IDE backend at `:3456`.

> Screen streaming, remote input, and the full llm-ide command channel arrive in
> Phases 3–5. Today's surface is **pairing + heartbeat + chat plumbing**.

## Verify it works

Run the loopback script against the running Mac app:

```bash
swift scripts/mobile/verify-native-pairing.swift
```

It reads the PIN from the Keychain (or take it as an argument), then checks:
correct PIN → `connected`, heartbeat → `heartbeat_ack`, wrong PIN →
`auth_failed`. See [verification.md](./verification.md) for the full manual
procedure (Bonjour discovery, wrong-PIN rejection, reconnect-after-kill, etc.).

## Troubleshooting

### The iPhone can't find the Mac

- Confirm both devices are on the same Wi-Fi (or that Tailscale is up on both).
- In Settings → Mobile Control, confirm the status shows **Running**.
- Check Bonjour from a terminal: `dns-sd -B _llmide._tcp local.` should list the Mac.
- Fall back to manual IP + PIN entry if the network blocks mDNS.

### Pairing fails (auth_failed)

- Make sure you're entering the PIN currently shown in the Mac app Settings,
  not a stale one. Press **Refresh** to re-read it.
- The PIN lives in Keychain under `service=com.llmide.macapp`,
  `account=mobile::pin`. Read it yourself with:
  ```bash
  security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w
  ```

### "Could not connect" / port 3006 not listening

- Ensure Mobile Control is **enabled AND started** (the toggle alone doesn't
  bind the port — press Start, or enable auto-start).
- Make sure nothing else is using `:3006`: `lsof -i :3006`.
- The server binds to `127.0.0.1` for loopback and advertises the LAN address
  for phones; remote bind is off by default.

### Chat doesn't respond after pairing

- The Mac app forwards chat to the LLM IDE backend. Confirm it's reachable:
  `curl http://127.0.0.1:3456/health` should return `{"status":"ok",...}`.
- The iOS-side chat surface is wired up in Phase 3; if you're on a Phase 2
  build, only pairing + heartbeat are exercisable end to end.

## Architecture

```
iPhone (iOS app)
    │  Bonjour (_llmide._tcp) discovery + ws://<mac>:3006/ws
    │  first frame: {"type":"pairing","pin":"<PIN>"}
    ▼
LLM IDE Mac app (native NWListener WebSocket on :3006)
    │  PIN validated against Keychain (mobile::pin)
    │  single-client: a new pairing replaces the previous one
    └──► LLM IDE backend (http://127.0.0.1:3456) for chat / KB
```

- **Auth:** message-based. The client's first text frame must be `Pairing{pin}`.
  Match → `Connected`; mismatch → `AuthFailed` then socket close.
- **Keepalive:** `Heartbeat` / `HeartbeatAck` at a 10 s cadence; the server
  drops a silent peer after the heartbeat timeout.
- **No cloud:** PIN, pairing, and Bonjour are all local-network only.

## Key files

- **Mac app pairing server** — `mac/Sources/LlmIdeMac/Services/MobileWebSocketServer.swift`,
  `MobileControlManager.swift`, `MobileBonjourAdvertiser.swift`,
  `MobileConnectionInfo.swift`, `MobilePin.swift`.
- **Shared wire protocol** — `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift`.
- **Settings UI** — `mac/Sources/LlmIdeMac/Views/Settings/MobileControlSettingsSection.swift`.
- **iOS app** — `ios_app/MyApp/` (Bonjour discovery, WebSocket client, PIN UI).
- **Loopback check** — `scripts/mobile/verify-native-pairing.swift`.

## Related documentation

- [Verification guide](./verification.md) — manual + scripted pairing checks.
- [`docs/mobile-control-complete.md`](../mobile-control-complete.md) — full system summary.
- [`docs/compact-mobile-integration.md`](../compact-mobile-integration.md) — integration plan.

---

**Status:** Phase 2 native pairing server is live in the Mac app. The Node
`computer-agent` is retired.
