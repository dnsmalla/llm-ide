# Mobile link TLS with certificate pinning: design

Status: **design only, no code.** Date: 2026-10-31, at `main`. Closes requirement R-SEC-1 of the [command bus spec](2026-10-31-command-bus-spec.md) (section 7.1 finding 1, slice S6 and its optional interim fix in S2). Implementation is a separate task and needs the user's decisions in section 10.

## 1. The problem, as the code has it today

- The Mac listens with `NWParameters(tls: nil)` (`mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileWebSocketServer.swift`, near line 163). The phone connects to `ws://`.
- `ios_app/MyApp/Supporting/Info.plist` sets `NSAllowsArbitraryLoads = true`, with a comment that names the real fix as "TLS with an SPKI hash carried in the QR".
- The 6-digit PIN, the long-lived per-device token and every chat frame (including file text and approvals) cross the LAN or Tailscale in the clear. Anyone on the same network can read them, and anyone who captures a token can reconnect as the phone until it is revoked.
- Tailscale encrypts the hop between tailnet devices (WireGuard), so on a tailnet the practical exposure is smaller than on a coffee-shop LAN, but the app cannot tell the two apart, and the Bonjour path is plain LAN.

Goal: the phone refuses to talk to anything that is not the Mac it paired with, and nothing sensitive is readable on the wire, on any network, with no certificate authority, no cloud service and no user-visible certificate step.

## 2. Design in one paragraph

Each install creates a **self-signed certificate and private key** on first start of Mobile Control. The key lives in the Keychain (same `LLMIDE_KEYCHAIN_BACKEND` abstraction as the PIN), never leaves the Mac, and is not shared between Macs. The **SHA-256 of the certificate's SubjectPublicKeyInfo (the SPKI hash)** is put in the pairing QR and the Direct-IP pairing string. The phone stores that hash in its Keychain next to the device token and, on every connection, **accepts the TLS handshake only if the server's leaf SPKI hash equals the stored one** (trust-on-first-use is replaced by trust-from-the-QR: the QR is scanned in person, so it is the out-of-band channel). The WebSocket runs over TLS (`wss://`). No CA validation is involved, so hostnames, IP addresses and Tailscale names do not matter.

## 3. Mac side

