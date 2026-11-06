# iPhone app verification guide

> Manual checks for the iPhone app against the LLM-IDE desktop: Host API v1 (pinned `wss://`), the
> read-only History, offline sync and direct reads. The pairing steps are in [quick-start.md](./quick-start.md).
> The MobileProtocol v2 link to the retired Swift Mac app (`ws://…:3006`, Bonjour) was removed on 2026-11-06,
> and with it the old F1-F18 rows (Phone access switches, tiers and Mac dialogs); their last result is
> UN-002 ("iOS app is working", 2026-11-05).

## Automated gates

```bash
make test-shared-protocol   # v1 client, pinning, QR parser, reads, sync, Box/GitLab clients
```

The unsigned `iphoneos` build in `.github/workflows/ios-ci.yml` proves the app compiles against the current
SharedProtocol.

## Host API v1 from the iPhone app (deferred to the product stage)

User decision 2026-11-04: these are run at the product stage. v1 over `wss://` works against a desktop started
with `LLMIDE_HOST_API_TLS=1`; `ws://` is accepted for loopback only, so the Simulator can use a DEBUG host
started with `LLMIDE_HOST_API_DEV=1` and `LLMIDE_HOST_API_URL=ws://127.0.0.1:3016/host-api/v1` in the Xcode
scheme.

| # | Check | Expected |
|---|---|---|
| H1 | Fresh pair by QR scan (desktop Settings → Mobile Control → Pair a phone or web client) | Status Live; Keychain holds `host-api-token` and the pinned `h1fp`; the PIN is gone; the desktop lists the phone under Paired devices |
| H2 | Send, Stop, clear history, answer a question, Allow once or Deny a tool prompt | Each works; the reply streams into the Chat tab; no status lines during the turn |
| H3 | Quit the desktop, then start it again | The phone shows "Couldn't reach the desktop. Retrying…", backs off, and reconnects by token |
| H4 | Background the app for 1 minute, then return | It reconnects by token and the transcript reloads |
| H5 | Revoke the device on the desktop | The phone gets `auth_failed` and returns to pairing |
| H6 | Type a PIN for an address the phone never scanned | "Scan the pairing QR code…"; no socket opens |
| H7 | Reset the desktop's security identity (new certificate), then reconnect | `pin_mismatch`; credentials are kept; only a new QR scan replaces the pin |
| H8 | Pair over `wss://` and compare the fingerprint with the desktop's card | They match; a host with another certificate is refused before any frame |
| H9 | Pair over Tailscale (QR `ip` is a `100.x` address), then use the phone off the home Wi-Fi | Connects with ATS on (`NSAllowsArbitraryLoads` false) |

**S4 exit checklist row ("phone chat policy removed"):** the phone chat idle timeout (960 s, which sends Cancel)
in `LlmIdeChatStore.swift` is removed when the core's replay/detach (`chat.attach`) replaces it; until then it
is unchanged and documented as temporary (Plan 4 decision 7).

## Host API v1 reads from the iPhone app (user-run)

Setup: the desktop with `LLMIDE_HOST_API_READ=1`, and an iPhone paired **after** the switch was on (a device
paired before it must re-pair to get `read`). Plan: `docs/superpowers/plans/2026-11-05-host-api-v1-reads-ios.md`.

| # | Check | Expected |
|---|---|---|
| F19 | Pair to a desktop serving `read` | Tabs: Chat, History, Settings. History lists the desktop's chats newest first; the phone chat row says "Live chat · on the Chat tab" and does not open |
| F20 | Same desktop without `LLMIDE_HOST_API_READ`, or a device paired before it was on | No History tab (unless offline sync is on); Settings has no "Usage & limits"; nothing calls `chat.sessions`, `chat.history` or `usage.get` (host log) |
| F22 | More than 50 chats: tap More chats repeatedly and quickly | Each tap adds one page with no duplicate rows; the button disappears at the end or at 500 chats |
| F23 | Open a long chat, tap Show older until it goes away | Older messages appear above; the view keeps at most the newest 2,000; there is no composer, no Stop, no Clear |
| F24 | Open chat A and immediately go back and open chat B | Only B's messages show; no error from A appears on B or on the list |
| F25 | After reading chat B, send a message from the Chat tab | It goes to the phone chat (visible on the desktop's phone chat), never to B |
| F26 | Usage strip and Settings → Usage & limits | Up to 3 meters on the strip, all on the full screen; numbers match the web client's Usage |
| F27 | Turn `read` off on the desktop (restart without the switch) while History is open; also lose the network | History content clears and the app returns to Chat; on reconnect without `read` the tab stays hidden |
| F28 | VoiceOver on: History list, usage strip, a chat; then Settings → Accessibility → Larger Text at the largest size | Each row is read as one element (title + time, meter name + detail, "You:" / "Assistant:" + text, "title, read-only"); message text grows and wraps with no clipping; chat titles may truncate (2 lines in the list, 1 in the header) |

## Offline sync and direct reads (user-run)

| # | Check | Expected |
|---|---|---|
| Y1 | Enroll from the desktop's Phone and web sync → Add a phone or browser, compare the 6-digit code | "Sync is on"; the snapshot appears in History with the desktop off |
| Y2 | Queue a prompt with the desktop off, then start the desktop | The prompt is answered and the answer appears after the next refresh |
| Y3 | Remove sync on the phone; revoke it on the desktop | The snapshot, queue and keys are gone from the phone; a revoked phone shows "This iPhone was removed from sync" |
| Y4 | Settings → Box and GitLab: sign in, browse, open a file | Read-only listing and file view; tokens in the Keychain; nothing is written |

## Security

- [ ] Pairing token and certificate pin in the Keychain (`com.llmide.device-pin`, accounts `host-api-token`,
  `host-api-pin`), this device only
- [ ] App Transport Security on: `NSAllowsArbitraryLoads` false, `NSAllowsLocalNetworking` only for the
  loopback dev listener (`ios_app/MyApp/Supporting/Info.plist`)
- [ ] No plaintext link to any other host; Box and GitLab keep TLS 1.2 or later

## Permissions

| Permission | Required? | Notes |
|------------|-----------|-------|
| Camera | For pairing | Scans the desktop's pairing and sync QR codes |
| Local Network | For a LAN desktop | iOS asks on the first connect |
| Microphone + Speech Recognition | No | Dictation only; on-device |
