# Quick Start: Mobile Control for LLM-IDE

> Pair your iPhone with the Mac app. The Mac app runs the pairing server — **no
> separate Node process.**

## What you get

The iPhone app is a **remote control and a viewer** for your Mac: structured JSON over WebSocket, not a pixel
screen mirror. The Mac does the work; the phone sends a request and draws the answer. The app has three
tabs: **Chat**, **Project** (a segmented control with **Explorer**, **Auto Tasks** and **Loop**) and
**Settings**.

| Capability (wire name) | What the phone does | Mac switch (Settings → Mobile Control → Phone access) |
|---|---|---|
| Chat (`chat`) | Ask LLM-IDE questions; the answer streams from the Mac's own chat engine. The Mac's chat session is the history. | none (the phone's chat is read-only, never edits) |
| Explorer (`explorer`) | List, load and chat with Mac Explorer sessions; attach files and `@file` or `/skill` references. | **Let phone Explorer chat edit files and run commands** (off); edits ask first, a Mac set to Bypass is treated as Ask |
| Auto Tasks (`auto_tasks`) | See state, history, logs and each task's settings and templates (read-only); **Run** a task that is already enabled on the Mac; Stop. | **Run Auto Tasks** (off); implementing issues and pushing branches also need your confirmation on the Mac |
| Loop (`loop`) | See the active project's Loop, start it or one stage, watch the log, read finished runs. | **Start Loop runs** (off) |
| Doc Gen and llm-doc (`generation`, `llm_doc`) | Run Doc Gen and browse `llm-doc/`. | **Run document generation** (off) |
| Files (`files`) | Read-only file viewer; secrets, keys and `.git` are never shown. | **Browse and read project files** (on) |
| Issues (`issues`, `issue_comment`) | List and read issues from your GitHub/GitLab sign-in; post a comment. | **See issues** (on), **Comment on issues** (off) |
| Source Control (`source_control`) | Branch, changes, diffs and log; nothing is committed, pushed or discarded. | **See Source Control** (on) |
| Self-Heal (`self_heal`, `self_heal_apply`) | See incidents and diffs; ignore or retry. Apply and discard need your confirmation on the Mac and Self-Heal switched on there. | **Apply or discard Self-Heal fixes** (off) |
| Tool approvals (`tool_approvals`) | Answer a running chat's permission prompt: allow once or deny. Never "always allow" and never Bypass. | **Approve or deny tool and edit requests** (off) |
| Projects, Usage, Activity (`projects`, `usage`, `activity`) | Switch project (refused while work runs), see model limits, read the activity feed. | **Switch projects** (on) |

**What stays on the Mac:** turning Auto Tasks on or off, editing their settings and prompt templates (the
phone gets a `desktop_only` refusal), "always allow" rules, Bypass mode, deleting chats unless the Explorer
switch is on, Phone access itself, and every approval dialog. Every request is checked on the Mac against one
tier table before any feature sees it; a message type the Mac does not know is refused, not ignored.

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
4. Note the **IP**, **port** (`3006` by default; see the port note below), **PIN**, or scan the **pairing QR**

Tick **Start Mobile Control on app launch** if you want the server up automatically.

## Step 2: Pair from the iPhone

Open the LLM-IDE iOS app, then either:

- **Scan the QR** from Mac Settings
- **Pick the Mac** from Bonjour discovery and enter the PIN
- **Enter IP + PIN manually** (Tailscale IP works across networks)

Wire flow:

1. iPhone → `{"type":"pairing","pin":"<PIN>","deviceId":"<uuid>","deviceName":"…"}`
2. Mac → `{"type":"connected","deviceName":"…","token":"<per-device token>","deviceId":"<uuid>"}` — the Mac
   remembers this phone (`Settings → Mobile Control → Paired devices`) and **rotates the PIN**; the phone keeps
   the token in its Keychain
3. Every later connect → `{"type":"pairing","pin":"","token":"<token>","deviceId":"<uuid>"}` — no PIN travels again
4. The status shows **Live**. Use the **Chat** tab, or the **Project** tab and its **Explorer / Auto Tasks / Loop** control

**Revoke** a phone from the Paired devices list: its token is refused from then on and, if connected, it is
told `{"type":"disconnected","code":"revoked",…}` and dropped. A phone that pairs while another is connected
displaces it with `code:"replaced"` (one active connection at a time). The PIN is **one-time**: every
successful PIN pairing rotates it, so an older iOS build that sends only a PIN still pairs but must read the
new PIN from Settings to pair again (it gets no token and never appears under Paired devices).

## Transport security (read this)

The phone link is **cleartext `ws://`** today: the PIN, the per-device token and every message cross your
Wi-Fi or Tailscale unencrypted, and the iOS app ships with App Transport Security fully open
(`NSAllowsArbitraryLoads`). Tailscale encrypts its own hop; a plain home or office LAN does not. Pair only
on a network you trust, revoke a phone you lose, and treat the token like a password. The fix (a
per-install certificate whose hash is carried in the pairing QR and pinned by the phone) is designed in
[`2026-10-31-mobile-tls-pinning-design.md`](../superpowers/plans/2026-10-31-mobile-tls-pinning-design.md) and not
built yet.

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

### Auto or Explore looks empty

- Tap **↻** on the home screen or open the sheet and refresh
- Confirm Mobile Control **Running** on the Mac
- Auto Tasks require the Mac app running with auto-code wired (same as on Mac)
- A task shows **turned off on your Mac** (`task_disabled`) when its own switch is off on the Mac: a phone run no longer overrides it. **Waiting for you to approve this on your Mac** means a dialog is open on the Mac (default button Cancel; no answer in 120 seconds counts as a denial).
- Loop is control-only from the phone: start/stop, live log, finished runs. It needs a loop already
  configured for the active project on the Mac (Loop → New Loop), and starting one from the phone
  runs it through the Mac's `loopEngineering` auto task — the same path the scheduler uses, so the
  run is journaled identically. `running` reflects the runner's process-wide guard, so a run started
  on the desktop shows on the phone too (marked "started on Mac") and can be stopped from either.

### iPhone can't find the Mac

- Confirm Mobile Control **Running** on the Mac
- Same Wi-Fi or Tailscale on both devices
- `dns-sd -B _llmide._tcp local.` — or use manual IP + PIN
- **macOS 15 (Sequoia) and later:** System Settings → Privacy & Security →
  **Local Network** must have llm-ide enabled. Sequoia gates Bonjour
  advertising behind this prompt; if it was dismissed, the Mac keeps
  reporting Mobile Control as Running while being completely invisible to the
  phone. Toggling llm-ide off and on there re-arms it.

### Pairing fails (wrong PIN)

- Use the PIN currently shown in Mac Settings (Refresh if unsure)
- Keychain: `security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w`

### Port 3006 busy

If the configured port is taken, the Mac binds the **next free port up to +9** (3006 to 3015); the pairing QR
and Bonjour advertise the port actually bound, so pairing still works. Only when **all ten fail** does Mobile
Control show an error ("ports 3006–3015 all failed to bind"); then run `lsof -i :3006` to see what holds them,
or set a different port in Settings → Mobile Control and press **Start** again. A manual IP entry must use the
port shown in Settings, not always 3006.

### Chat doesn't respond (Live but no reply)

- `curl http://127.0.0.1:3456/health` must succeed
- Mac **Settings → Backend** → Running
- Log in to LLM-IDE on the Mac if the backend requires auth

## Architecture

```text
iPhone (ios_app)
    │  Bonjour + ws://<mac>:<3006..3015>/ws   (cleartext today, see Transport security)
    │  {"type":"pairing","pin":"…","deviceId":"…"} once, then {"token":"…"}
    ▼
LlmIdeMac (MobileControlManager)
    │  PIN in Keychain (rotates after each pairing) · paired-device registry (token hashes) · single active client
    │  handleInbound → ONE tier table (PhoneTierTable) → per-feature bridge (each re-checks its own switch)
    ├── Chat and Explorer chat → chatHost (MobileChatHosting) → Chat's own engines and session store
    │       (only those engines reach the local server on :3456)
    ├── Auto Tasks / Loop → AutoCodeUpdateService via MobileFeatureBridge
    └── Files, Issues, Source Control, Self-Heal, Projects, Usage → their own bridges
```

## Key files

| Area | Path |
|------|------|
| Mac server | `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileWebSocketServer.swift`, `MobileControlManager.swift`, tier table `PhoneTierTable.swift`, desktop confirmations `PhoneDesktopApprovalGate.swift` |
| Mac settings UI | `mac/Sources/LlmIdeMac/Features/MobileControl/Views/MobileControlSettingsSection.swift` |
| Wire protocol | `ios_app/SharedProtocol/` |
| iOS app | `ios_app/MyApp/` |
| Loopback test | `scripts/mobile/verify-native-pairing.swift` |

## Related

- [verification.md](./verification.md)