1. **Identity creation.** On first start, generate a P-256 key (`SecKeyCreateRandomKey`, `kSecAttrIsPermanent`, access `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, label `LLM-IDE mobile link`) and a self-signed X.509 leaf (CN `LLM-IDE <device name>`, validity 5 years, `basicConstraints CA:FALSE`, `keyUsage digitalSignature`, `extKeyUsage serverAuth`). Build the DER by hand (a small fixed template, no third-party library) and wrap it with `SecIdentityCreate`-style import via a temporary keychain-free `SecPKCS12Import` of a generated PKCS#12, or store the cert with `SecItemAdd` and read the identity back with `SecItemCopyMatching(kSecClassIdentity)`. Prefer the second form: it keeps the private key non-exportable.
2. **Listener options.** Replace `NWParameters(tls: nil)` with `NWParameters(tls: tlsOptions, tcp: tcpOptions)` where `tlsOptions = NWProtocolTLS.Options()` and the identity is set with `sec_protocol_options_set_local_identity(tlsOptions.securityProtocolOptions, sec_identity_create(identity))`. Set the minimum TLS version to 1.2 (`sec_protocol_options_set_min_tls_protocol_version`) and prefer 1.3. Keep the WebSocket framing options on top (`NWProtocolWebSocket`) exactly as now; only the stack under it changes.
3. **No client certificates.** The phone is authenticated by PIN then token inside the TLS channel, as today. mTLS would make rotation harder for no gain, because the token already identifies the device and is now confidential.
4. **Fingerprint publication.** Add `MobileConnectionInfo.spkiHash` (base64url of SHA-256 over the DER SubjectPublicKeyInfo). It goes into the QR payload (`llmide://pair?host=...&port=...&pin=...&fp=<hash>&v=2`) and into the Settings > Mobile Control "Direct IP" copy text. Bonjour TXT may carry the hash too (`fp=`) as a convenience for re-discovery, but the phone trusts only the value it stored at pairing.
5. **Port fallback unchanged.** The bind retry (3006 to 3015) is independent of TLS.
6. **Capability and version.** `Connected.capabilities` gains the string `tls_pinned` (strings are ignored by older phones), and `protocolVersion` stays 2: TLS is a transport change, not a message change.

## 4. iOS side

1. **Stored pin.** `ConnectionStore` keeps `{deviceId, token, spkiHash}` in the Keychain (additive field; an old record has no hash and is a "legacy pairing", section 7).
2. **Connection.** Create the WebSocket with a `URLSession` whose delegate implements `urlSession(_:didReceive:completionHandler:)` for `NSURLAuthenticationMethodServerTrust`. The delegate takes `challenge.protectionSpace.serverTrust`, reads the leaf with `SecTrustCopyCertificateChain` (or `SecTrustGetCertificateAtIndex` below iOS 15), computes `SHA-256(SPKI)` with `SecCertificateCopyKey` plus `SecKeyCopyExternalRepresentation` and the fixed ASN.1 header for P-256, compares in constant time with the stored hash, and calls `.useCredential(URLCredential(trust:))` on a match or `.cancelAuthenticationChallenge` on a mismatch. It never calls the default handling, so a CA-signed certificate for the same host is also refused: the pin is the only trust root.
3. **A mismatch is a hard, named failure**, shown as "This is not the Mac you paired with (its security fingerprint changed). Re-pair from the Mac's QR code." It never silently falls back to cleartext and never offers "trust anyway".
4. **URL scheme.** `wss://` when the record has a hash; `ws://` only in the explicit insecure mode (section 6).
5. **Info.plist.** Remove `NSAllowsArbitraryLoads` and add `NSAllowsLocalNetworking = true` only if the insecure-LAN toggle ships (section 6); without it, no exception at all is needed because pinned TLS to an IP uses a custom trust decision. Verify with an ATS-enabled run that `wss://192.168.x.x` with a custom delegate is accepted (ATS applies to the default evaluation; a delegate that fully replaces trust evaluation is allowed, to be confirmed in the on-device test in section 9).

## 5. Rotation, revoke, and lifetime

- **Normal life.** The certificate is valid 5 years; the key is stable so the pin in a phone keeps working across app restarts and macOS updates.
- **Rotation (planned, or key suspected leaked).** Settings > Mobile Control > "Reset security identity" deletes the key and certificate, generates a new pair, **revokes every paired device token** (they were sent over a channel that may have been observed), rotates the PIN, and shows the new QR. Every phone must re-pair. This is deliberately one button with a confirmation, because it ends all trust.
- **Expiry.** At 30 days before expiry the Settings page shows a notice; on expiry the Mac regenerates and treats it as a rotation. The 5-year default makes this a rare event.
- **Revoking one phone** is unchanged (Settings > paired devices > Revoke); it does not touch the certificate.
- **Mac replaced or reinstalled.** A new install makes a new identity, so old pairings fail with the mismatch message and the user re-pairs, which is the correct outcome. Migrating the key to a new Mac is explicitly not supported.
- **Backup.** The key is `ThisDeviceOnly`, so it is not in iCloud Keychain or backups.

## 6. Network cases and the fallback policy

| Case | Behaviour |
|---|---|
| Bonjour on the home LAN | `wss://` to the resolved address, pin from the stored record. Works with DHCP changes because the pin is not tied to an address. |
| Direct IP typed by hand | Same; the pin comes from the QR or the copied pairing string, so a typed address still needs the pairing string once. |
| Tailscale (100.x or MagicDNS name) | Same code path. TLS inside WireGuard is redundant but harmless and keeps one code path. |
| Port fallback (3006 to 3015) | The phone is told the actual port by the QR or Bonjour, as now. |
| Captive/hostile network doing TLS interception | Handshake presents a different key, pin mismatch, connection refused: the intended result. |
| Old phone build (no TLS support) against a TLS-only Mac | Cannot connect. Mitigated by the migration policy below. |

**Migration policy (cleartext fallback).** The goal state is TLS only. To avoid stranding existing users:

1. **Release N (ships TLS).** The Mac serves TLS and, while the toggle below is on, also keeps a cleartext listener on the next port. The Mac setting **"Allow insecure LAN connections"** exists, and is **ON by default only for installs that already have a paired device without a pin** (a one-time migration flag, stored with the paired device record) and **OFF for every new install**. With the toggle on, Settings shows a standing warning "Phone link is not encrypted".
2. **The phone** prefers `wss` whenever its record has a hash. For a legacy record it connects over `ws://`, shows "Not encrypted" in its connection banner, and on the first successful connection to a TLS-capable Mac (`tls_pinned` capability present) it **offers re-pairing to get the pin**; the QR scan gives it the hash.
3. **Release N+1.** The migration flag stops being honoured: the toggle is OFF for everyone and its listener is not started unless the user turns it on by hand, which re-shows the warning. A paired device with no pin is told to re-pair.
4. **Never silent.** There is no automatic downgrade on a handshake failure. A pinned record that fails TLS is an error, not a reason to try `ws://`.
5. **PIN-only (no token) legacy pairing** (`quick-start.md`) is dropped at N+1 together with the cleartext path.

## 7. What changes on the wire and in the docs

- QR gains `fp` and `v=2`; a v1 QR still parses (no `fp`, legacy record).
- `docs/mobile/quick-start.md` and `verification.md` get a "Transport security" section (they currently never state the link is cleartext).
- The relay design's E2E layer is separate: relayed traffic is already encrypted end to end; this design covers only the direct LAN and Tailscale path.

## 8. Test plan

Automated (no device):

1. **Identity.** Generate, persist and reload an identity under the memory Keychain backend; the SPKI hash is stable across reload and changes after "Reset security identity".
2. **Loopback handshake test** (extend `scripts/mobile/verify-native-pairing.swift` and add XCTest in `MobileWebSocketServerBindTests` style): start the listener on an ephemeral port with TLS, connect a `URLSession` client with the pinning delegate; (a) correct hash connects and pairs, (b) a wrong hash is refused with no frame sent, (c) a CA-valid but different certificate is refused, (d) after rotation the old hash is refused, (e) with the insecure toggle off, a plain `ws://` connect to the TLS port fails and no cleartext listener exists.
3. **Hash vector tests** for the SPKI extraction against a fixed certificate fixture (so the iOS and Mac sides agree byte for byte).
4. **Pairing string round trip** with and without `fp` (v1 and v2 QR).
5. **Migration flag tests**: new install has the toggle off; an install with a legacy paired device gets it on once; N+1 behaviour with a clock/flag seam.

On-device (**the user must run these**; an agent cannot):

1. Pair a physical iPhone over the home Wi-Fi by scanning the new QR; confirm the connection banner shows "Encrypted" and chat works.
2. **Tailscale:** with the iPhone off the home Wi-Fi (cellular) and the Mac on the tailnet, connect through the Mac's tailnet name/IP using the pairing string; confirm it connects and that pin mismatch works by pairing, then pressing "Reset security identity" on the Mac and checking the phone shows the "not the Mac you paired with" message instead of reconnecting.
3. **ATS check:** build the iOS app with `NSAllowsArbitraryLoads` removed; confirm `wss://<LAN IP>` connects (the open question in section 4, item 5) and that Local Network permission still prompts correctly.
4. **Legacy path:** with an old build (pre-TLS), confirm it still connects while the migration toggle is on, shows "Not encrypted", and is refused once the toggle is off.
5. Wireshark or `tcpdump -A` on the Mac's interface during a chat: no PIN, token or chat text is readable.
6. Lock the phone, reconnect after unlock, and revoke one device: the other still works.

## 9. Risks and open points

- **Hand-built X.509 DER** is the riskiest piece; alternative is `openssl`-free generation through `SecCertificateCreateWithData` of a template certificate re-signed per install, or shipping a tiny Swift ASN.1 writer with the fixture tests above. Decide at implementation; the tests in section 8 make either safe.
- **ATS with a fully custom trust delegate** must be confirmed on a device (section 8, on-device item 3); if iOS still refuses, the fallback is `NSAllowsLocalNetworking`, which is far narrower than `NSAllowsArbitraryLoads`.
- **Key in the Keychain from a non-sandboxed, ad-hoc-signed build**: access groups behave differently between the Swift app and the Tauri app (Phase 5 does not host `:3006`). The identity must be created by whichever process owns the listener.
- **Clock skew** does not matter (the phone does not check validity dates when pinning), which also means an expired certificate keeps working until the Mac rotates it; the expiry notice is a hygiene measure, not a security one.

## 10. Decisions for the user

| # | Question | Recommendation |
|---|---|---|
| Q1 | Ship the interim TLS in S2 (before the bus), or wait for S6? | Ship it first: it is independent of the bus and closes the worst finding |
| Q2 | Migration: honour a one-release cleartext fallback for existing pairings, as in section 6? | Yes, one release, with the standing warning, then off |
| Q3 | Is "Reset security identity" revoking all devices acceptable as the only rotation action? | Yes |
| Q4 | Keep `NSAllowsLocalNetworking` for the insecure toggle, or remove the cleartext path at once? | Keep for one release, remove at N+1 |
