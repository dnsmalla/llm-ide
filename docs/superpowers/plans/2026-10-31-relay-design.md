# Relay design: encrypted snapshots, inbox, phone clients

Status: **design revised to the independent security review; no code, no host chosen (D6 open until R2).** Date: 2026-10-31, at `main`. Parents: [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md) (decisions 4 and 5, status "proposed"), [Tauri desktop and relay plan](2026-10-24-tauri-desktop-and-relay.md) (sections 3, 8, 9), [sync-kit K0 map](../../kits/sync-kit.md), [MASTER-PLAN](../MASTER-PLAN.md) (S3, S4, Security), [data-lifecycle](../../kits/data-lifecycle.md). Revised against [the relay security review](2026-10-31-relay-security-review.md): **every finding (3 critical, 7 high, 10 medium, 5 low) is adopted or answered in the traceability table in section 14.** Nothing here was run or measured; numbers marked "proposed" are starting values for R0 and R1, and every "verify" is an R1 task (no browser or library support level was checked online). This revised design still does **not** replace the external review required by the release gate G-EXT (section 10).

## 0. What the user already decided

| Date | Decision | Source |
|---|---|---|
| 2026-10-30 | The web app is the **relay-served phone web view (PWA), built last, inside sync-kit** (Q-WEB-1 = A). Revised below: a **tiered** PWA (D1). | MASTER-PLAN S4 |
| 2026-10-30 | **The phone through the Mac is enough for now** (Q-WEB-3). | MASTER-PLAN S3 |
| 2026-10-24 | The relay holds **no plaintext**, makes **no LLM calls**, runs **no code**; devices hold individual revocable tokens; revoking a device rotates the key; inbox requests are re-checked by the desktop. | ADR 0018 |
| 2026-10-31 | The user said "i want a secure system, individual login" and **delegated the nine review decisions to the secure recommendations.** Recorded honestly as: **user delegated to the secure option; revisit if wrong.** Resolved as D1 to D9 below. | this session |

### 0.1 Decisions D1 to D9

| # | Decision | Resolved as | Status |
|---|---|---|---|
| D1 | PWA assurance | **Tiered clients.** PWA on a **separate origin and separate hosting account**, holding **read-only subkeys** and able to queue **low-risk classes only**. Writes, approvals, edits, Loop or Auto Task start, anything that spends or posts: **native iOS app and desktop only.** | decided (delegated) |
| D2 | Ceiling for queued phone requests | **Fixed read-only capability ceiling**, never inheriting the desktop's Bypass or permission mode. | decided (delegated) |
| D3 | Recovery code | **None in v1.** Lost desktop means re-enroll every device. | decided (delegated) |
| D4 | Emergency revoke without the desktop | **Printed revoke code**; kills the device token and push subscription at the relay at once; the desktop **rotates first** on its next start. | decided (delegated) |
| D5 | Metadata posture | **Fixed-schedule heartbeat** (with jitter), **IP retention 72 hours**. | decided (delegated) |
| D6 | Hosting and accounts | VPS or Cloudflare **still OPEN, decide at the start of R2**. Fixed now: the PWA host is a separate origin, account and deploy credential, MFA with hardware key. | **open** |
| D7 | Extension scope | **Meeting upload only**; no snapshot keys in v1. | decided (delegated) |
| D8 | Sharing scope | **Per-user keys with individual login.** No key is shared between people; a user's own devices share that user's key hierarchy only. A team is a later, separate cryptographic design. | decided (delegated) |
| D9 | External review | **Independent external review before any public exposure**: a release gate (G-EXT, section 10). | decided (delegated) |

**Gating:** ADR 0018 becomes Accepted only after the Phase 0 closing items (user-run bench, one Windows run). Nothing in Tauri K3 or the relay starts before that. This document may be reviewed now.

## 1. Goals and non-goals

**Goals**

1. With the desktop off, the phone (and later the extension) can **read the latest snapshot** of what the desktop chose to publish, and **queue a small allow-listed set of requests**.
2. With the desktop on, requests flow through the relay and run live on the desktop.
3. The relay **cannot read** snapshots, requests or replies, cannot forge them undetected, and cannot make the desktop do anything the desktop would not allow.
4. A lost or revoked device loses access to **future** data (key rotation).
5. Replace the cleartext `ws://` port `:3006` and the PIN (ADR 0018 "Supersedes") once parity is reached.

**Non-goals**

- No LLM call, no code execution, no file write, no connector on the relay.
- No second store of record (section 3, question R1): a snapshot is a replaceable, encrypted read view.
- No remote desktop, no screen streaming (already cancelled; see the Mobile CLAUDE.md).
- No multi-tenant SaaS: the relay serves one organisation's devices.
- No change to the loopback-only Node core (ADR 0004): the core stays bound to `127.0.0.1`; only the **desktop initiates outbound** connections to the relay.

## 2. Architecture

```text
Phone PWA (separate origin)   Native iOS app      Extension (upload only)
        |  HTTPS                    |  HTTPS             |  HTTPS
        v                           v                    v
   +---------- Relay (always on, data origin) ----------+      +-- PWA host --+
   |  user accounts (individual login)  device registry |      | static bundle|
   |  snapshots + manifest  per-device inbox  outbox    |      | other origin,|
   |  enrollment slots  push sender (allowlisted)       |      | other account|
   |  NO plaintext, NO keys, NO LLM, NO code            |      +--------------+
   +------------------------^---------------------------+
                            |  outbound HTTPS/SSE only
                  Desktop (main worker): Node core
                  snapshot producer + request consumer
                  holds root key, signing key, local device registry
```

**Individual login (D8).** The relay has **per-user accounts**: a user id, one desktop per user, and that user's devices. Tokens, queues, snapshots, keys and quotas are scoped per user; no object is readable or writable across users. How a user logs in to the account is an R0 specification item (proposal: the account is created by the desktop at relay setup, registering the desktop's public signing key; there is no password at the relay, because device and desktop actions are signature-bound, section 4.8).

Token classes: **desktop** (identifies the account only; every admin operation is separately signed, H5), **device** (one per phone or browser, sender-constrained by a per-request signature), **enrollment** (single use, 2 minutes, section 4.5). The relay stores only token hashes. Tokens appear only in the `Authorization` header (M6).

