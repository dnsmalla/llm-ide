# Mobile Control System Verification Guide

> Verification for the **native Mac pairing server** (Phase 2). The Mac app
> itself runs the WebSocket server on `:3006` and advertises `_llmide._tcp`;
> the external Node `computer-agent` is no longer used.

## Quick verification (2 minutes)

### 1. Confirm Mobile Control is running in the Mac app

In the Mac app: **Settings → Mobile Control** → toggle **Enable**, press
**Start**. The panel should show status **Running**, the current PIN, the
LAN/Tailscale IP, port `3006`, and a pairing QR.

Loopback from the Mac itself:

```bash
# Native pairing server should be listening on loopback.
lsof -i :3006            # expect a process bound to 127.0.0.1:3006 or *:3006
```

### 2. Run the loopback pairing script

```bash
swift scripts/mobile/verify-native-pairing.swift
```

The script reads the PIN from the Keychain (or take it as an argument:
`swift scripts/mobile/verify-native-pairing.swift 123456`) and asserts:

| Check | Client sends                              | Server must reply                              |
|-------|-------------------------------------------|------------------------------------------------|
| 1     | `{"type":"pairing","pin":"<correct>"}`    | `{"type":"connected","deviceName":"…"}`        |
| 2     | `{"type":"heartbeat"}` (on the paired socket) | `{"type":"heartbeat_ack","ts":…}`          |
| 3     | `{"type":"pairing","pin":"000000"}` (fresh socket) | `{"type":"auth_failed",…}` then close |

Exit `0` = all three passed; exit `1` = at least one failed. This single
command covers correct-PIN pairing, wrong-PIN rejection, and heartbeat ack.

### 3. Confirm Bonjour advertising

```bash
dns-sd -B _llmide._tcp local.
# Expected: the Mac appears as an _llmide._tcp service on your network.
```

## Manual pairing procedure

Run these against the live Mac app (Mobile Control enabled + Started), ideally
from a real iPhone. They cover the cases the script can't reach from loopback
(discovery, end-to-end reconnect).

### ✅ Bonjour discovery from the iPhone

1. Mac app: Mobile Control **Running** (Settings shows IP / port / PIN / QR).
2. Open the iOS app on the same Wi-Fi.
3. The Mac should appear automatically via `_llmide._tcp`.

- [ ] iOS app discovers the Mac in under ~3 s on the same LAN.
- [ ] Tapping it opens the PIN prompt.
- [ ] If Tailscale is up, the Mac is also reachable over the Tailscale address.

### ✅ Correct PIN pairs

1. Read the PIN from Settings (or `security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w`).
2. Enter it in the iOS app.

- [ ] Server replies `{"type":"connected","deviceName":"…"}`.
- [ ] iOS app transitions to the paired/remote surface.
- [ ] Mac app logs "Client paired".
- [ ] Scanning the QR (`llmide://pair?ip=…&port=…&pin=…`) auto-fills and pairs too.

### ✅ Wrong PIN is rejected

1. Enter a wrong PIN (e.g. `000000`) in the iOS app, or run check [3] of the
   loopback script.

- [ ] Server replies `{"type":"auth_failed","message":"Wrong PIN"}`.
- [ ] Server then closes the socket.
- [ ] Mac app logs "Wrong PIN — rejecting".

### ✅ Heartbeat keeps the session alive

1. Pair successfully, then leave the socket idle.
2. The iOS app sends periodic `{"type":"heartbeat"}` frames.

- [ ] Each heartbeat is answered with `{"type":"heartbeat_ack","ts":…}`.
- [ ] Connection stays up across multiple heartbeat cycles (10 s cadence).
- [ ] If the iPhone stops sending heartbeats past the timeout, the Mac drops
      the session and frees the single-client slot.

### ✅ Reconnect after kill / replace

1. Pair from device A.
2. Force-quit the iOS app (or kill the network).
3. Re-open it and pair again.

- [ ] Re-pairing succeeds and the Mac app shows a new paired session.
- [ ] Pairing a second device **replaces** the first (single-client policy):
      the Mac cancels the prior connection and accepts the new one.

