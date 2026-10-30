# Relay design: encrypted snapshots, inbox, phone web view

Status: **design, not started. No code, no host chosen, no decision taken.** Date: 2026-10-31, at `main` (`de8d51e8`). Parents: [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md) (decisions 4 and 5, status "proposed"), [Tauri desktop and relay plan](2026-10-24-tauri-desktop-and-relay.md) (sections 3, 8, 9), [sync-kit K0 map](../../kits/sync-kit.md), [MASTER-PLAN](../MASTER-PLAN.md) (S3, S4, Security), [data-lifecycle](../../kits/data-lifecycle.md). Nothing here was run or measured; every number marked "proposed" is a starting value for review, not a result.

## 0. What the user already decided

| Date | Decision | Source |
|---|---|---|
| 2026-10-30 | The web app is the **relay-served phone web view (PWA), built last, inside sync-kit** (Q-WEB-1 = A). | MASTER-PLAN S4 |
| 2026-10-30 | **The phone through the Mac is enough for now** (Q-WEB-3). Phone-without-Mac comes later. | MASTER-PLAN S3 |
| 2026-10-30 | **Relay hosting is decided later**, with the relay work (Q-WEB-2). This document compares options and recommends; it does not decide. | MASTER-PLAN S4 |
| 2026-10-24 | The relay holds **no plaintext**, makes **no LLM calls**, runs **no code**; devices hold individual revocable tokens; revoking a device rotates the key; inbox requests are re-checked by the desktop's own permission rules. | ADR 0018, plan section 8 |

**Gating:** ADR 0018 becomes Accepted only after the Phase 0 closing items (user-run bench, one Windows run). MASTER-PLAN says nothing in Tauri K3 or the relay **starts before that**. This document is design only and may be reviewed now; the phases in section 10 are ordered behind that gate and behind the kits the relay mirrors.

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
Phone PWA / native app          Extension (remote mode)
        |  HTTPS                        |  HTTPS
        v                               v
   +------------------ Relay (always on) ------------------+
   |  device registry (token hashes)   snapshot store      |
   |  inbox (per desktop)              outbox (replies)    |
   |  enrollment slots                 static PWA bundle   |
   |  push sender (generic ping)       NO plaintext, NO LLM|
   +------------------------^------------------------------+
                            |  outbound HTTPS/SSE only
                  Desktop (main worker): Node core
                  snapshot producer + request consumer
                  holds team key, desktop signing key
