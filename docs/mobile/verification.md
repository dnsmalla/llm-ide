# Mobile Control System Verification Guide

> Verification for the **native Mac pairing server**. The Mac app runs WebSocket
> on `:3006` and advertises `_llmide._tcp`. The iPhone is a **companion**
> (Chat / Explore / Auto) — not a remote desktop. Screen Recording is **not**
> required for pairing or chat.

## Quick verification (2 minutes)

### 1. Confirm Mobile Control is running in the Mac app

**Settings → Mobile Control** → Enable → **Start**. Expect **Running**, PIN,
LAN/Tailscale IP, port `3006`, and pairing QR.

```bash
lsof -i :3006    # expect LlmIdeMac
```

### 2. Run the loopback pairing script

```bash
swift scripts/mobile/verify-native-pairing.swift
```

| Check | Client sends | Server reply |
|-------|--------------|--------------|
| 1 | `{"type":"pairing","pin":"<correct>"}` | `{"type":"connected","deviceName":"…"}` |
| 2 | `{"type":"heartbeat"}` | `{"type":"heartbeat_ack","ts":…}` |
| 3 | wrong PIN on fresh socket | `{"type":"auth_failed",…}` then close |

Exit `0` = pass.

### 3. Confirm Bonjour

```bash
dns-sd -B _llmide._tcp local.
```

## Manual pairing (iPhone)

### Bonjour discovery

- [ ] Mac appears in iOS app within ~3 s on same LAN
- [ ] PIN prompt after tap
- [ ] Tailscale IP works when both sides are on Tailscale

### Correct PIN pairs

- [ ] Mac log: `Client paired`
- [ ] iOS toolbar: **Live** (not “waiting for screen”)
- [ ] iOS home shows **Chat / Explore / Auto** toolbar (companion UI)
- [ ] QR scan auto-fills and pairs

> If iOS shows “waiting for screen…” or Screen Recording, delete the app and
> reinstall from `ios_app/MyApp.xcodeproj` — that is an obsolete remote-desktop build.

### Wrong PIN rejected

- [ ] `auth_failed` then socket close
- [ ] Mac log: `Wrong PIN — rejecting`

### Heartbeat

- [ ] `heartbeat_ack` every ~10 s while paired
- [ ] Session drops after prolonged silence (timeout)

### Reconnect / replace

- [ ] Re-pair after force-quit succeeds
- [ ] Second device **replaces** first (single-client policy)

## Backend (Chat / Explore / Auto)

Pairing does not need `:3456`; chat features do.

```bash
curl http://127.0.0.1:3456/health
```

- [ ] `/health` returns ok
- [ ] Mac **Settings → Backend** shows Running (or adopt external server)
- [ ] iOS **Chat** sends a question and receives a streamed reply

## Security

```bash
lsof -i :3006 -P
lsof -i :3456 -P   # expect 127.0.0.1:3456
security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w
```

- [ ] PIN in Keychain (`com.llmide.macapp` / `mobile::pin`), not a plaintext file
- [ ] Backend on loopback only
- [ ] No cloud dependency for pairing

## Permissions (companion mode)

| Permission | Required for iPhone? | Notes |
|------------|---------------------|-------|
| iOS Local Network | Yes (Bonjour) | Prompt on first discovery |
| macOS Screen Recording | **No** | Mac meeting capture only; optional |
| macOS Accessibility | **No** | Mac caption capture only; optional |

- [ ] iOS Local Network granted (if using Bonjour)

## Troubleshooting

### Port 3006 not listening

Enable **and** Start Mobile Control; check `lsof -i :3006`.

### Chat not responding

- `curl http://127.0.0.1:3456/health`
- Restart backend: `cd extension && node server.mjs`
- Confirm logged in on Mac if backend requires auth

## Continuous verification

**Weekly:** loopback script + iPhone pair + Chat smoke test.

**Monthly:** PIN still in Keychain; `cd ios_app/SharedProtocol && swift test`; `cd mac && swift build`.

---

**Loopback:** `swift scripts/mobile/verify-native-pairing.swift`
