# Quick Start: the LLM-IDE iPhone app

> Pair your iPhone with the LLM-IDE desktop over **Host API v1** (TLS, certificate pinned from a QR), and
> optionally enroll **offline sync** so the phone can read your data while the desktop is off.

## What you get

The iPhone app is a native chat client and viewer for your desktop. It has three tabs:

| Tab | What it does | Needs |
|---|---|---|
| **Chat** | Ask the desktop's agent; replies stream back. Answer its mid-turn questions; Allow once or Deny a tool or edit request (never "always allow"). Attach text files (PDF, `.md`, `.txt`, text extracted on the phone) or dictate. | A live Host API v1 connection (`chat`, `approvals`, `tool_approvals`) |
| **History** | The desktop's chats, newest first, read-only; usage meters. With offline sync: the last snapshot's chats, meetings and plans, and prompts queued for the desktop. | `read` on the v1 connection, or offline sync |
| **Settings** | The paired desktop (address, port, what it serves), Reconnect / Close / Forget, offline sync, Box and GitLab reads, Usage & limits, Help. | |

Settings → Box and GitLab also lets the phone read your own Box documents and gitlab.com code directly, with
read-only OAuth scopes; that path never touches the desktop.

> Install from **`ios_app/MyApp.xcodeproj`**. Rebuild after pulling.

## Prerequisites

- The LLM-IDE desktop app running, with Host API TLS on: start it with `LLMIDE_HOST_API_TLS=1` (off by
  default until the product-stage decision, UN-108).
- iPhone on the same Wi-Fi as the desktop, or Tailscale on both.
- iOS app built from `ios_app/` (Xcode → run on device).
- iPhone permissions: **Camera** (scan the QR codes), **Local Network** (reach the desktop on your Wi-Fi; iOS
  asks the first time), and optionally Microphone + Speech Recognition for dictation.

## Pair with the desktop

1. On the desktop: **Settings → Mobile Control → Pair a phone or web client → Show pairing PIN**. The card
   shows a one-use PIN (10 minutes), the endpoint, the certificate fingerprint and a QR code.
2. On the iPhone: **Scan QR Code** on the first screen. The QR is
   `llmide://pair?ip=…&pin=…&h1port=…&h1fp=…&api=1`; `ip` is the desktop's best address (Tailscale first,
   then LAN).
3. The phone stores the address, the v1 port and the fingerprint (`h1fp`, Keychain), dials
   `wss://<ip>:<h1port>/host-api/v1`, sends `host.hello`, then `host.auth.pair` with the PIN. The desktop
   answers with a per-device token, which the phone keeps in its Keychain (this device only); the PIN is
   dropped.
4. The status shows **Live**. Every later connect presents the token (`host.auth.token`); no PIN travels.

**Revoke** a phone from the same card (Paired devices → Revoke…). Its token is refused from then on; the
phone gets `auth_failed` and returns to the pairing screen.

**Device lifetime.** The token lasts at most **90 days from pairing**, even if the phone is used every day
(exactly 90 days is still valid). On expiry the host deletes the token and answers `auth_failed`; the phone
clears its saved credentials and offers "Pair again" with a new QR or PIN. The phone also checks its locally
recorded pairing time, so an expired token does not dial first. This is separate from the 30-day idle rule.

**Typed PIN.** "Enter a PIN manually" on the pairing screen re-pairs a desktop this iPhone already scanned:
it keeps that host's stored fingerprint. With no stored fingerprint for that address, the phone asks for the
QR, because it pins only from a QR scan.

## Transport security

- The phone accepts `wss://` only, pinned: the desktop's self-signed P-256 certificate must match the
  fingerprint from the QR (`sha256:` plus base64url of the SHA-256 of the SubjectPublicKeyInfo). System
  trust is never consulted. A different certificate fails with `pin_mismatch` ("security identity changed —
  pair again"); credentials are kept and only a new QR scan replaces the pin.
- `ws://` is accepted for loopback only (the DEBUG dev listener below).
- App Transport Security is on (`NSAllowsArbitraryLoads` false). The only exemption is
  `NSAllowsLocalNetworking`, for the loopback dev listener. Sync and Box / GitLab reads are `https://` only.

## Offline sync (desktop off)

1. On the desktop: **Settings → Mobile Control → Phone and web sync**: choose the storage (MEGA with a
   dedicated account, your own HTTPS server, or Box), test it, turn sync on, then **Add a phone or browser**.
   It shows an enrollment QR and a 6-digit code.
2. On the iPhone: scan it, from the first screen or **Settings → Sync → Scan a sync code**.
3. Compare the code the phone shows with the desktop's; press **Codes match** on the desktop only if they are
   the same. For MEGA or Box, sign in on the phone to the account the desktop syncs to.
4. The desktop's encrypted snapshot appears in **History**. A prompt you queue there is answered the next time
   the desktop runs.

Remove sync from **Settings → Sync → Remove sync from this iPhone**, and revoke the phone on the desktop
too. Design: [ADR 0020](../decisions/0020-box-encrypted-sync.md).

## Developer: the Simulator against a dev listener

Start a DEBUG desktop host with `LLMIDE_HOST_API_DEV=1` (plaintext `ws://127.0.0.1:3016`, this computer
only) and set `LLMIDE_HOST_API_URL=ws://127.0.0.1:3016/host-api/v1` in the Xcode scheme (Run →
Environment). A DEBUG build dials that URL instead of the paired endpoint; type the PIN from the desktop's
card under "Enter a PIN manually".

## Troubleshooting

### "Scan the pairing QR code…"

The phone has no certificate pin for this address. Scan the desktop's pairing QR (a typed PIN cannot create a
pin).

### "Couldn't reach the desktop. Retrying…"

- LLM-IDE is running on the desktop with `LLMIDE_HOST_API_TLS=1`.
- Same Wi-Fi or Tailscale on both devices; iOS Settings → Privacy & Security → Local Network has LLM-IDE on.
- The v1 listener binds the first free port in 3016–3025; if it moved, scan the QR again.

### "This computer's security identity changed — pair again."

The desktop has a new certificate. Scan its pairing QR again.

### "Pairing expired or removed"

The token reached its 90-day limit, or the desktop revoked this phone / wiped its device registry. Pair again
with the desktop's QR or a new PIN; the old token cannot be renewed.

### "The desktop hasn't updated sync for over a week"

The offline-sync manifest is past `validUntil` + 7 days, so its keys may have rotated and the snapshot is not
trusted. Open the desktop app with sync on so it publishes a fresh manifest, then pull to refresh on the phone.

### Live, but no History tab

The desktop did not grant `read` to this device: start it with `LLMIDE_HOST_API_READ=1` (off by default),
then pair again (a device paired before keeps its old grant).

## Key files

| Area | Path |
|------|------|
| v1 client, pinning, QR parser | `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiV1Client.swift`, `HostApiPinning.swift`, `PairingInfo.swift` |
| Connection and pairing store | `ios_app/MyApp/Services/ConnectionService.swift`, `ConnectionStore.swift` |
| Chat | `ios_app/MyApp/Services/LlmIdeChatStore.swift`, `ios_app/MyApp/Views/Control/LlmIdeControlView.swift` |
| Offline sync, direct reads | `ios_app/MyApp/Services/SyncStore.swift`, `SourceReadStore.swift` |
| Desktop pairing card | `ui/screens/settings/sections/HostApiPairing.tsx` |
| Wire contract | `schema/host-api/v1/` |

## Related

- [verification.md](./verification.md)
