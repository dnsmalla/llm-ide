# Mobile Control System Verification Guide

> Verification for the **native Mac pairing server**. The Mac app runs WebSocket
> on `:3006` (or the next free port up to `3015`) and advertises `_llmide._tcp`. The iPhone is a remote control
> and viewer (tabs **Chat**, **Project** with Explorer / Auto Tasks / Loop, **Settings**), not a remote desktop.
> Screen Recording is **not** required for pairing or chat. The link is cleartext `ws://` today; see
> [quick-start.md](./quick-start.md) "Transport security". This list is written, **no recorded run yet**.

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

Exit `0` = pass. The script pairs PIN-only (no `deviceId`), so no token is issued — but the PIN is one-time
and **rotates after check 1**; the script reads the current PIN from the Keychain on each run (or pass the
new PIN as the argument), so simply run it again.

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

- [ ] Mac log: `Client paired (device xxxxxxxx…)` followed by `Pairing PIN rotated`
- [ ] Mac Settings: the PIN row and QR show a **new** PIN; the phone appears under **Paired devices** as “Connected now”
- [ ] iOS shows **Live** and the three tabs **Chat / Project / Settings** (Project has Explorer / Auto Tasks / Loop)
- [ ] QR scan auto-fills and pairs

### Token reconnect, revoke, replace

- [ ] Kill the iOS app and relaunch: it reconnects **without** a PIN prompt (token auth); Mac log `Client paired (device …)` with no PIN rotation
- [ ] Mac Settings → Paired devices → **Revoke**: the phone shows the revoke message and lands on the pairing screen; its next connect attempt is refused (`auth_failed`, not retryable) until it pairs with the current PIN
- [ ] Pair a second phone while the first is connected: the first shows “Another device paired with this Mac” and does not auto-reconnect; Mac log `Replacing previously paired client`
- [ ] Stop Mobile Control on the Mac: the phone shows “Mobile Control was stopped on the Mac” and retries with backoff

### Wrong PIN rejected

- [ ] `auth_failed` then socket close
- [ ] Mac log: `Wrong PIN — rejecting`

### Heartbeat

- [ ] The phone sends `heartbeat` every ~10 s and the Mac answers `heartbeat_ack`
- [ ] The Mac drops the session after about 25 s without a heartbeat

### Port fallback

- [ ] With something already on `:3006`, Mobile Control still starts on the next free port; the QR and Bonjour use it and the phone pairs
- [ ] With ports 3006 to 3015 all taken, the Mac shows "ports 3006–3015 all failed to bind"

## Backend (Chat / Explorer chat)

Pairing does not need `:3456`; chat features do.

```bash
curl http://127.0.0.1:3456/health
```

- [ ] `/health` returns ok
- [ ] Mac **Settings → Backend** shows Running (or adopt external server)
- [ ] iOS **Chat** sends a question and receives a streamed reply
- [ ] Switch to the Mac's chat panel: the question and answer are in the same session (the Mac's session is the history)

## Phone access switches, tiers and desktop confirmations

Run each row once on a paired phone and record the result. Defaults are shown; a switch that is off must give
the "Turned off on the Mac" message and must not advertise the screen.

| # | Row | Expect |
|---|---|---|
| F1 | Every Phone access switch at its default (Settings → Mobile Control → Phone access) | on: Switch projects, Browse files, Source Control, Issues; everything else off |
| F2 | Files with the switch off, then on | denied message, then a listing; no `.git`, secret or key file shown |
| F3 | Issues, Source Control, Usage, Activity | read OK; Comment on issues off by default and refused until enabled |
| F4 | **Auto Task run with the task disabled on the Mac** (turn **Auto Task control** on, leave Implement issues off, tap Run) | phone shows "turned off on your Mac" (`task_disabled`); nothing starts |
| F5 | Run a task that is enabled (Review code) | starts without a dialog |
| F6 | **Implement issues enabled on the Mac, Run from the phone** | phone shows "Waiting for you to approve this on your Mac"; a Mac dialog names the task, project and issue numbers, default button Cancel; Cancel gives "You cancelled this on your Mac"; no answer for 120 s denies; Allow once starts it |
| F7 | Review & merge from the phone | same dialog naming the branches and target; nothing is pushed without Allow once |
| F8 | Spam three Run requests quickly | one dialog at a time; a fourth within 5 minutes gives "asked too often" |
| F9 | **Template edit attempt** (in the phone's Auto Task setup, edit and save a template, change a task's folder or skill, flip a task's toggle) | each fails with "only available on your Mac" (`desktop_only`); the Mac's template and settings are unchanged; the phone still lists templates and settings |
| F10 | **Tier refusals:** a message type the Mac does not know (a newer phone), and a desktop-only type | answered with a refusal (`unknown_type`, `desktop_only`) in the phone's error text, never a silent drop; the Mac log shows "Tier gate refused" |
| F11 | Explorer chat edit switch on while the Mac chip is **Bypass** | the phone turn still asks before edits and shell commands (never Bypass) |
| F12 | Tool approval relay (switch on) | the phone shows the tool, summary and the same file/diff/command the Mac card shows; only Allow once and Deny exist; a truncated change cannot be allowed from the phone |
| F13 | Self-Heal apply/discard from the phone | Mac dialog naming incident, branch and checkout; refused while Self-Heal is off on the Mac |
| F14 | Start a Loop from the phone, then flip the switch off or change project before it starts | refused with a reason; nothing starts |
| F15 | Project switch from the phone while a loop, task or chat is running | refused with a reason |
| F16 | Loop start, stop, single stage; Doc Gen run | per switch; results appear on the phone |
| F17 | Lock the phone, wait, unlock; kill and relaunch the app; revoke then reconnect | reconnects by token; revoked phone gets `auth_failed` |
| F18 | 5,000-message chat, 100,000-file project | not yet run; record the result |

**S4 exit checklist row:** the phone chat idle-timeout (which sends Cancel) and the sticky approval-pause window in
`LlmIdeChatStore.swift` are removed when the core's replay/detach (`chat.attach`) replaces them; until then they are
unchanged and documented as temporary.

## Security

```bash
lsof -i :3006 -P
lsof -i :3456 -P   # expect 127.0.0.1:3456
security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w
```

- [ ] PIN in Keychain (`com.llmide.macapp` / `mobile::pin`), not a plaintext file
- [ ] Backend on loopback only
- [ ] No cloud dependency for pairing
- [ ] **Not encrypted:** the link is cleartext `ws://` (ATS fully open); see quick-start "Transport security" and the TLS design. Do not claim otherwise

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