### 2.1 Relay surface (to be specified in `schema/http`, group "relay (new)")

| Area | Operations | Who | Notes |
|---|---|---|---|
| Manifest | put manifest; get manifest | put: desktop; get: device | The signed manifest is fetched first (4.7). |
| Snapshots | put blob by opaque kind id; get blob named by the manifest | put: desktop; get: device | Latest only (history none, R10); blob plus clear envelope (4.3). |
| Inbox | put a request; drain (long poll or SSE); ack | put: device; drain, ack: desktop | **Per-device queues**, fair drain, caps per device and per user (M5). |
| Outbox | put reply; get replies for me | put: desktop; get: device | Encrypted, signed, expiring. |
| Blobs | resumable chunked meeting upload | put: extension | Separate blob path, daily quota, orphan cleanup after 1 day (M3, M5). |
| Devices | begin enrollment; claim; confirm; list; revoke; **emergency revoke** | begin, confirm, revoke: desktop (signed); claim: new device; emergency revoke: holder of the revoke code | Relay copy of the registry is a convenience; the desktop's is authoritative (C3). |
| Keys | publish signed wrap per device and epoch; fetch mine | publish: desktop; fetch: device | |
| Push | register subscription (endpoint allowlisted); send generic ping | register: device; send: relay | Section 7.4. |
| App | **not served by the data relay** | n/a | The PWA is served from the separate PWA host (7.2). |
| Health | liveness and version | public | No data. |

All routes HTTPS only (TLS 1.3 preferred, HSTS, no mixed content, L1), rate-limited per token class, IP and slot. Body caps (proposed): manifest 8 KiB, snapshot 256 KiB, request 16 KiB, reply 256 KiB; uploads via the blob path. Unknown and expired slot errors are identical.

### 2.2 What the relay stores

| Item | Plaintext? | Retention |
|---|---|---|
| Manifest, snapshot blobs | no (ciphertext, signed) | latest only (history none) |
| Signed wraps | no | until device revoked or epoch retired |
| Inbox, outbox items | no | until acked or `expiresAt`, 7 days maximum |
| Device registry (convenience copy) | token hash, device id, public keys, label, last seen, capability set | until revoked |
| Enrollment slots | `SHA-256(claimToken)`, expiry | 2 minutes |
| Revoke-code hash, revocation-pending flag | hash only | until cleared by the desktop |
| Push subscriptions | endpoint and keys the browser issued | until revoked |
| Logs | time, route, token class, size, status; **never bodies, tokens, headers or fragments** | 14 days; **IP addresses at most 72 hours** and never joined with device ids in long-lived logs (D5, M6) |
| Backups | device registry only | per R8 |

## 3. Interaction with the one-copy rule

[data-lifecycle](../../kits/data-lifecycle.md) rule 1 says each kind of data has **one durable home** and the web is a connector. A snapshot is a **derived, encrypted, replaceable copy** of data whose home stays on the desktop; deleting the relay loses nothing that the desktop cannot republish. Readings that must be confirmed by the user (question R1): snapshots are an allowed cache like the rebuildable search index (rule 4), not a duplicate. The queued **inbox** is the only data that can exist *only* at the relay for a while (a request made while the desktop was off); it is short-lived, TTL-bound, and its loss is a dropped request, not lost data.

## 4. End-to-end crypto specification

Platform primitives only (WebCrypto in browsers, Node `crypto` on the desktop, native frameworks on iOS). No home-grown primitive. All values proposed for the R0 spec; every browser-support question is verified at R1.

### 4.1 Key hierarchy and capability sets (H3, M1)

- **Root** `K_root[epoch]`: 32 random bytes per epoch, held only by the desktop (OS keychain). Epoch is per user (D8).
- **Subkeys**: `HKDF-SHA-256(ikm = root, salt = SHA-256("llmide-relay-v1" || userId || desktopId), info = purpose || epoch || kindId || senderId)` to 256 bits. Purposes: `enc`, `kind-id`, `manifest`, `request`, `reply`.
- **One AEAD key per (epoch, kind, sender)** so each key sees one sender.
- **Capability set per device**: which read kinds and which write classes. A device is wrapped **only the subkeys its capability set needs**. A capability change is an epoch change for the affected subkeys.
- Capability tiers fixed by D1 and D7: **PWA** = read subkeys, low-risk queue classes, no write or approval subkeys. **Native iOS** = read and approval and write classes the desktop switches allow. **Extension** = meeting-upload write subkey only, no read subkeys.
- Kind ids: `HKDF(root, "kind-id" || name || epoch)` truncated to 128 bits (relay cannot correlate across epochs or dictionary-guess names).

### 4.2 Primitives table

