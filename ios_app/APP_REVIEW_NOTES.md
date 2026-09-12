# Notes for App Review

Paste the body of this file into **App Store Connect → your build → App Review
Information → Notes**. It is written for the Apple reviewer, not for us; keep
it short and keep it current when the app changes.

---

## What this app is

LLM-IDE is a companion for a Mac app of the same name. The iPhone app is a
remote control: it connects to *the user's own Mac* over their local network
(or their private Tailscale network) and lets them chat with the coding agent
running there, browse sessions, and start or stop scheduled tasks.

There is no account, no sign-up, and no server operated by us. The phone talks
only to the user's Mac.

## How to review without a Mac — demo mode

No pairing is required to evaluate the app.

1. Launch the app.
2. On the first screen, tap **"Explore the demo"** (directly under the
   "Scan QR Code" button).

That opens the full interface backed by sample data: Mac status, AI chat with
streamed replies, explorer sessions, Auto Tasks (toggles work), and Loop
(Start/Stop runs a scripted job with a live log). Demo mode runs entirely
offline — it opens no network connection and stores nothing. Replies in demo
mode are canned and are labelled "Demo reply."

To leave demo mode, use the **⋯** menu → **Disconnect**.

## Permissions, and why each is requested

| Permission | Why |
|---|---|
| Local Network | Discover the user's Mac via Bonjour (`_llmide._tcp`). Not used in demo mode. |
| Camera | Scan the pairing QR code shown on the Mac. Optional — the user can type the address and PIN instead. |
| Microphone + Speech Recognition | Dictating a chat message instead of typing. Optional; transcription is on-device. |

## App Transport Security exception

`NSAllowsArbitraryLoads` is set, and we want to be explicit about why.

The app connects to one destination only: a WebSocket on the user's own Mac,
at an address the user supplies by scanning a QR code or typing it in. That
Mac is on their LAN or on their private Tailscale network.

`NSAllowsLocalNetworking` would be the narrower key, but it does not cover
this case: when Tailscale is running, the Mac advertises its Tailscale address,
which falls in the CGNAT range `100.64.0.0/10`. That range is not RFC 1918,
link-local, or `.local`, so `NSAllowsLocalNetworking` does not exempt it and
the primary documented pairing path would break.

The exception is narrow in practice:

- `URLSession` is used in exactly one file (`ConnectionService.swift`), for
  exactly one connection, to an address the user entered.
- The app contacts no other host — no analytics, no ad networks, no
  third-party SDKs of any kind.
- The connection is authenticated: pairing exchanges a one-time PIN for a
  per-device token, the PIN rotates immediately, and the token is held in the
  Keychain.

We intend to remove this exception by moving the socket to Network.framework,
which is not governed by ATS.

## Privacy

No data is collected. Chat messages, sessions and task state travel only
between the phone and the user's own Mac; we operate no server and receive
nothing. The pairing token is stored in the Keychain; the Mac's address is
stored in `UserDefaults`. This matches the bundled privacy manifest
(`PrivacyInfo.xcprivacy`), which declares no tracking and no collected data
types.