```

Three kinds of client authenticate to the relay with three kinds of bearer token: **desktop** (one, admin-class, can write snapshots and drain the inbox), **device** (one per phone or browser, can read snapshots, write inbox, read its own replies), and an **enrollment token** (single use, short life, section 4.3). The relay stores only token **hashes** (the Mac already does this for paired devices: `MobilePairedDeviceStore` keeps a SHA-256 only).

### 2.1 Relay surface (to be specified in `schema/http`, group "relay (new)")

Names are proposals; the group does not exist yet.

| Area | Operations | Who | Notes |
|---|---|---|---|
| Snapshots | put a snapshot by `kind` and `epoch`; get latest (conditional on `seq`); list kinds | put: desktop; get: device | Latest only plus a small history (question R10). Opaque blob plus a clear envelope (section 4.4). |
| Inbox | put a request; drain (long poll or SSE); ack | put: device; drain and ack: desktop | Ordered per desktop; each item has `requestId`, `deviceId`, `seq`, `expiresAt`. |
| Outbox | put a reply for a request; get replies for me | put: desktop; get: device | Replies are encrypted like snapshots and expire. |
| Devices | begin enrollment; complete enrollment; list; revoke | begin and revoke: desktop; complete: new device with the enrollment token | Revoke deletes the device's token hash and its wrapped key; section 4.5. |
| Keys | publish wrapped team key for a device and epoch; fetch mine | publish: desktop; fetch: device | The relay stores wrapped keys it cannot open. |
| Push | register a web push subscription; send a generic ping | register: device; send: relay on a desktop event | Payload carries no content (question R7). |
| App | serve the versioned PWA bundle | public | Section 7; the sensitive part of the whole design. |
| Health | liveness and version | public | No data. |

All routes are HTTPS only, rate-limited per token class, and bounded in body size (proposed: snapshot 256 KiB, request 16 KiB, reply 256 KiB). Reuse the existing core's request limits and error envelope style so the contract tooling (`make contract-gates`, fixtures) applies unchanged.

### 2.2 What the relay stores

| Item | Plaintext at the relay? | Retention (proposed) |
|---|---|---|
| Snapshot blob | no (ciphertext) | latest per kind, plus none or one prior |
| Wrapped team keys | no (wrapped to a device key) | until the device is revoked or the epoch is retired |
| Inbox and outbox items | no (ciphertext) | until acked or `expiresAt`, 7 days maximum |
| Device registry | token hash, device id, public keys, label, last seen | until revoked |
| Enrollment slots | enrollment-token hash, expiry | 5 minutes |
| Push subscriptions | endpoint and keys the browser issued | until revoked |
| Logs | request metadata only (time, route, token class, size, status); never bodies | 14 days |

## 3. Interaction with the one-copy rule

[data-lifecycle](../../kits/data-lifecycle.md) rule 1 says each kind of data has **one durable home** and the web is a connector. A snapshot is a **derived, encrypted, replaceable copy** of data whose home stays on the desktop; deleting the relay loses nothing that the desktop cannot republish. Readings that must be confirmed by the user (question R1): snapshots are an allowed cache like the rebuildable search index (rule 4), not a duplicate. The queued **inbox** is the only data that can exist *only* at the relay for a while (a request made while the desktop was off); it is short-lived, TTL-bound, and its loss is a dropped request, not lost data.

## 4. End-to-end crypto design

Design for **review**, not implementation. Primitives are chosen from what the **Web Crypto API** provides in current browsers, because the PWA must run them without native code; the desktop uses the matching Node `crypto` functions. No home-grown primitive anywhere.

### 4.1 Keys

| Key | Type | Lives where | Purpose |
|---|---|---|---|
| **Team key** `K_team[epoch]` | random 256-bit symmetric key (AES-256-GCM) | desktop (OS keychain); each enrolled device, wrapped | encrypts snapshots, requests, replies for that epoch |
| **Desktop signing key** | ECDSA P-256 | desktop keychain; public part pinned at every device at enrollment | signs snapshots and replies so a device can detect tampering, replay of old epochs, and rollback |
| **Device keypair** | ECDH P-256 (key agreement) and ECDSA P-256 (signing), generated on the device | device, **non-extractable** `CryptoKey` in IndexedDB (PWA) or the Keychain (native) | receives the wrapped team key; signs its requests |
| **Wrap key** | derived per (desktop ephemeral key, device public key) through ECDH then HKDF-SHA-256 | never stored | wraps `K_team` for one device |
| **Enrollment secret** | 128-bit random | in the QR code only; relay holds its hash | authorises one enrollment, once |

"Team key" follows ADR 0018's wording; whether the set of holders is one user's devices or a company team is question R2. The mechanics are identical.

### 4.2 Message format (all kinds)

Every snapshot, request and reply is an **envelope**: a clear header the relay can route on, plus an AES-256-GCM ciphertext. The header fields are bound into the ciphertext as **additional authenticated data (AAD)** so the relay cannot move a blob to another kind, device, epoch or sequence number.

| Field | Clear | In AAD | Why |
|---|---|---|---|
| `kind` (opaque id, not a readable name; question R11) | yes | yes | routing; prevents cross-kind substitution |
| `epoch` | yes | yes | which team key |
| `seq` (monotonic per sender and kind) | yes | yes | replay and rollback detection |
| `senderId` (`desktop` or a device id) | yes | yes | attribution and per-device permission |
| `requestId` (requests and replies) | yes | yes | idempotency; reply to request binding |
| `expiresAt` | yes | yes | TTL enforced by the receiver, not only the relay |
| nonce (96-bit, random per message) | yes | n/a | GCM nonce; random nonces are safe at this volume under one key (the nonce-collision bound is far above the planned message count; rotate by epoch, which also bounds it) |
| ciphertext and tag | yes (opaque) | n/a | content |
| signature (ECDSA P-256 over header plus ciphertext) | yes | n/a | authenticity beyond "someone who knows the team key" |

Padding: plaintext is padded to a size bucket (proposed 1, 4, 16, 64, 256 KiB) so the relay learns an upper-bound size class, not exact sizes (question R11).

### 4.3 Enrollment by QR code (desktop to new device)

1. The user opens **Settings, Phone and devices** on the desktop and chooses "Add a device". The desktop asks the relay to open an **enrollment slot** and receives an enrollment token id.
2. The desktop shows a **QR code** containing: relay base URL, the enrollment secret, the slot id, the SHA-256 **fingerprint of the desktop's public signing key**, and the current epoch. The code lives 5 minutes and works once. (The Mac's existing QR is `llmide://pair?...`; the format changes, the user gesture does not.)
3. The device scans it, generates its **device keypair** locally, and sends the relay its two public keys with a **proof of possession of the enrollment secret** (an HMAC over its public keys, keyed by the secret). The relay checks the proof against the stored hash and marks the slot "claimed". The secret never goes to the relay in clear.
4. The desktop, which is **waiting on the slot** (or is notified), fetches the claimed public keys, **shows the device label and a short verification code on screen and asks the user to confirm** (a human check that the scanner is the intended phone). On confirmation it derives the wrap key (desktop ephemeral ECDH with the device's key agreement public key, then HKDF), wraps `K_team[epoch]`, and publishes the wrapped key and the desktop's public signing key to the relay for that device.
5. The device fetches its wrapped key, unwraps it, **verifies the desktop signing key matches the fingerprint from the QR**, and stores everything non-extractably. The relay issues the **device bearer token** at this point (returned once, hash stored).

The QR channel is out-of-band and local, so a relay that is malicious or compromised **cannot substitute its own keys** during enrollment: the fingerprint in the QR pins the desktop key, and the user confirms the device on the desktop.

### 4.4 Snapshot producer to device (read path)

Desktop serialises the view, redacts it (section 5), pads it, encrypts it under the current `K_team`, signs it, and puts it. The device fetches the latest, **checks the signature against the pinned desktop key, checks `epoch` is one it holds, checks `seq` is not lower than the highest it has seen** (rollback defence), decrypts, and shows the result with its `producedAt`, so the UI can say "as of 3 hours ago, desktop offline".

### 4.5 Revocation and rotation

| Event | Action |
|---|---|
| User revokes a device on the desktop | Relay deletes the device's token hash, public keys, wrapped keys and push subscription. Desktop starts a **new epoch**: generates `K_team[epoch+1]`, wraps it to every **remaining** device, publishes, and from then on encrypts only under the new epoch. |
| After rotation | Old snapshots are **republished** under the new epoch (the desktop is the home, section 3) and the old ones are deleted at the relay. Old inbox items from the revoked device are dropped (the desktop refuses a `senderId` no longer registered). |
| Remaining devices | They fetch their new wrapped key on next contact; until then they can read only old-epoch data they already hold. |
| Suspected compromise of the desktop | Rotate the signing key as well: every device must re-enroll (QR). There is no recovery by the relay. |
| Scheduled rotation (optional) | Same flow on a timer (proposed: every 90 days); it also bounds the AES-GCM nonce budget. |

What revocation does **not** do: it cannot un-read what the revoked device already decrypted. Stated in the threat model.

### 4.6 What a malicious relay can and cannot do

| Can | Cannot |
|---|---|
| Refuse service, delay, drop messages | Read content |
| See device ids, kinds (opaque), time, size class, IP addresses | Forge a snapshot or reply (needs the desktop signing key) |
| Serve an old snapshot (rollback) | Make the rollback go undetected once a device has seen a higher `seq` |
| Replay an inbox item | Make the desktop run it twice (idempotency by `requestId`, receiver-side expiry) |
| Serve a malicious PWA bundle (**the open problem, section 7.2**) | Add a device without the QR secret and the user's confirmation on the desktop |

## 5. Snapshot producer and request consumer (desktop side)

Both live in the **Node core** (the desktop's main worker). The Mac Swift app keeps its current WebSocket path until parity (kit plan invariant 7); during the overlap the producer reads from the same core routes the Mac already uses.

### 5.1 Snapshot producer

| Question | Design |
|---|---|
| What is published | A fixed, **allow-listed** set of read views, one `kind` each: chat session list and the last N turns of recent sessions, activity feed, usage and limits, auto-task and Loop status and last runs, issues list (read), project list, desktop status (`mac_status` equivalent), source-control summary. Anything not on the list is never published. The list tracks the wire tags the phone uses today (`MobileProtocol.swift`) but starts as a subset (sync-kit question S4). |
| Redaction | Before encryption, through the same rules the phone gets today (`PhoneRedaction`: per-line cut so a huge token cannot stall the regex; secrets, paths outside the project, tokens). Redaction is **not** moved to the relay: the relay never sees plaintext. |
| When | On change (debounced), on a heartbeat (proposed 10 minutes), and on desktop shutdown ("desktop going offline" marker with `producedAt`). |
| Size | Capped per kind (proposed 256 KiB); a view that would exceed the cap is truncated with a visible marker, never silently. |
| Permission | Each `kind` is behind a **phone access switch** analogous to `PhoneAccessSettings` (read kinds default on once the user enables the relay, write kinds default off). The producer re-reads the switch before every publish. |
| Failure | Relay unreachable: back off, keep the latest local view, retry; never block desktop work. Publishing is best-effort, like the Loop journal's fail-open contract. |

### 5.2 Request consumer

The desktop **drains** the inbox (outbound long poll or SSE, so no inbound port) and treats every item as **untrusted input**, even though it decrypted and verified.

| Step | Check |
|---|---|
| 1 | Verify signature and AAD; reject an unknown epoch, a `senderId` not in the registry, an expired item, or a `seq` not above the device's last. |
| 2 | **Typed request only.** The plaintext is a typed object from a closed list (the wire tags the Mac already accepts from a phone). Unknown type: typed refusal reply. There is **no** free-form command, path or shell string that reaches a tool. |
| 3 | **Permission re-check at execution time**, never at queue time: the matching phone access switch is read now; the request's tool or edit class goes through the desktop's own mode (Ask, Accept Edits, Bypass) and its project-scoped prefix rules (the Claude-style permissions already in the app); a Loop start or edit needs whatever local approval the desktop requires. Defaults mirror today: anything that edits files, posts as the user or approves a tool is **off** (Mobile CLAUDE.md rules). |
| 4 | **Staleness policy:** a queued request older than its class's time to live is dropped with a reply "expired while the desktop was off" (question R4). Approvals are **live-only**: an approval request from the desktop to the phone is never queued for later, and an approval answer arriving after the prompt expired is ignored. |
| 5 | **Idempotency:** `requestId` is recorded; a replay returns the earlier reply, it does not run again. |
| 6 | **Budget:** a request that starts model work is metered under the requesting device's user and subject to the same per-user caps (ADR 0018 decision 5). |
| 7 | **Reply:** encrypted, signed, expiring; includes a typed refusal reason for every rejection so the phone screen never spins (existing rule: "replies must be shaped for the phone's pending request"). |

What may be queued while the desktop is off is a decision for the user (question R3); the recommended set is: chat prompts, marking activity seen, and project switch requests; **no** file edits, no Loop or Auto Task start, no tool approvals, no dispatch.

## 6. Extension in remote mode

The extension keeps using the local core when the desktop is on the same machine (ADR 0018 "what works in each state"). In remote mode it behaves as another **device**: it enrolls by QR (or a desktop-issued enrollment code), holds a non-extractable key in the browser, reads snapshots, and queues the **one** write the plan allows while the desktop is off: **recording a meeting and uploading it** (ADR 0018). That upload is a large payload: it is sent as encrypted **chunks** through the inbox with a `requestId` per capture, and the desktop reassembles and ingests when it is back. The extension still stores nothing once the upload is acked (data-lifecycle R1). Question R12.

## 7. Phone web view (PWA) served by the relay

Built **last** (user decision), after the relay, the producer and consumer, and the Tauri screens it reuses (ui-kit components in React).

### 7.1 Behaviour

- Installable web app; screens mirror the phone's current tabs: chat, explorer-lite (read), activity, usage, auto-task and Loop status, issues (read), approvals (live only).
- Keys are **non-extractable** `CryptoKey` objects in IndexedDB; the page never has the raw key bytes. Decryption happens in the page or a worker.
- Offline: the service worker caches the app shell and the last snapshots (encrypted at rest by the browser store only; see risk list for what browser storage does not protect).
- Web Push for "something happened" pings. Payload is a generic wake-up, content is fetched and decrypted after opening (question R7). iOS requires the app to be added to the Home Screen for push; browser storage for a non-installed site can be evicted after a period of non-use: enrollment must be repeatable and cheap.

### 7.2 The central weakness: relay-served code handles keys

If the relay serves the JavaScript that holds the keys, a **compromised or malicious relay can serve a modified app that exfiltrates them**, which defeats "no plaintext at the relay" for that device. End-to-end encryption in a web app served by the party it protects against is only as strong as the delivery of the code. This is the most important finding of this design; ADR 0018 does not say it.

| Mitigation | What it buys | Cost |
|---|---|---|
| **Signed bundle**: the PWA is built in CI and **signed with a publisher key pinned at enrollment** (in the QR, next to the desktop key fingerprint); the service worker verifies the signature of each app update before activating it. | A relay cannot push a modified bundle to an already-enrolled device. | A small verifier in the service worker; a release process with a signing key. The **first** load of an install is still trusted (TOFU, narrowed by the QR carrying the publisher key). |
| Strict CSP, no third-party scripts, Subresource Integrity on every asset, no inline script, `Trusted Types` | Smaller injection surface. | Build discipline. |
| Serve the PWA from a **different origin and operator** than the data relay (static hosting) | A data-relay compromise alone does not change the app. | A second thing to run; same trust problem if one account owns both. |
| Keep the **native iOS app** as the high-assurance client (keys in the Keychain, code from the App Store) | Strongest option for people who need it. | Maintaining it (sync-kit question S1). |
| Make the keys **device-bound and non-extractable** | A stolen browser profile file cannot export them. | None for the design; limited by the browser. |

Recommendation: signed bundle with the publisher key pinned at enrollment, strict CSP and SRI, and keep the native app available until the PWA has run in use (question R6). The residual first-load risk is stated to the user, not hidden.

## 8. Hosting options (recommendation, not a decision)

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

## 9. Threat model

Assets: message content (chat, files names, issues), device keys, the team key, the desktop's ability to run code, the user's API budget, the user's reputation through actions taken in their name.

Actors: honest-but-curious relay operator, malicious relay (compromised host or account), network attacker, thief of a phone, thief of a laptop, malicious website or extension in the phone's browser, a former device holder, a person who finds an unattended QR code.

| # | Threat | Actor | Mitigation | Residual |
|---|---|---|---|---|
| T1 | Read content at the relay | operator, attacker | E2E AES-GCM, no keys at the relay (4.2) | Metadata: device ids, time, size class, IPs |
| T2 | Forge or alter a snapshot | relay | Signatures from the pinned desktop key; AAD binding (4.2) | None known for content |
| T3 | Roll back to an old snapshot | relay | Monotonic `seq`; devices keep high-water mark (4.4) | A device with no prior state cannot detect staleness; UI shows `producedAt` |
| T4 | Replay or reorder an inbox request | relay | `requestId` idempotency, per-device `seq`, `expiresAt` checked by the desktop (5.2) | None known |
| T5 | Cause the desktop to run something it would not allow | relay, stolen device | Typed requests only; permission re-check at execute time; switches default off for writes; approvals live-only (5.2) | A stolen **enrolled** device can do what its switches allow until revoked; keep write switches off |
| T6 | Add a rogue device | relay, QR finder | QR secret single-use and 5-minute life; desktop shows device label and verification code and requires user confirmation (4.3) | A user who confirms blindly |
| T7 | Stolen phone | thief | Revoke from the desktop (4.5); non-extractable keys; OS lock; optional in-app lock | Data already shown on screen or cached decrypted |
| T8 | Revoked device keeps reading | former holder | Epoch rotation, wrapped key deleted (4.5) | Content it already decrypted; snapshots under the old epoch it saved |
| T9 | Malicious PWA code from the relay steals keys | malicious relay | Signed bundle, CSP, SRI, publisher key pinned at enrollment (7.2) | First-load trust; browser bugs; the native app is stronger |
| T10 | XSS or a bad dependency in the PWA | network, supply chain | No third-party scripts at runtime, locked dependencies, CSP, review (plugin hash-pinning is already a project rule) | Zero-day in the browser |
| T11 | Compromised desktop | malware | Out of scope of the relay design; local keychain, Workspace Trust | Everything the desktop holds; rotate signing key and re-enroll (4.5) |
| T12 | Denial of service on the relay | network | Per-token rate limits, body caps, small payloads, provider-level protection | Relay offline: desktop and loopback unaffected; phone shows last snapshot |
| T13 | Cost abuse (a device queues many model-backed chats) | stolen device | Per-user caps and device quotas on the desktop (5.2 step 6) | Up to the cap |
| T14 | Push content leak | relay, push provider | Generic push payload (7.1) | Push provider sees that a push occurred |
| T15 | Traffic analysis | relay | Padding to size buckets; opaque `kind` ids | Timing correlation remains |
| T16 | Weak randomness or nonce reuse | implementation | Only platform CSPRNG; per-epoch nonce budget; known-answer tests (section 11) | Implementation bug; hence review |
| T17 | Relay data breach of stored registry | attacker | Token hashes only; wrapped keys useless without device private keys | Device list and labels exposed (low value) |

Out of scope and stated: a compromised desktop, a compromised phone OS, physical coercion, and quantum adversaries (P-256 and AES-256 are used; a post-quantum wrap can replace the ECDH step later without changing the message format).

## 10. Phases and exit gates

Every phase ships only when its exit gate, its independent review (Sonnet reviews security and money code, Fable for the final review, per MASTER-PLAN) and the pre-push gate are green. Nothing starts before the Phase 0 closing items and ADR 0018 Accepted. The relay phases run **after** the kit moves they mirror, with R0 and R1 allowed earlier because they are specification and a library with no network.

| Phase | Work | Exit gate |
|---|---|---|
| **R0 Specify** | Relay group in `schema/http` (routes, envelopes, error codes, fixtures); the envelope and enrollment formats as a versioned spec; this document's open questions answered. | Contract gates pass on the new group; reviewer signs off the spec; questions R1 to R12 answered or explicitly deferred. |
| **R1 Crypto library** | Small TypeScript library for envelope seal and open, key wrap, signatures, epochs, size buckets, using only platform crypto; **known-answer test vectors** committed; runs in Node and in a browser test. | Vectors pass in Node and in a browser engine; tamper, wrong-AAD, wrong-epoch, truncation and replay tests fail closed; independent crypto review. |
| **R2 Relay core** | Relay service (storage interface, device registry, tokens, enrollment slots, snapshots, inbox, outbox, limits) against **fake desktop and fake device** clients. Hosting decided at the start (R8). | Integration suite green; **relay-blindness test** (scan every stored byte for planted plaintext markers; none found); load and limit tests; restart and recovery test. |
| **R3 Desktop producer and consumer** | In the Node core, behind a default-off flag: snapshot producer (section 5.1) and request consumer (5.2) with permission re-check. | Permission matrix tests (every request type against every switch and mode); idempotency and expiry tests; redaction tests; flag off means zero outbound traffic. |
| **R4 Enrollment, revocation, rotation** | QR enrollment with confirmation on the desktop; revoke; epoch rotation; re-publish; signing-key rotation. | End-to-end: enroll two fake devices, revoke one, rotate, the revoked device cannot read new data, the other can; QR single-use and expiry tests; no secret ever in a relay log. |
| **R5 Extension remote mode** | Extension as a device: snapshots read, meeting upload chunks queued. | Offline desktop test: record, upload through the relay, desktop returns and ingests exactly once; extension stores nothing after ack. |
| **R6 Phone web view** | PWA in React from ui-kit; keys non-extractable; offline shell; signed bundle and CSP; staleness UI. | Real iPhone and Android run by the user (a `(you)` step); bundle-signature tamper test fails closed; CSP and SRI checks; accessibility pass. |
| **R7 Push** | Web Push generic pings. | Delivery on a real device; payload contains no content (checked). |
| **R8 Deploy and monitoring** | Deployment pipeline, backups of the device registry only, uptime and error monitoring, runbook, secret rotation. | A clean deploy and a rollback rehearsed; alert fires on a forced failure; MASTER-PLAN Operations items. |
| **R9 Parity and retire** | Phone features at parity with the Mac WebSocket path for the supported subset; retire `:3006` and the PIN. | One release with both; the user signs off parity; kit plan invariant 7 replaced by relay-based checks. |

Rough size is not estimated here: the master plan says no gate is compressed to hit a date, and no relay code or measurement exists to base an estimate on (the Tauri plan gave "4 to 6 weeks" for its phase 4, which predates this design).

## 11. Test plan

| Layer | What | How |
|---|---|---|
| Crypto unit | Seal and open round trips; wrong key, wrong AAD, flipped bit, truncated tag, wrong epoch, reused nonce detection, size buckets | Known-answer vectors committed to the repo; run in Node and in a headless browser |
| Spec conformance | Relay routes and envelopes | `schema/http` relay group with fixtures; `make contract-gates` and the live contract test pattern |
| Relay integration | Fake desktop and fake device against the real relay: put, get, drain, ack, TTL expiry, ordering, limits, auth failures, revoked token | In-process, no network beyond loopback |
| Relay-blindness | After a full scenario, scan the relay's storage and logs for planted plaintext markers and tokens | Automated; must find none |
| Security negatives | Replay, rollback, swapped kind, swapped device, expired item, forged signature, unknown epoch, revoked device, enrollment secret reuse and expiry | Each a named test that must fail closed |
| Permission matrix | Every request type against every phone access switch and permission mode, at execution time, including a switch flipped between queue and run | Table-driven test on the desktop consumer |
| Failure injection | Relay down, desktop off, desktop crash mid-request, relay restart, partial snapshot upload | Deterministic fault injection; desktop never blocks |
| Idempotency | Duplicate `requestId` under retry and crash | Table-driven |
| Extension chunked upload | Interrupted upload, out-of-order chunks, desktop back mid-upload | Test with the fake relay |
| PWA | Install, offline open, key non-extractability (attempt export fails), bundle-signature tamper, CSP violation blocked, staleness display | Browser automation plus the user's real-device pass |
| Review | Independent security review of R1, R3, R4 before merge | Sonnet reviews; Fable for the final review; optional external review before first public exposure |
| Cost and limits | Per-device quota and per-user cap reached produces a typed refusal | Unit plus integration |
| No regression | `make regression`, `make test-shared-protocol`, `make build-mac-mobile-only` stay green while the Mac path is untouched | Existing gates |

## 12. Open questions for the user

Numbered; each has a recommended answer. None blocks R0 except R1 to R3.

| # | Question | Options | Recommended |
|---|---|---|---|
| R1 | Is an encrypted, replaceable **snapshot at the relay** acceptable under the one-copy rule (a cache, not a second store of record)? | yes; no, phone needs the Mac | yes: it is derived, encrypted and republishable; the desktop stays the home |
| R2 | Who shares a key: **one user's devices** only, or a **company team** (ADR 0018 says "team key")? | per user; per team | per user first (no cross-user exposure, simplest); design epochs and wrapping so a team is a later set of users |
| R3 | What may the phone queue while the desktop is off? | read only; plus chat prompts and activity-seen and project switch; plus more | chat prompts, activity-seen, project switch; **no** edits, Loop or Auto Task start, approvals or dispatch |
| R4 | Time to live for queued requests? | per class | chat 24 hours, other requests 1 hour, approvals never queued; an expired request returns a clear reply |
| R5 | If the desktop is lost, can the team key be recovered? | no (re-enroll); printed recovery code | no recovery by the relay; offer an optional printed recovery code kept by the user |
| R6 | PWA code trust (section 7.2): accept a weaker model, or require a signed bundle with a pinned publisher key, or keep the native app as the only key-holding client? | accept; signed bundle; native only | signed bundle with the publisher key pinned at enrollment plus strict CSP, and keep the native iOS app until the PWA has run in real use |
| R7 | Push notification content? | generic wake-up; short text; encrypted text decrypted in the service worker | generic wake-up only at first; encrypted text later if wanted |
| R8 | Relay host (MASTER-PLAN Q-WEB-2)? | small VPS (Node); Cloudflare Workers and R2; undecided | decide at the start of R2; lean VPS first behind a storage interface (section 8); this is a recommendation, not a decision |
| R9 | Domain, TLS owner and region (relevant for a Japan-based company)? | company subdomain in the preferred region; provider default | a company-owned subdomain, region chosen for latency and the company's data rules; someone named as owner of the account and certificates |
| R10 | Retention and limits? | as in section 2.2 | latest snapshot per kind (plus none), inbox and outbox 7 days maximum, logs 14 days, snapshot 256 KiB, request 16 KiB, device cap 20 (matches the Mac's `maxDevices`) |
| R11 | Accept that the relay sees metadata (device ids, timing, size class, IPs) and use opaque `kind` ids and size buckets? | accept; stronger padding | accept with opaque kind ids and size buckets |
| R12 | Extension in remote mode: enrolled as a device by QR, and may it upload meeting recordings in chunks while the desktop is off? | yes; no | yes (it is the one write ADR 0018 allows), as encrypted chunks acked by the desktop; extension stores nothing after the ack |