| Item | Specification |
|---|---|
| Randomness | `crypto.getRandomValues` (browser), `crypto.randomBytes` (Node), platform CSPRNG on iOS; nothing else; a lint rule bans `Math.random` in the crypto package (L3) |
| Root key | 32 bytes per epoch, desktop keychain; devices hold wrapped subkeys only, imported as non-extractable `CryptoKey` |
| AEAD | AES-256-GCM, 96-bit random nonce, 128-bit tag; **hard cap 2^24 messages per key** (the NIST random-nonce limit is 2^32), at the cap the sender refuses and the desktop rotates; publish rate-limited; **no counter nonces on devices** (restore or eviction resets counters) |
| AAD | version byte, purpose tag, epoch, kindId, senderId, recipientId (replies, requests), seq, requestId (if any), issuedAt, expiresAt, userId, desktopId, deviceId, capability-set hash where relevant, in canonical encoding. Unknown version fails closed; no negotiation |
| Encoding | **Canonical binary** (length-prefixed fields or deterministic CBOR) for every signed byte string and AAD; never JSON; duplicate fields rejected |
| Signatures | ECDSA P-256 / SHA-256, raw r||s (IEEE P1363) pinned on both Node and WebCrypto, over `context || canonical header || ciphertext`; fixed context per purpose (`"llmide/snapshot/v1\0"`, `/manifest/`, `/wrap/`, `/reply/`, `/request/`, `/admin/`) so one signature is never valid as another type; **every message type is signed** (also closes the GCM key-commitment gap). Ed25519 only if R1 verifies cross-engine support |
| Key wrap | HPKE (RFC 9180) base mode, DHKEM P-256, HKDF-SHA-256, AES-256-GCM, or the equivalent ECDH P-256 plus HKDF written out exactly with known-answer vectors (Node and WebCrypto have no native HPKE: small audited implementation or the explicit form). `info` and AAD = `"llmide/wrap/v1" || epoch || deviceId || SHA-256(device ECDH SPKI) || SHA-256(desktop signing SPKI) || capability set`. The **wrapped object is signed by the desktop signing key** (C2) |
| Device keys | Two non-extractable pairs generated on the device: ECDH P-256 (wrap) and ECDSA P-256 (request and enrollment proofs) |
| Desktop signing key | ECDSA P-256, hardware-bound and non-exportable where the OS offers it (Secure Enclave, TPM), software keychain otherwise, **stated as weaker** (H5) |
| Enrollment secret | 128-bit CSPRNG in the URL fragment; `claimToken`, `bindKey`, `sasKey` by HKDF-SHA-256 with labels `claim`, `bind`, `sas`; relay stores `SHA-256(claimToken)`; bind MAC is HMAC-SHA-256 verified by the desktop only; SAS = 6 decimal digits from HMAC-SHA-256 over both device public keys and the slot id under `sasKey` |
| Enrollment life | 2 minutes, one claim, enforced by the desktop |
| Bearer tokens | 256-bit random, relay stores SHA-256, constant-time compare, idle expiry (30 days) and hard expiry with refresh, last-seen shown on the desktop (L2) |
| Padding | length-prefix then zero-pad **inside** the AEAD plaintext to the bucket (1, 4, 16, 64, 256 KiB); no compression before padding |
| Fingerprint | SHA-256 of SPKI; QR carries the full 256 bits; displayed as grouped hex or words; never below 128 bits (L4) |
| Recovery | **none in v1 (D3)**. If ever added: 256-bit code, local backup only, never at the relay, Argon2id m = 256 MiB, t = 3, p = 1 or PBKDF2-HMAC-SHA-256 at least 600 000 iterations, rotate epoch and registry on restore (M9) |
| Time | nothing security-critical depends on the relay clock; device skew tolerated within a stated window and surfaced (L5) |
| Known-answer tests | vectors committed for AES-GCM, HKDF, ECDSA, wrap and canonical encoding, plus Wycheproof-style negatives where available (L3) |

### 4.3 Message envelope

Clear header (routable by the relay) plus ciphertext; the header is bound as AAD and signed.

| Field | Clear | In AAD |
|---|---|---|
| version, purpose | yes | yes |
| kind id (opaque, per epoch) | yes | yes |
| epoch, seq, senderId, recipientId, requestId | yes | yes |
| issuedAt, expiresAt (expiry is **advisory**; receivers enforce their own maximum age, M2) | yes | yes |
| userId, desktopId, deviceId | yes | yes |
| nonce, ciphertext, tag, signature | yes (opaque) | n/a |

Ordering is the pair **(epoch, seq)**, lexicographic. Desktop `seq` persists durably; if counter state is lost or restored from backup, **the desktop starts a new epoch** (H6). Hybrid `max(counter + 1, floor(ms clock))` is acceptable.

### 4.4 Key wrap is a signed object (C2)

The device verifies, before unwrapping: the desktop signature over the whole wrapped object against the **QR-pinned fingerprint**; that `epoch` is strictly greater than its current epoch; that the AAD names its own `deviceId`, its own key hashes and its capability set. After unwrap it returns a **key-confirmation** message (short signed ciphertext under a subkey of the new root) so the desktop learns the device holds the key. A relay-created wrap of a chosen key therefore fails verification on every enrollment and rotation.

### 4.5 Enrollment (H4)

1. Desktop, **Settings, Phone and devices, Add a device**, on an explicit click opens a slot at the relay (128-bit slot id). It shows the QR only on that click, excludes the window from screen capture (macOS window sharing type none; verify per OS in Tauri), says on screen that the code is a secret, and expires it in **2 minutes**.
2. QR content: relay URL, slot id, enrollment secret `s`, the **full SHA-256 fingerprint** of the desktop signing key, current epoch, **minimum manifest seq**, requested capability tier. It is in the URL **fragment** only (never path or query); the client calls `history.replaceState` before any other code runs.
3. The device generates its two keypairs and claims the slot with `claimToken` plus both public keys and a bind MAC (HMAC over both public keys, slot id and label under `bindKey`). The relay gates the claim by `SHA-256(claimToken)` and cannot verify the MAC (it never sees `bindKey`); **the desktop verifies it.**
4. **Contested claim**: a second claim on a slot kills the slot and the desktop shows a loud alert ("someone else scanned this code").
5. **SAS on both screens**: desktop and phone each compute the 6-digit SAS from `sasKey`, both public keys and the slot id; the user confirms they match. A person who photographed the QR knows `s` but their device shows a different string than the phone in the user's hand. One attempt per slot.
6. The desktop, **not the relay**, enforces single use and the 2-minute window and records the claim.
7. On confirmation the desktop adds the device to its **local signed registry** (4.6), publishes the **signed wrap** (4.4) for the device's capability set, and the relay issues the device token once.

Screen-share and leak handling: a QR or URL seen on a shared screen is treated as burned after 2 minutes, or sooner on first claim; the user is told that, and a mismatched SAS after a screen-share is the signal to cancel.

### 4.6 Desktop-owned device registry (C3)

The desktop keeps its **own signed local registry**: device id, both public-key fingerprints, label, capability set, enrolled-at, confirmed-by-user flag. It is written only by the enrollment-confirm and revoke UI actions, kept in the OS keychain or an integrity-protected file. **Rotation wraps only to keys in this registry.** The relay's registry is a convenience copy; a mismatch is **shown to the user and never acted on**. Every desktop-originated registry operation sent to the relay is signed (4.8).

### 4.7 Manifest, rollback and freeze (H6)

