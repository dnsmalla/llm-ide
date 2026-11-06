# Notes for App Review

Paste the body of this file into **App Store Connect → your build → App Review
Information → Notes**. It is written for the Apple reviewer, not for us; keep
it short and keep it current when the app changes.

---

## What this app is

LLM-IDE is a companion for the LLM-IDE desktop app. The iPhone app connects to *the user's own computer* over their local network and lets them chat with the coding agent
running there, answer its questions, approve or deny its tool requests, and
read their chat history and usage.

There is no account, no sign-up, and no server operated by us. The phone talks
only to the user's own computer and, if the user turns them on, to their own
sync storage and their own Box / GitLab accounts.

## Optional: sync with the desktop off

Users can let the app read an encrypted copy of their own desktop data (recent chats, meeting notes, plans, usage)
when the desktop is switched off, and queue a chat prompt that the desktop answers later. The copy lives in storage
**the user owns**: a MEGA account (a dedicated one is recommended), their own HTTPS server, or a Box account. We
operate no server and have no access. Everything is encrypted on the desktop before upload with standard algorithms
through Apple's CryptoKit; the storage holds only ciphertext. Setup needs the user's desktop (it shows a QR code and a
6-digit code to compare). The MEGA password is used once to sign in and is not stored.

## How to review

**Use the demo first.** On the first screen, tap **Explore demo**. It opens a
fully local sample workspace (chat, one approval, history and usage) with no
desktop, account or network connection. A banner labels it as demo data. Exit it
from Settings → Reviewer demo → Exit demo.

To review the live product, the app needs the LLM-IDE desktop app to pair with:
on the desktop, Settings → Phone and browser → Host API pairing shows a pairing QR code, which the
iPhone scans (**Scan QR Code** on the first screen). The desktop app is not
distributed through the Mac App Store; the demo exists so the review does not
depend on installing it.

## Permissions, and why each is requested

| Permission | Why |
|---|---|
| Local Network | Connect to the desktop the user paired with, on their Wi‑Fi. |
| Camera | Scan the pairing and sync QR codes shown on the desktop. |
| Microphone + Speech Recognition | Dictating a chat message instead of typing. Optional; transcription is on-device. |

## App Transport Security

`NSAllowsArbitraryLoads` is **false**. Every connection is TLS:

- The desktop link is `wss://` to the address in the pairing QR. The desktop
  uses a self-signed P-256 certificate whose fingerprint is carried in that QR;
  the app pins it with a custom server-trust check and refuses any other
  certificate. Pairing exchanges a one-time PIN for a per-device token held in
  the Keychain (this device only).
- Sync and Box / GitLab reads are `https://` only; Box and GitLab have explicit
  `NSExceptionDomains` entries that keep TLS 1.2 or later and forbid plain HTTP.

The only exemption is `NSAllowsLocalNetworking`, which covers a development
build talking to a desktop on the same machine (`ws://127.0.0.1`). It never
relaxes ATS for internet hosts.

## Privacy

No data is collected. Chat messages travel only between the phone and the
user's own computer or their own sync storage; we operate no server and
receive nothing. The pairing token is stored in the Keychain; the desktop's
address is stored in `UserDefaults`. This matches the bundled privacy manifest
(`PrivacyInfo.xcprivacy`), which declares no tracking and no collected data
types.

## Box and GitLab reading

Settings → Box and GitLab lets the user sign in to their own Box and gitlab.com accounts with OAuth
(ASWebAuthenticationSession), with read-only scopes, to read their documents and code. Tokens are kept in the Keychain
on this device only. Files are shown as text or in PDFKit; nothing is executed or stored. Reviewers need their own
Box/GitLab account and app IDs to try it; the rest of the app works without it.