## LLM IDE backend (chat bridge)

The Mac app forwards chat to the local backend at `:3456`; pairing doesn't need
it, but chat does.

```bash
# 1. Backend health
curl http://127.0.0.1:3456/health
# Expected: {"status":"ok","version":"…","apiVersion":…,...}

# 2. Auth + KB agent (used by chat in Phase 3)
curl -X POST http://127.0.0.1:3456/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"…"}'
```

- [ ] Backend responds to `/health`.
- [ ] Login returns a JWT.
- [ ] After pairing, a chat request from the iOS app is bridged to the backend
      and a reply comes back (full chat surface lands in Phase 3).

## Security verification

### Local-only communication

```bash
# Loopback pairing server (and LAN-advertised address for phones).
lsof -i :3006 -P
# Remote bind is OFF unless explicitly enabled; default is 127.0.0.1 / LAN.

# Backend stays loopback.
lsof -i :3456 -P
# Expected: 127.0.0.1:3456 (NOT 0.0.0.0:3456).
```

- [ ] Pairing server does not accept connections from outside the LAN/Tailscale.
- [ ] Backend binds to `127.0.0.1` only.
- [ ] No cloud API calls for pairing/Bonjour (only the backend's own LLM calls).

### PIN storage

```bash
# PIN is stored as a Keychain generic password, not a plaintext file.
security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w
```

- [ ] PIN reads back from Keychain under `service=com.llmide.macapp`,
      `account=mobile::pin`.
- [ ] No `~/.aicontrol.json` or `.env` PIN file is involved anymore.
- [ ] Regenerating the PIN (Mac app → Regenerate, if exposed) overwrites the
      Keychain item; old PIN no longer pairs.

### Permissions

- **macOS Accessibility** — granted to the LLM IDE Mac app (required for Phase 5
  input injection; enable now to avoid re-pairing later).
- **macOS Screen Recording** — required for Phase 4 screen capture, not for
  pairing.
- **iOS Local Network** — granted to the iOS app (needed for Bonjour discovery).

- [ ] Accessibility granted to the Mac app.
- [ ] iOS Local Network permission granted.
- [ ] Permissions are re-requested on first use after a reinstall.

## Troubleshooting

### Port 3006 not listening

- Ensure Mobile Control is **enabled AND Started** (the toggle alone doesn't
  bind). Check **Start Mobile Control on app launch** for persistence.
- `lsof -i :3006` — if another process holds it, quit it or it won't bind.

### Bonjour doesn't surface the Mac

- `dns-sd -B _llmide._tcp local.` from a terminal.
- Same Wi-Fi on both devices? mDNS is often blocked on guest/corporate Wi-Fi;
  fall back to manual IP + PIN, or use Tailscale.
- Restart Mobile Control (Stop → Start) to re-publish the service.

### Pairing keeps failing

- Confirm the PIN matches the current Keychain value (`security … -w`).
- Remember the server is **single-client**: if another device (or a previous
  instance of the iOS app) is paired, pair again to replace it.

### Backend (chat) not responding

- `curl http://127.0.0.1:3456/health`.
- Restart the backend: `cd extension && node server.mjs`.
- Chat end-to-end is wired up in Phase 3; on a Phase 2 build only pairing +
  heartbeat are exercisable.

## Continuous verification

### Weekly

- [ ] Run `swift scripts/mobile/verify-native-pairing.swift`.
- [ ] Pair from the iPhone and confirm Bonjour discovery.
- [ ] Confirm the PIN still reads from Keychain.

### Monthly

- [ ] Review macOS Accessibility / Screen Recording permissions.
- [ ] Regenerate the PIN and confirm the old one no longer pairs.
- [ ] Check the Mac app + SharedProtocol tests still pass:
      `cd mac && swift test` / `cd ios_app/SharedProtocol && swift test`.

---

**Loopback script:** `swift scripts/mobile/verify-native-pairing.swift`
covers correct-PIN pairing, wrong-PIN rejection, and heartbeat ack in one run.
Use the manual sections above for discovery and reconnect coverage.