The desktop signs a small **manifest**: every current kind with its `seq`, `epoch` and blob hash, one global monotonic `manifestSeq`, and `validUntil`. Devices fetch and verify the manifest first and then only the blobs it names, so kind mix-and-match is impossible. The heartbeat (fixed schedule, D5) refreshes the manifest; freeze beyond `validUntil` shows "desktop offline or relay withholding". The QR carries the **minimum manifest seq**, so a fresh device cannot be handed an old state; a storage-evicted device re-enrolls.

### 4.8 Sender-constrained requests and admin operations (H5)

- **Every desktop admin operation** (open slot, revoke, edit registry, drain-delete, snapshot put) carries an ECDSA signature by the desktop signing key over method, path, body hash, timestamp, request counter and context `"llmide/admin/v1"`. The relay verifies against the public key registered at relay setup. Stealing the desktop bearer token alone is no longer a takeover.
- **Device requests** carry a signature by the device ECDSA key over method, path, body hash, timestamp and nonce (DPoP-like); non-extractable keys make token theft useless on its own.

### 4.9 Revocation, emergency revoke, rotation (H1, M10)

| Event | Action |
|---|---|
| Desktop revoke | Relay deletes the device token hash, keys, wraps and push subscription. Desktop starts a **new epoch**: new root, wraps (signed) only to the remaining devices **in its local registry**, publishes, then deletes old data. **Order: rotate, wrap, publish, delete.** Never publish under the old epoch after a revoke was requested. |
| **Emergency revoke** (D4) | A **128-bit revoke code printed at setup** (relay stores only its hash) kills a device token and its push subscription at the relay immediately and sets a "revocation pending" flag (signed by nobody, only a flag). On its next start the desktop **must rotate before publishing anything**; with a pending flag the first publish is a rotation (fail closed). Token kill only: it cannot make the thief's already-held keys useless until that rotation. |
| After rotation | Republish under the new epoch (the desktop is the home); delete old blobs; **every device erases old-epoch keys** as soon as the new epoch's republish is confirmed, and an offline-then-returning device deletes them on contact. Relay backups hold the device registry only (spec rule). |
| Grace window | Requests from still-registered devices under the previous epoch are accepted for a short bounded time; requests from a revoked device never. |
| Desktop compromise or restore | Rotate the epoch and signing key; every device re-enrolls. No recovery by the relay (D3). |
| Scheduled rotation | Optional, 90 days. |

What revocation does **not** do: un-read data a revoked device already decrypted; give forward secrecy against a relay that kept old ciphertext (mitigated by history none and old-epoch key erasure; no per-message ratchet, deliberately: it would multiply complexity for a threat revocation already addresses).

### 4.10 What a malicious relay can and cannot do

| Can | Cannot |
|---|---|
| Refuse service, delay, drop, freeze (visible after `validUntil`) | Read content |
| See device ids, opaque kinds, time, size class, IPs (72 h) | Forge a snapshot, manifest, reply or wrap (needs the desktop signing key) |
| Serve old state | Make rollback undetected for a device with state or a fresh device with the QR's minimum seq |
| Replay an inbox item | Make the desktop run it twice (record-before-execute, 5.2) |
| Add a device to **its own copy** of the registry | Get a rotation wrap (the desktop's local registry is authoritative) |
| Serve a wrong key wrap | Make a device accept it (signature against the QR-pinned fingerprint) |
| Hold the PWA host (**only if the same account owns both**) | Alter the PWA from the data relay: separate origin, account and credential (7.2) |

## 5. Snapshot producer and request consumer (desktop side)

Both live in the Node core. The Mac Swift app keeps its WebSocket path until parity (kit plan invariant 7).

### 5.1 Snapshot producer

| Question | Design |
|---|---|
| What is published | A fixed **allow-listed** set of read views, one kind each (chat session list and last N turns, activity, usage and limits, auto-task and Loop status, issues read, projects, desktop status, source-control summary), starting as a subset (sync-kit S4). Nothing else. |
| Redaction | Before encryption, via the `PhoneRedaction` rules (per-line cut, secrets, paths, tokens). |
| When | On change, **debounced with random jitter**, plus a **fixed-schedule heartbeat independent of activity** (D5, M7), plus a "going offline" marker. Fixed bucket count per kind. Publishing is rate-limited. |
| Size | Capped per kind (256 KiB); truncation with a visible marker. |
| Permission | A phone access switch per kind (read kinds default on once the relay is enabled, write kinds off); re-read before every publish. A kind goes only to devices whose capability set includes it. |
| Failure | Back off, keep the local view, never block desktop work. |

### 5.2 Request consumer

The desktop drains the device queues (outbound long poll or SSE) and treats every item as untrusted.

| Step | Check |
|---|---|
| 1 | **Closed-schema validation first**: size and field limits, unknown fields rejected (not ignored), then signature and AAD, known epoch (or grace window), `senderId` in the **local registry**, device capability set includes this class. |
| 2 | **Typed request only**, from a closed list; no free-form command, path or shell string reaches a tool. |
| 3 | **Fixed read-only ceiling (D2, H2).** A remote-origin turn runs with a **remote-safe tool set**: read and search only, no shell, no writes, no network-fetching tools, no connectors that post; **never Bypass**; "Ask" resolves as **deny** when no local user answers within a short window. The desktop's own mode is irrelevant to remote turns. Raising the ceiling is a per-device setting changed on the desktop. A queued project switch changes the **phone session's** project context, never the desktop's global active project. |
| 4 | **Time**: the desktop applies its own per-class maximum age from the signed `issuedAt` (tolerance, desktop clock); a device with a wrong clock is told, not trusted. Approvals are live-only, never queued. |
| 5 | **At-most-once**: record `requestId` **before** execution in a durable table kept at least TTL plus skew; a crash between record and reply answers "failed, retry", never runs twice. Ordering: per-device sliding window or any unseen `requestId` within TTL (not strict `seq`). |
| 6 | **Budget and quota**: per-device quota (visible in the device list) and per-user cap. |
| 7 | **Reply**: encrypted, signed, expiring; typed refusal for every rejection. |

Queued classes for the PWA (low-risk only, D1): chat prompts (run under the ceiling, 3), activity-seen, phone-session project switch. Everything else is native or desktop only. Time to live: chat 24 hours, others 1 hour.

## 6. Extension (upload only, D7, M3)

The extension keeps using the local core when the desktop is on the same machine; the credentials for local mode (core JWT) and remote mode (inbox) are **different**; a leaked one is never valid as the other. In remote mode its capability set is **meeting upload only**: no snapshot or chat keys. Keys live only in the service worker or an extension page, never in a content script or anything reachable by `postMessage` from a page.

Chunked upload: each capture has a random content key wrapped under the extension's write subkey; chunk AAD carries `captureId`, `chunkIndex`, `chunkCount` (when known) and a final flag; the **final chunk carries the total count and a hash of the whole**; the desktop ingests only a **complete, in-order, hash-verified** capture. Separate blob path, caps per capture and per day, orphan cleanup after 1 day.

## 7. Phone clients

### 7.1 Tiers (D1)

| Client | Code delivery | Keys | May do |
|---|---|---|---|
| **Native iOS app** | App Store | Keychain; read, approval and write subkeys per capability set | everything the desktop switches allow from a phone |
| **PWA** | separate origin and account | **read subkeys only**, non-extractable | read snapshots; queue chat prompt, activity-seen, phone-session project switch |
| **Desktop** | signed updater | root | all |
| **Extension** | store-signed | upload subkey only | meeting upload |

Keys that can write or approve **never live in the PWA.**

### 7.2 What the signed bundle does and does not protect (C1)

The honest statement: **a web client served by the relay is only as trustworthy as the party and account serving it.** Signing the bundle protects against a compromised CDN, mirror or tampered storage that does not hold the signing path. It does **not** protect against a malicious operator of the origin: the first load comes from the origin, and a service worker script is re-fetched from the origin, so the origin can replace the verifier. The PWA is therefore **not** described as meeting "no plaintext at the relay" against a hostile operator or a PWA-host takeover; its blast radius is limited by the tiering (read subkeys only).

Requirements:

1. **Separate origin, account and deploy credential** from the data relay (mandatory), hardware-key MFA on that account, nothing else on that origin.
2. Keep the signed bundle (mirror and CDN case); the verifier is a **minimal never-changing bootstrap service worker** whose hash is **published out of band** (release notes, repository) for users and auditors; state that browsers still let the origin replace it.
3. Reproducible build, publisher key custody per 12 (M8).
4. At R6, evaluate (do not assume) browser mechanisms for integrity-pinned web apps; none is a known baseline across Safari, Chrome and Firefox.

### 7.3 Rendering untrusted output (H7)

Chat output, issue titles and ingested email or web content are untrusted. Requirements:

- Markdown rendered with **no raw HTML**; **remote images not loaded** (default off; at most a desktop-approved path later); links open with `rel="noopener noreferrer"` after an interstitial.
- CSP (a requirement, not a note): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' <relay>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`; `Referrer-Policy: no-referrer`; no inline script; no runtime third-party script.
- The service worker and IndexedDB cache **ciphertext only**, never plaintext.
- The same rules apply in the native app's views.

### 7.4 Push (M4)

Generic wake-up only; the payload carries no kind, count or title (timing itself leaks activity, M7). The relay posts to a **subscriber-supplied endpoint**, so it validates the host against an **allowlist of the browser push services** and refuses private addresses (the same pinned-fetch discipline as the core). VAPID key kept off the data path. Rate-limit pushes per device. iOS needs Home Screen install for push, and storage of a non-installed site can be evicted: enrollment must be repeatable and cheap.

## 8. Hosting options (D6 still OPEN, decide at R2)

Both can implement the same relay surface; the design keeps the **storage behind a small interface** so the choice stays reversible.

| Criterion | Small VPS running the Node relay | Cloudflare Workers with R2 (and Durable Objects for ordering) |
|---|---|---|
| Fit with the repo | Same language and runtime as the core; tested with the existing Node test runner; local dev is the production code. | Workers runtime differs from Node (web APIs; no `fs`; some Node built-ins via a compatibility layer); needs a Workers toolchain and a local emulator in CI. |
| State model | One process, SQLite or files; trivial ordered inbox; single writer, simple. | R2 for blobs; per-desktop inbox ordering and long polling want a **Durable Object** (single-threaded per id); more concepts. |
| Long-lived connections (SSE or WebSocket for the desktop drain) | Plain; one process holds them. | Possible through Durable Objects; cost and limits to verify. |
| Scale | Fixed small ceiling; enough for one organisation; a single point of failure unless you add a standby. | Elastic and multi-region by default; the scale is not needed at this size. |
| Availability | Your uptime: one host, patching, restart policy, backups, monitoring. | Provider's edge availability; you still own deployment and secrets. |
| Operations burden | Patching the OS, TLS renewal, firewall, log rotation, backups. | Little server operation; account hygiene, deploy pipeline, quota awareness. |
| Cost | A fixed small monthly fee (verify current prices). | Pay per use with a base plan (verify current prices); small at this volume. |
| Security surface | You harden the host; a bug in your code is on a machine you manage; fewer moving parts. | Provider-managed isolation and DDoS absorption; a bug is in a shared runtime; secrets in the provider's store; a provider account takeover is a full compromise. |
| Data location | You choose the region (relevant for a Japan-based company, question R9). | Provider's regions and jurisdiction settings; check what R2 and Durable Objects guarantee. |
| Lock-in | None; moves anywhere. | Workers and Durable Objects specifics; mitigated by the storage interface. |
| Push and PWA hosting | Serves both easily; Web Push library for Node. | Static assets are a natural fit; push via a Worker. |
| Time to first working relay | Short: reuse the core's server skeleton. | Longer: new runtime, new test setup. |
| Failure mode that bites | Host down or full disk: relay offline, **desktop and phone through the Mac still work**. | A deploy or quota error: same effect. |

**Recommendation (not a decision):** build the relay as plain Node behind a storage interface and run it first on **a small VPS in the region the company prefers**, because it reuses the repo's language, tests and skills, keeps the first version simple, and the relay is small (no LLM, no code). Revisit **Cloudflare Workers with R2** if the organisation does not want to operate a server, or if uptime beyond one host becomes a requirement; the interface makes that a port of one adapter. The user decides at the start of Phase R2 (question R8, MASTER-PLAN Q-WEB-2).

Added by the review: if VPS, name who provides **DDoS protection and patching** (not present by default); cap SSE and long-poll connections per token and per IP; hardware-key MFA on every host account; the PWA host is a separate account either way.

## 9. Threat model

Assets: message content, device keys, the root and subkeys, the desktop's ability to run code, the API budget, the user's reputation. Actors: honest-but-curious relay operator, malicious relay, network attacker, phone thief, laptop thief, malicious site or extension in the phone's browser, former device holder, a person who finds or photographs a QR.

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | Read content at the relay | E2E, per-kind subkeys (4.1, 4.2) | Metadata: device ids, time, size class, IPs (72 h), fixed heartbeat |
| T2 | Forge or alter a snapshot | Signatures, AAD, manifest (4.3, 4.7) | None known |
| T3 | Rollback, freeze, mix-and-match | Signed manifest with `manifestSeq`, `validUntil`, QR minimum seq, (epoch, seq) ordering, new epoch on counter loss (4.7) | Freeze is detectable, not preventable |
| T4 | Replay or reorder a request | Record-before-execute, sliding window, desktop-side age (5.2) | None known |
| T5 | Make the desktop run something it would not allow | Typed requests; **fixed read-only ceiling independent of desktop mode**; Ask resolves deny; phone-session project context (5.2) | A stolen device does what its capability set and the ceiling allow until revoked |
| T6 | Rogue device | 128-bit secret, 2-minute single claim enforced by the desktop, contested-claim alert, **SAS on both screens** (4.5) | A user who confirms blindly |
| T7 | Stolen phone | Desktop revoke, **emergency revoke by printed code (D4)**, non-extractable keys, OS lock | Data already on screen or cached; keys held until rotation |
| T8 | Revoked device keeps reading | Rotation, erase old-epoch keys, history none (4.9) | What it already decrypted; ciphertext saved earlier |
| T9 | Malicious PWA code | Tiering, separate origin and account, out-of-band bootstrap hash (7.1, 7.2) | A hostile operator of the PWA host reads what read subkeys read; stated, not hidden |
| T10 | XSS, bad dependency, supply chain | CSP, no third-party script, lockfiles, `npm ci --ignore-scripts`, pinned CI, reproducible build, SBOM (12) | Browser zero-day |
| T11 | Compromised desktop | Out of scope; hardware-bound signing key where available | Everything the desktop holds |
| T12 | DoS | Per-device queues, connection caps, per-IP and per-slot limits, identical errors | Relay offline; desktop and loopback unaffected |
| T13 | Cost abuse | Per-device and per-user quotas shown on the desktop | Up to the cap |
| T14 | Push content leak | Generic payload | Push provider sees that a push occurred |
| T15 | Traffic analysis | Padding, opaque per-epoch kind ids, fixed heartbeat, jitter | Timing and size classes; cover traffic and mixnets out of scope |
| T16 | Weak randomness, nonce reuse | Platform CSPRNG, one key per (epoch, kind, sender), 2^24 cap, no device counter nonces, vectors | Implementation bug; hence G-EXT |
| T17 | Registry breach | Token hashes, wraps useless without device keys | Device list exposed |
| **T18** | Key substitution at wrap | Signed wrap checked against the QR fingerprint, epoch strictly greater, key confirmation (4.4) | None known |
| **T19** | Rogue device injected at rotation | Desktop local registry authoritative, mismatch shown (4.6) | None known |
| **T20** | Admin token theft | Signed admin operations, sender-constrained device requests, hardware-bound key (4.8) | Software-keychain key on Linux |
| **T21** | Exfiltration through rendered content | No raw HTML, no remote images, CSP (7.3) | Browser bug |
| **T22** | QR exposed by screen-share or URL logs | Click-to-show, capture exclusion, fragment-only secret, `replaceState`, 2 minutes, SAS (4.5) | Screen-share capture on an OS that ignores the exclusion |
| **T23** | Push endpoint SSRF | Host allowlist, private addresses refused, pinned fetch (7.4) | None known |

Out of scope and stated: a compromised desktop, a compromised phone OS, physical coercion, quantum adversaries (a post-quantum wrap can replace the ECDH step without changing the envelope), formal protocol verification (the external review reads the written spec).

## 10. Phases and exit gates

Every phase ships only when its exit gate, its independent review (Sonnet reviews security code, Fable the final review) and the pre-push gate are green. Nothing starts before the Phase 0 closing items and ADR 0018 Accepted. R0 and R1 may run earlier (specification and a no-network library).

**Release gate G-EXT (D9).** An **independent external review** of the written spec and the R1, R3 and R4 implementation must be completed, and its findings resolved or accepted in writing, **before the relay or the PWA is exposed to any network beyond loopback or a private test network.** Internal review does not satisfy it. R2 may be built and tested locally; the public deploy in R8 and the PWA in R6 do not go public before G-EXT.

| Phase | Work | Exit gate |
|---|---|---|
| **R0 Specify** | `schema/http` relay group; the byte-exact spec for envelope, canonical encoding, wrap, manifest, enrollment, registry, admin signing, revoke and emergency revoke; capability tiers; remote-safe ceiling definition; rendering rules; the primitives table frozen with sizes and KDF parameters; D6 prerequisites named. | Contract gates pass; reviewer signs off; every row of section 14 maps to a spec clause; the spec is frozen for G-EXT. |
| **R1 Crypto library** | Library in TypeScript (and a parallel iOS check) with committed **crypto test vectors**: AES-GCM, HKDF subkey derivation, ECDSA P1363, HPKE or explicit wrap, canonical encoding, SAS, fingerprint; browser support verified (ECDSA P-256, AES-GCM, HKDF, non-extractable keys, optionally Ed25519). | Vectors pass in Node, a browser engine and iOS; **negative tests** (wrong key, wrong AAD, flipped bit, truncated tag, wrong epoch, wrong version, wrong context, nonce cap refusal, two senders never share a key) all fail closed; Wycheproof-style negatives where available; internal crypto review. |
| **R2 Relay core** | Relay against fake desktop and fake devices: per-user accounts, per-device queues with fair drain, caps, slots with identical errors, manifest and blob storage, push allowlist, signed-admin verification, emergency-revoke endpoint, connection caps. **D6 decided at the start.** | Integration suite green; **relay-blindness test on storage and logs** (no plaintext markers, tokens, secrets or fragments); limits and load; restart recovery; **rogue-relay suite** (section 11) green against the library. Local only (G-EXT). |
| **R3 Desktop producer and consumer** | Behind a default-off flag: producer with manifest, jitter and fixed heartbeat; consumer with closed schema, at-most-once table, remote-safe ceiling, per-device quotas. | Permission matrix (every request class against every switch and every desktop mode, including Bypass, and a switch flipped between queue and run); Ask-no-answer denies; idempotency and crash tests; redaction; flag off means zero outbound traffic. |
| **R4 Enrollment, revoke, rotation** | QR enrollment with SAS on both screens, contested-claim alert, local signed registry, signed wraps with key confirmation, revoke, **emergency revoke with rotate-first**, rotation, old-epoch key erasure, signing-key rotation, counter-loss new epoch. | The **negative-test list** (section 11) green; end-to-end: enroll two devices, revoke one, rotate, revoked device cannot read new data, the other can; no secret in any log; internal review. |
| **R5 Extension upload-only** | Upload subkey, chunked complete-or-nothing upload, separate credentials, blob path and quotas. | Truncated, reordered, duplicated and hash-mismatch captures are not ingested; the extension's keys cannot decrypt a chat snapshot; offline-desktop run ingests exactly once; extension stores nothing after ack. |
| **R6 Phone clients** | PWA (separate origin and account) and native tier: read subkeys, low-risk queue, bootstrap service worker with published hash, rendering rules, CSP, staleness UI. | Real iPhone and Android run by the user (`(you)`); the PWA key set cannot sign a write request; hostile content (image URL, HTML, script tag) renders inert with no network request; CSP and SRI checks; reproducible-build check; accessibility pass. Not public before G-EXT. |
| **R7 Push** | Allowlisted Web Push, generic pings. | Private-address and non-allowlisted endpoints refused; delivery on a real device; payload content-free (checked). |
| **R8 Deploy and monitoring** | Pipeline, registry-only backups, monitoring, runbook, secret rotation, hardware-key MFA accounts, publisher-key custody and rotation statement, SBOM, pinned CI. | **G-EXT closed first**; clean deploy and rehearsed rollback; alert fires on forced failure. |
| **R9 Parity and retire** | Supported subset at parity with the Mac WebSocket path; retire `:3006` and PIN. | One release with both; user signs off; invariant 7 replaced by relay checks. |

No estimate is given: no gate is compressed to hit a date.

## 11. Test plan

| Layer | What | How |
|---|---|---|
| Crypto unit and vectors | Round trips and known-answer vectors for every primitive and the canonical encoding | Committed vectors in Node, browser and iOS |
| Spec conformance | Relay routes and envelopes | `schema/http` fixtures; `make contract-gates` |
| Relay integration | put, get, drain, ack, TTL, ordering, limits, auth failures, revoked token, fair drain, connection caps | In-process, loopback only |
| Relay-blindness | After a full scenario scan stored bytes **and logs** (relay and proxy) for markers, tokens, secrets and URL fragments | Automated, must find none |
| Permission matrix | Every request class against every switch and every desktop mode (Ask, Accept Edits, Bypass) | Table-driven |
| Failure injection | Relay down, desktop off, crash mid-request, restart, partial upload | Deterministic |
| Content safety | Snapshot with image URL, HTML and script renders inert, no network request | Browser automation |
| No regression | `make regression`, `make test-shared-protocol`, `make build-mac-mobile-only` | Existing gates |

### 11.1 Negative-test list (each a named test that must fail closed)

| Test | Finding |
|---|---|
| **Rogue relay**: relay-created wrap of a chosen key rejected; wrap with non-greater epoch rejected | C2 |
| **Rogue relay**: relay-served PWA code cannot be detected by the signature, documented; PWA key set holds no write or approval subkey | C1, H3 |
| **Rogue-device injection**: rogue key added to the relay registry is never wrapped to at rotation | C3 |
| **Rollback**: older snapshot, older manifest, fresh device served old state (QR minimum seq), desktop counter loss leads to a new epoch | H6 |
| **Swap**: kind swapped, device swapped, reply of device A offered to device B, cross-install replay (AAD userId, desktopId) | M1 |
| **Mix-and-match**: kind A from Tuesday with kind B from Friday rejected; freeze past `validUntil` surfaced | H6 |
| **Replay**: duplicate `requestId`, replay after a crash between record and reply, expired item, device with wrong clock | M2 |
| **Stale device after revoke**: revoked token rejected, old-epoch request outside the grace window rejected, old-epoch keys erased | H1, M10 |
| Emergency revoke with the desktop off, then rotate-before-publish on next start | H1 |
| Two claims on one slot: slot dies, alert, no key issued; SAS mismatch blocks confirmation; expired and replayed slots rejected by the desktop though the relay says valid; secret never in a URL path, query or log | H4 |
| Remote-safe ceiling: queued prompt with the desktop in Bypass still uses the read-only tool set; Ask unanswered denies; project switch does not move the desktop's active project | H2 |
| Capability subset: extension keys cannot decrypt a chat snapshot | H3, M3 |
| Chunked upload: truncated, reordered, duplicated, hash-mismatch not ingested | M3 |
| Admin token alone cannot revoke or edit the registry; device token alone cannot submit a request | H5 |
| Push endpoint private or non-allowlisted refused | M4 |
| Nonce budget: beyond 2^24 refuses; two senders never share a key | M1 |

## 12. Operational requirements (M5, M6, M8, L1 to L5)

- **Logging**: bearer tokens only in `Authorization`; enrollment secrets only in the URL fragment; proxy access logs, crash dumps and error pages capture no header or body; the desktop never logs decrypted requests or replies (reuse `MobileLogPolicy`).
- **Supply chain**: the publisher key is hardware-backed or offline (or keyless signing bound to CI identity with an auditable log) with a **rotation statement signed by the old key**; lockfiles and `npm ci --ignore-scripts`; CI actions pinned by commit; reproducible build; SBOM published; no runtime third-party script in the PWA; minimal dependencies in the relay (push library and body parsers).
- **Accounts**: hardware-key MFA on every host account, separate deploy identity for the PWA host, no shared credentials.
- **Transport**: HTTPS only, TLS 1.3 preferred, HSTS, desktop connects with redirects refused through the pinned-fetch discipline; **no certificate pinning** (content is E2E; pinning could brick the desktop).

## 13. Open questions for the user

Resolved by the delegation (D1 to D5, D7 to D9) and by the earlier R-questions: R1 yes, R3 and R4 as in section 5.2, R5 none (D3), R6 tiered (D1), R7 generic, R10 latest only with 7-day queues and 72-hour IPs, R11 accepted with fixed heartbeat, R12 upload only (D7). Remaining:

| # | Question | Recommendation |
|---|---|---|
| **D6 (R8, R9)** | Relay host: small VPS (Node) or Cloudflare Workers and R2, plus company-owned domain, region and a named account owner. **Decide at the start of R2.** | VPS first behind a storage interface, in the company's preferred region, with hardware-key MFA; the PWA host a separate account. |
| X1 | How does a user log in to the relay account (D8 individual login)? | No password at the relay: the account is created by the desktop at setup and bound to its public signing key; devices authenticate by enrollment and signed requests. Specify in R0; tell me if you want an additional login factor. |
| X2 | Who pays and schedules the external review (G-EXT)? | Book it during R0 so the spec freeze and the review window line up. |

## 14. Finding to design-change traceability

All 25 findings of the [security review](2026-10-31-relay-security-review.md) are adopted; none is declined. Where a recommendation was partly narrowed, the reason is written.

| Finding | Design change | Section | Adopted |
|---|---|---|---|
| C1 PWA code trust | Reworded T9 and 7.2; tiered clients; separate origin, account, credential; bootstrap service worker with out-of-band hash; browser-integrity evaluation at R6 | 7.1, 7.2, 9, 10 | Yes |
| C2 Unauthenticated wrap | Signed wrap object, HPKE-style AAD, QR-fingerprint check, epoch strictly greater, key confirmation | 4.2, 4.4 | Yes |
| C3 Relay-supplied device list | Desktop local signed registry authoritative; relay copy advisory; signed registry operations | 4.6 | Yes |
| H1 Lost phone, desktop off | Printed revoke code, token kill, rotate-first, explicit order | 4.9 | Yes (D4) |
| H2 Inherited permission mode | Fixed read-only ceiling, Ask resolves deny, phone-session project context | 5.2 | Yes (D2) |
| H3 Flat key | Root, per-purpose subkeys, per-device capability sets | 4.1 | Yes |
| H4 QR enrollment | claim/bind/sas derivation, SAS on both screens, contested-claim alert, click-to-show, capture exclusion, fragment, 2 minutes, desktop-enforced single use | 4.5 | Yes |
| H5 Admin token theft | Signed admin operations, sender-constrained device requests, hardware-bound key | 4.8, 4.2 | Yes |
| H6 Rollback and freeze | Signed manifest, `manifestSeq`, `validUntil`, QR minimum seq, (epoch, seq), new epoch on counter loss | 4.7, 4.3 | Yes |
| H7 Untrusted rendering | No raw HTML, no remote images, CSP, ciphertext-only caches | 7.3 | Yes |
| M1 AEAD, nonce, AAD | One key per (epoch, kind, sender), 2^24 cap, no device counter nonces, full AAD, canonical encoding, ECDSA P-256 P1363, mandatory signatures, derived kind ids | 4.1 to 4.3 | Yes |
| M2 Consumer semantics | Record-before-execute, desktop-side age, sliding window, closed schema, per-device quota | 5.2 | Yes |
| M3 Extension and chunks | Upload-only capability, keys only in service worker, complete-or-nothing chunks, separate credentials, blob path | 6 | Yes (D7) |
| M4 Web Push | Endpoint allowlist, private addresses refused, VAPID off data path, rate limit, content-free payload | 7.4 | Yes |
| M5 DoS and quotas | Per-device queues, fair drain, caps, connection caps, identical errors, blob quotas, DDoS owner named | 2.1, 2.2, 8 | Yes |
| M6 Logging | Header-only tokens, fragment-only secrets, no header or body capture, 72-hour IPs, log scan test | 2.2, 12, 11 | Yes (D5) |
| M7 Metadata | Fixed-schedule heartbeat, jitter, fixed bucket count; leaks listed; cover traffic out of scope | 5.1, 9 | Yes (D5) |
| M8 Supply chain | Hardware-backed publisher key, rotation statement, lockfiles, pinned CI, reproducible build, SBOM, MFA accounts | 12, 10 | Yes |
| M9 Recovery | No recovery in v1; future form recorded | 4.2 | Yes (D3) |
| M10 Revoked device and forward secrecy | History none, old-epoch key erasure, registry-only backups, grace window, no ratchet (reason: complexity for a threat revocation already addresses, as the review itself advises) | 4.9 | Yes |
| L1 TLS | HTTPS, TLS 1.3, HSTS, redirects refused, no certificate pinning | 12 | Yes |
| L2 Tokens | 256-bit, hashed, constant-time, idle and hard expiry, last-seen | 4.2 | Yes |
| L3 Randomness | Platform CSPRNG, `Math.random` lint ban, vectors and Wycheproof negatives | 4.2, 10 | Yes |
| L4 Fingerprints | Full SHA-256 of SPKI, 256 bits in the QR, grouped display | 4.2 | Yes |
| L5 Time | No dependence on relay clock; skew window surfaced | 4.2, 5.2 | Yes |

The review's "Corrections to the design text" 1 to 9 are applied: nonce row (4.2), enrollment hashes (4.5), signature on the wrap (4.4), registry and emergency revoke (4.6, 4.9), 7.2 and T9, T6 SAS, T3 manifest, T5 ceiling, and threats T18 to T23.
