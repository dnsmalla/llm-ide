# Relay design: independent security review

Status: **review of a design, no code exists.** Date: 2026-10-31, at `main`. Reviewed: [relay design](2026-10-31-relay-design.md) (sections 2 to 12), [sync-kit map](../../kits/sync-kit.md), [ADR 0018](../../decisions/0018-tauri-desktop-node-core-relay.md) (decisions 4 and 5). Method: read-only attack of the documents as a cryptographer and application-security reviewer; the only code consulted is the outbound-fetch inventory in [the status audit](2026-10-31-status-audit.md) section (e). Nothing was run, no primitive was tested, and no library version or browser support level was checked online: every "verify" below is a step for R1, not a claim. This review does **not** replace the independent crypto review the design already requires before R1, R3 and R4 merge; it tells you what to change in the design first.

## 1. Verdict

The skeleton is sound: no keys at the relay, per-device tokens stored as hashes, out-of-band QR, typed requests, permission re-check at execution time, receiver-side expiry, relay-blindness test. **It should not go to R0 (spec) unchanged.** Three findings are design-breaking (a malicious relay defeats the stated guarantee), seven are High (must be settled in the R0 spec), the rest are specification gaps for R0 to R4. Section 3 lists what only you can decide.

| Rank | Count | Meaning |
|---|---|---|
| Critical (C) | 3 | The guarantee "relay cannot read or forge" fails as written |
| High (H) | 7 | A realistic attacker gets a material capability; fix in the R0 spec |
| Medium (M) | 10 | Specification gap or hardening; fix by the phase named |
| Low (L) | 5 | Hygiene |

## 2. Findings, ranked

### Critical

**C1. The PWA cannot be made to resist a malicious relay by signing the bundle.** (Design 7.2, T9, question R6.)

- The design pins a publisher key "in the QR" and has "the service worker verify each update". Both are code served by the party being defended against.
  - *First load:* the QR is scanned by the phone camera, which opens a URL on the relay. The code that runs first (and that is supposed to compare against the pinned key) comes from the relay. A malicious relay serves code that ignores the pin. The QR-carried publisher key defends nothing on the web path.
  - *Update:* a service worker's own script is re-fetched from the origin on navigation (at least daily by browser rule). A malicious relay serves a **new service worker** with verification removed. Signing the app files does not sign the verifier.
  - *Other:* the relay can also serve different code to different clients, and Clear-Site-Data or storage eviction (iOS evicts script-writable storage of non-installed sites) forces a fresh first load.
- So the honest statement is: **a web client served by the relay is only as trustworthy as the relay operator and account.** The design names the problem but credits mitigations that do not work against the stated actor.
- Change before code:
  1. Reword T9 and 7.2: the signed bundle protects against a *compromised CDN, mirror or tampered storage that does not hold the signing path*, not against a malicious relay operator. Do not describe the PWA as meeting "no plaintext at the relay" for a hostile operator.
  2. Adopt **tiered client assurance** (decision D1): keys that can write or approve never live in the PWA. The PWA receives only the read-kind subkeys (H3) and can queue only the low-risk classes. High-assurance actions (tool approvals, edits, Loop or Auto Task start, anything that spends or posts) stay on the **native iOS app** or the **desktop**, whose code arrives through App Store and the signed updater.
  3. Serve the PWA from a **different origin, account and deploy credential** than the data relay (design 7.2 row 3 is correct; make it mandatory, with MFA and a hardware key on that account). A data-relay compromise then does not change the app.
  4. Keep the signed bundle anyway, for the mirror/CDN case, but put the verifier in a **minimal, never-changing bootstrap service worker** whose hash is published out of band (release notes, repository) so a user or auditor can compare; state that browsers still let the origin replace it.
  5. If a stronger web model is ever required, evaluate (do not assume) browser-vendor mechanisms for integrity-pinned web apps; none is a baseline across Safari, Chrome and Firefox today to my knowledge. Verify at R6.

**C2. The wrapped team key is not authenticated, so the relay can substitute its own key.** (Design 4.3 step 4 and 5, 4.5.)

- The wrap is ECDH(ephemeral, device public key) then HKDF then AES. The device public key is **public**; anyone, including the relay, can create a valid wrap of a key they chose. Step 5 checks that the desktop *signing key* matches the QR fingerprint, but nothing says the wrapped key is **signed by that key** or bound to the enrollment.
- Attack: after the device claims the slot, the relay publishes a wrap of its own key K'. The device unwraps K'. Snapshots would fail signature checks, but every **request the device encrypts under K' is readable by the relay** (chat prompts, which are the sensitive part). The same attack works on every rotation.
- Change before code: the wrap is a **signed object**. Concretely: HPKE-style construction (RFC 9180, DHKEM P-256 or X25519, HKDF-SHA-256, AES-256-GCM) with `info` and AAD = `"llmide/wrap/v1" || epoch || deviceId || SHA-256(device ECDH SPKI) || SHA-256(desktop signing SPKI) || capability set (H3)`, **plus an ECDSA signature by the desktop signing key over the full wrapped object**. The device verifies the signature against the **QR-pinned fingerprint** before unwrapping, rejects an epoch that is not strictly greater than its current one, and replies with a key-confirmation message (a short signed ciphertext under the new key) so the desktop learns the device really holds it.

**C3. The desktop's device list for rotation comes from the relay.** (Design 4.5, "wraps `K_team[epoch+1]` to every remaining device".)

- The only authoritative list described is the relay's "device registry". A malicious relay adds a rogue device public key to it; at the next rotation the desktop wraps the new key to the attacker. The human confirmation exists only at enrollment (4.3), not at rotation.
- Change before code: the desktop holds its **own signed local device registry** (device id, both public key fingerprints, label, capability set, enrolled-at, confirmed-by-user flag), written only by the enrollment-confirm and revoke UI actions, kept in the OS keychain or an integrity-protected file. Rotation wraps only to keys in that registry. The relay's registry is a convenience copy; a mismatch is shown to the user, never acted on. Also sign every desktop-originated device-registry operation sent to the relay (H5).

### High

**H1. A lost phone cannot be revoked while the desktop is off or lost.** (Design 2.1 "begin and revoke: desktop", 4.5.)

- Revocation is a desktop action. The motivating scenario (phone stolen, laptop at home or also gone) leaves the thief's bearer token valid for as long as the desktop is unreachable. The thief still cannot read content without the key (token alone gives ciphertext and inbox writes), but they keep access to current ciphertext, metadata and push. If the thief also has the unlocked phone, they hold the key and stay readable until rotation.
- Change before code (decision D4): an **emergency revoke path that does not need the desktop**: a 128-bit revoke code printed at setup (relay stores only its hash) that kills a device token and any push subscription at the relay immediately, and sets a signed-by-nobody "revocation pending" flag. The desktop, on next start, **must rotate before publishing anything** (fail closed: if a pending revoke exists, the first publish is a rotation). Specify the order explicitly: rotate, wrap to remaining, publish, then delete old data; never publish under the old epoch after a revoke was requested.

**H2. Remote-origin requests inherit the desktop's current permission mode.** (Design 5.2 step 3.)

- "Goes through the desktop's own mode (Ask, Accept Edits, Bypass)". If the user left the desktop in Accept Edits or Bypass for their own work, a queued prompt from a stolen or compromised device runs with those rights, hours later, with nobody at the desk. Also, content ingested by the desktop (email, Slack, web pages) is attacker-influenced, so a queued chat can be a prompt-injection vehicle.
- Change before code (decision D2): remote-origin turns run under a **fixed ceiling independent of the desktop's mode**: a "remote-safe" tool set (read, search, no shell, no writes, no network-fetching tools, no connectors that post), no Bypass, and "Ask" resolved as **deny** when no local user answers within a short window. Raising the ceiling is a per-device setting changed on the desktop. A queued `project switch` must switch the **phone session's** project context, never the desktop's global active project (UI-state hijack).

**H3. One flat team key for every kind, every device and the extension.** (Design 4.1.)

- Every enrolled device (including the browser extension and a PWA) holds the key that decrypts everything, and any key holder can encrypt as any sender-class. This makes least privilege impossible (the extension is meant to upload recordings, not read chat history; the PWA is lower assurance, C1) and any single device compromise is total.
- Change before code: a **key hierarchy** (section 4.1 below): a root per epoch, per-kind and per-direction subkeys derived by HKDF, and a **capability set per device** (which read kinds, which write classes). A device is wrapped only the subkeys its capability set needs. Changing a capability is an epoch change for the affected subkeys. This also gives domain separation, a message budget per key (M1), and key rotation granularity.

**H4. QR enrollment: proof of possession cannot be verified as written; the human check is weak; the QR leaks through screen share and URL logs.** (Design 4.3.)

- *Inconsistent proof:* step 3 has the device send "an HMAC over its public keys, keyed by the secret" and the relay verify it "against the stored hash". An HMAC cannot be verified from a hash of its key. Either the relay stores the secret (then a malicious relay can claim its own slot, and only the human check stops it) or the relay cannot verify it.
- *Fix:* derive from the secret `s` with HKDF-SHA-256: `claimToken = HKDF(s, "claim")` (relay stores SHA-256 of it and gates the claim endpoint with it), `bindKey = HKDF(s, "bind")` (the **desktop** verifies an HMAC-SHA-256 over both device public keys, slot id and label; the relay never sees `bindKey`), `sasKey = HKDF(s, "sas")`.
- *Human check:* "the desktop shows a short verification code and asks the user to confirm" has nothing to compare against. Use a **short authentication string** computed from `sasKey`, both public keys and the slot id (6 decimal digits is enough because the slot is single-use and allows one attempt), displayed on **both** screens; the user confirms they match. This is what defeats a person who photographed the QR (they know `s` but their device shows a different string than the phone the user holds).
- *Contested claim:* if a second claim arrives for a slot, the slot is dead and the desktop shows a loud alert ("someone else scanned this code"). First-claim-wins with silent failure on the legitimate phone is the attack succeeding quietly.
- *Screen share:* this product is a meeting tool; the desktop will often be screen-sharing while the user adds a device. Show the QR only on an explicit click, exclude the window from screen capture (macOS: window sharing type none; verify per OS in Tauri), shorten life to 2 minutes (proposed), and say on screen that the code is a secret.
- *Logs and history:* put the secret and fingerprints in the URL **fragment**, never path or query (access logs, referrers, proxies), and remove it from history with `history.replaceState` before any other code runs. A phone camera hands the URL to the browser and the browser may sync history to the cloud.
- *Expiry and single use:* enforced by the **desktop** as well (the relay clock and the relay's "used" flag are not trusted): the desktop accepts at most one claim per slot, within the 2 minutes, and records it.

**H5. Theft of the desktop's admin-class bearer token is a full relay takeover.** (Design 2, "desktop (one, admin-class)".)

- The desktop token can write snapshots, drain and delete the inbox (silently dropping a user's requests), open enrollment slots, **revoke devices**, and edit the registry. Snapshot writes are caught by signatures, but the rest is not.
- Change before code: **every desktop admin operation is signed with the desktop signing key** (domain-separated context string, request counter, timestamp), and the relay verifies the signature against the public key it registered at relay setup. The bearer token then only identifies the account. Device tokens are similarly **sender-constrained** (each request carries a signature by the device's ECDSA key over method, path, body hash, timestamp and a nonce; DPoP-like). That costs little in a PWA with non-extractable keys and removes token theft as a standalone attack (relevant to the stolen-profile case).
- Store the desktop signing key as hardware-bound where the OS offers it (Secure Enclave on Apple silicon supports non-exportable P-256 signing keys; TPM on Windows; software keychain on Linux, stated as weaker). A non-exportable key cannot be copied with the laptop's disk.

**H6. Rollback, freeze and mix-and-match of snapshots are only partly covered.** (Design 4.4, T3.)

- A per-kind `seq` stops replaying an older version of one kind **to a device that has seen a newer one**. It does not stop: serving kind A from Tuesday with kind B from Friday (inconsistent view); withholding all updates forever (freeze, with the last signed state looking fine); serving any old state to a fresh or storage-evicted device; and the **desktop** rolling its own counter back after a restore from backup.
- Change before code (TUF-style, without importing a framework): the desktop signs a small **manifest** listing every current kind with its `seq`, `epoch` and a hash of the blob, with a single global monotonic `manifestSeq` and a `validUntil`; devices fetch and verify the manifest first, then only the blobs it names. The heartbeat refreshes the manifest, so freeze beyond `validUntil` is visible ("desktop offline or relay withholding"). The QR carries the **minimum manifest seq** at enrollment so a fresh device cannot be handed an old state. The desktop persists the counter durably and, if its counter state is ever lost or restored from backup, **starts a new epoch** (ordering is the pair epoch then seq, lexicographic). Avoid wall-clock-only ordering; a hybrid `max(counter + 1, floor(ms clock))` is acceptable.

**H7. The key-holding web origin renders attacker-influenced text.** (Design 7.1; not in the threat model.)

- Chat output, issue titles, ingested email and web content are untrusted. Rendered as Markdown or HTML in the origin that holds keys, they enable script injection **and** the well-known exfiltration through remote images or links in model output (the request URL carries the stolen text), which bypasses E2E entirely.
- Change before code: Markdown rendered with **no raw HTML**, remote images **not loaded** (or proxied only through a desktop-approved path; default off), links open with `rel="noopener noreferrer"` after an interstitial; CSP as a requirement of the spec, not a note: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' <relay>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`, plus `Referrer-Policy: no-referrer`, a dedicated origin with nothing else on it, and no inline script. Cache **ciphertext** in the service worker and IndexedDB, never plaintext.

### Medium

**M1. AEAD, nonce and associated-data gaps.** (Design 4.2.)

- *Choice:* AES-256-GCM through WebCrypto is acceptable and makes `CryptoKey` non-extractable (useful against profile-file theft, not against code running in the page). Keep it, with the changes below. Libsodium XChaCha20-Poly1305 has 192-bit random nonces (no nonce risk) but its keys live in JS memory, forfeiting non-extractability; I recommend WebCrypto AES-GCM unless R1 finds a browser gap.
- *Nonces:* the document's claim that random 96-bit nonces are safe "under one key" is true only for a bounded count per key, and the key is shared by the desktop and every device (many independent random senders). Fix with the hierarchy of H3: one key per (epoch, kind, sender) so each key sees one sender, and a hard **message cap per key of 2^24 (proposed; the NIST limit for random nonces is 2^32 at 2^-32 collision risk)**; at the cap the sender refuses to encrypt and the desktop rotates. A desktop publish loop bug is the realistic way to approach 2^32, so also rate-limit publishes. Never use counter nonces on devices (backup restore or storage eviction resets counters and reuses nonces).
- *AAD gaps:* add `version` (a format version byte; unknown version fails closed, no negotiation), a purpose tag (`snapshot`, `request`, `reply`, `wrap`, `manifest`) as domain separation, `recipientId` for replies and requests (otherwise device B can accept device A's reply), `desktopId` and `userId` (cross-install replay), and `producedAt`. Make the **signature context** a fixed prefix string per purpose (`"llmide/snapshot/v1\0"`) so one signature can never be valid as another type.
- *Encoding:* specify a **canonical binary encoding** (length-prefixed fields or deterministic CBOR), never JSON, for the bytes that are signed and the AAD; ambiguity in JSON field order or duplicate keys is a signature-confusion bug.
- *Signature algorithm:* ECDSA P-256 with SHA-256 (WebCrypto outputs raw r||s, Node can be set to the same `ieee-p1363` encoding; pin it). Ed25519 is attractive but support in WebCrypto across engines should be verified at R1; P-256 is the safe baseline.
- *Key commitment:* GCM is not key-committing; with AAD plus a signature over header and ciphertext the invisible-salamander case is closed. Keep the signature mandatory on every message type.
- *`kind` ids:* make them `HKDF(root, "kind-id" || name || epoch)` truncated to 128 bits, so the relay cannot see the same id across epochs or guess names from a dictionary of eight kinds. (Sizes still fingerprint kinds, M7.)

**M2. Request consumer: at-most-once, TTL and ordering.** (Design 5.2.)

- Record the `requestId` **before** execution (at-most-once) for anything that starts model work or has side effects; on a crash after record and before reply, answer "failed, retry" rather than run twice. The idempotency table must be durable and retained at least TTL plus clock-skew.
- `expiresAt` is **sender-chosen** and the sender is the less trusted party: the desktop enforces its own per-class maximum age from a signed `issuedAt` with a tolerance, using its own clock. A device with a wrong clock is told, not trusted.
- A strictly increasing per-device `seq` drops legitimate items that arrive out of order or after a gap (relay reorders). Use a per-device sliding window or accept any unseen `requestId` within TTL.
- Validate typed requests against a closed schema with size and field limits before any other work; unknown fields are rejected, not ignored.
- Rate-limit by device at the desktop as well (cost abuse, T13): a stolen device inside its quota still costs money; make the quota visible in the device list.

**M3. Extension as a device and chunked recording upload.** (Design 6.)

- A browser extension is a good key holder in one respect (store-signed code, unlike the PWA) and a bad one in another (broad host permissions, content scripts in hostile pages). Keys must live only in the service worker or an extension page, never in a content script or anything reachable by `postMessage` from a page; the extension's capability set is **meeting upload only** (H3), not chat reads.
- Chunks: the "complete or nothing" property is missing. Each capture gets a random content key wrapped under the uploader's write subkey; chunk AAD carries `captureId`, `chunkIndex`, `chunkCount` (when known) and a final flag; the **final chunk carries the total count and a hash of the whole**; the desktop ingests only a complete, in-order, hash-verified capture. Otherwise the relay can truncate or drop a middle chunk and the desktop silently ingests a damaged transcript into the knowledge base.
- Remote mode and local mode use **different credentials**; a leaked local-core JWT must not be an inbox token and vice versa. Caps: bytes per capture, captures per day, and a separate blob path rather than 16 KiB inbox items (M5).

**M4. Web Push.** (Design 7.1, R7.)

- Generic wake-up is right. Add: the relay posts to a **subscriber-supplied endpoint URL**; without an allowlist (the browser push services' hosts) this is an SSRF primitive in a component that otherwise "makes no outbound calls". Validate the endpoint host against an allowlist and refuse private addresses, through the same pinned-fetch discipline the core uses. Use VAPID with the key kept off the data path. Rate-limit pushes per device. The payload carries no kind, count or title; the timing itself leaks activity (M7).

**M5. Denial of service and quota abuse.** (T12, T13.)

- A single shared ordered inbox lets one noisy or stolen device starve the others: use **per-device queues with fair draining**, per-device caps on item count and bytes, and a per-desktop total cap with a typed "inbox full" refusal.
- Cap SSE and long-poll connections per token and per IP; the relay is a small VPS and connection exhaustion is the cheapest attack. The unauthenticated surfaces are the enrollment claim endpoint, the PWA bundle and health; rate-limit by IP and by slot, return identical errors for unknown and expired slots, and keep slot ids 128-bit.
- Meeting uploads need a separate blob path with resumable chunks, a quota per device per day, and cleanup of orphaned partial captures after a day.
- Provider-level DDoS protection is mentioned in T12; for the VPS option it is **not** present by default (decision D6 note in the hosting choice).

**M6. Logging and secrets in transit.** (Design 2.2 logs row.)

- "Never bodies" is not enough. State as requirements: bearer tokens only in the `Authorization` header, never in URLs or query strings; enrollment secrets only in the URL fragment (H4); reverse-proxy access logs, crash dumps and error pages configured so no header or body is captured; IP addresses kept no longer than needed for abuse handling (proposed 72 hours, not 14 days) and not joined with device ids in long-lived logs. The desktop never logs decrypted requests or replies; reuse the existing `MobileLogPolicy` rules. Add the existing relay-blindness test's second half: scan **logs** for tokens, secrets and fragments, not only stored blobs.

**M7. Metadata and presence.** (R11, T1, T15.)

- Accepting (R11) is reasonable, but say precisely what leaks: when the desktop is on (10-minute heartbeats and on-change publishes reveal working hours and activity bursts), when a phone is used, device count, size buckets (which also fingerprint kinds), and IPs. Mitigations that cost little: publish heartbeats on a **fixed schedule independent of activity**, debounce changes with random jitter, and keep one fixed bucket count per kind. A stronger anonymity model (cover traffic, mixnets) is out of scope; say so.

**M8. Supply chain and publisher-key custody.** (T10.)

- The release-signing key for the PWA and the relay deploy identity are now crown jewels. Requirements for R6/R8: the publisher key is a hardware-backed or offline key (or keyless signing bound to CI identity with an auditable log), with a documented **rotation statement signed by the old key**; dependencies pinned by lockfile and installed with `npm ci --ignore-scripts`; CI actions pinned by commit; reproducible build (same source gives the same bundle hash) so anyone can compare; SBOM published; the PWA bundle contains **no runtime third-party script** and a minimal dependency list (the crypto is the platform's WebCrypto). Same discipline for the relay (the Web Push library and anything that parses bodies).
- Account hygiene for the host (VPS login, Cloudflare account): hardware-key MFA, separate deploy identity for the static PWA host, no shared credentials. A takeover of the data relay account is a metadata and availability incident; a takeover of the PWA host is a key-theft incident for web clients (C1).

**M9. Recovery code design.** (R5.)

- Recommended: **no recovery in v1** (R5 = no): re-enrolling devices by QR is cheap and a recovery secret is a second permanent way in. If you choose a recovery code anyway: 256 bits from the CSPRNG shown as grouped base32 with a checksum (or a 24-word list), used only to decrypt a **local backup file** of {desktop signing private key, current root} that the user stores themselves; **never stored at the relay** (a leaked printout plus a relay-held blob would be a total compromise; and a user-chosen passphrase must never be allowed without the slow KDF below, because a relay holding the blob could brute-force it offline). If a user passphrase is allowed: Argon2id with m = 256 MiB, t = 3, p = 1 (libsodium "moderate" profile; verify against current guidance at implementation), or PBKDF2-HMAC-SHA-256 with at least 600 000 iterations where only WebCrypto exists. After any restore the desktop **rotates the epoch and the signing-key-bound registry immediately** (the old machine may be the compromised one) and resets counters through the new epoch (H6).

**M10. What a revoked device keeps, and forward secrecy.** (Design 4.5, T8.)

- A revoked device still holds: every root and subkey for epochs it was wrapped, its own private keys, the desktop and publisher public keys, any plaintext it cached, and any ciphertext it saved earlier. Revocation correctly blocks **new** data. It does not give forward secrecy against a relay that kept old ciphertext (provider backups, a malicious operator), because a revoked device plus old ciphertext decrypts old data.
- Cheap improvements, no ratchet needed: set history to **none** (the latest snapshot only; R10); **erase old-epoch keys** on every device as soon as the new epoch's republish is confirmed (the desktop is the home and does not need old snapshots), so a device stolen *later* holds nothing about earlier epochs; keep relay backups to the device registry only (the design says this at R8; make it a spec rule); a device must delete its old-epoch keys even if offline-then-returns.
- Also specify the grace window: during rotation, requests from still-registered devices under the previous epoch are accepted for a short bounded time; requests from the revoked device never are.
- Do **not** add a per-message ratchet. It would multiply complexity for a threat (live compromise of a device that is then continuously used) that revocation already addresses.

### Low

- **L1. TLS.** HTTPS only, TLS 1.3 preferred, HSTS with a long max-age, no mixed content. The desktop should connect with redirects refused and through the same pinned-fetch discipline as the core (section 5 of the status audit lists today's unpinned calls). Certificate pinning is unnecessary because content is E2E; it would add a way to brick the desktop.
- **L2. Token format.** 256-bit random, stored as SHA-256 (fast hash is fine at this entropy), constant-time comparison, idle expiry (the Mac uses 30 days) and a hard expiry with refresh, listed with last-seen in the desktop device list.
- **L3. Randomness.** Platform CSPRNG only (`crypto.getRandomValues`, Node `crypto.randomBytes`); a lint rule that bans `Math.random` in the crypto package; known-answer tests plus Wycheproof-style negative vectors for AES-GCM, ECDSA and HKDF where available.
- **L4. Fingerprints.** SHA-256 of the SPKI, shown as grouped hex or words, never truncated below 128 bits; the QR carries the full 256 bits.
- **L5. Time.** Nothing security-critical may depend on the relay's clock; device clock skew is tolerated within a stated window and surfaced.

### Corrections to the design text

1. 4.2 nonce row: replace "safe at this volume under one key" with the per-key hierarchy and message cap (M1).
2. 4.3 step 3 and 2.2 enrollment row: the relay stores `SHA-256(claimToken)`, not a hash of the secret used as an HMAC key (H4).
3. 4.3 step 5: "verifies the desktop signing key matches the fingerprint" must become "verifies the **signature on the wrapped key**" (C2).
4. 4.5: the device list is the desktop's local registry (C3); revoke has an emergency path (H1).
5. 7.2 and T9: restate what the signed bundle does and does not protect (C1).
6. T6: the human check is the SAS on both screens, not a code shown only on the desktop (H4).
7. T3 residual: add freeze and mix-and-match and the manifest (H6).
8. T5 residual: add the remote-safe ceiling (H2).
9. New threats to add: T18 key substitution at wrap (C2); T19 rogue device injected at rotation (C3); T20 admin token theft (H5); T21 exfiltration through rendered content (H7); T22 screen-share of the QR (H4); T23 push endpoint SSRF (M4).

## 3. Concrete primitives (proposed for the R0 spec; verify at R1)

| Item | Proposal |
|---|---|
| Randomness | `crypto.getRandomValues` (browser), `crypto.randomBytes` (Node); nothing else |
| Root key | 32 random bytes per epoch; held by the desktop (OS keychain); each device holds only its wrapped subkeys, non-extractable `CryptoKey` after import |
| Subkeys | `HKDF-SHA-256(ikm = root, salt = SHA-256("llmide-relay-v1" || userId || desktopId), info = purpose || epoch || kindId || senderId)` to 256 bits; purposes `enc`, `kind-id`, `manifest`, `request`, `reply` |
| AEAD | AES-256-GCM, 96-bit random nonce, 128-bit tag, one key per (epoch, kind, sender), cap 2^24 messages per key then refuse |
| AAD | version, purpose, epoch, kindId, senderId, recipientId (if any), seq, requestId (if any), issuedAt, expiresAt, userId, desktopId, in canonical binary encoding |
| Signatures | ECDSA P-256 / SHA-256, raw r||s (IEEE P1363), over `context || canonical header || ciphertext`; contexts are fixed per purpose; every message type signed |
| Key wrap | HPKE (RFC 9180) base mode over P-256, KDF HKDF-SHA-256, AEAD AES-256-GCM, or the equivalent ECDH P-256 plus HKDF written down exactly in the spec with `info` binding; wrapped object signed by the desktop key (C2); Node and WebCrypto have no native HPKE, so either a small audited implementation or the written-out ECDH+HKDF form with known-answer vectors |
| Device keys | Two non-extractable pairs: ECDH P-256 (wrap), ECDSA P-256 (requests and DPoP-like proofs); generated on the device |
| Desktop signing key | ECDSA P-256, hardware-bound where available (Secure Enclave, TPM), software keychain otherwise (stated as weaker) |
| Enrollment secret | 128-bit CSPRNG in the URL fragment; `claimToken`, `bindKey`, `sasKey` by HKDF-SHA-256 with labels `claim`, `bind`, `sas`; relay stores `SHA-256(claimToken)`; bind MAC is HMAC-SHA-256 verified by the desktop; SAS is 6 digits from HMAC-SHA-256 over both public keys and the slot id |
| Enrollment life | 2 minutes (proposed), one claim, enforced by the desktop |
| Bearer tokens | 256-bit random, relay stores SHA-256; plus per-request signature (device or desktop key) for sender constraint |
| Padding | length-prefix then zero-pad **inside** the AEAD plaintext to the bucket; no compression before padding |
| Recovery (if chosen) | 256-bit code; local backup only; Argon2id m = 256 MiB, t = 3, p = 1, or PBKDF2-HMAC-SHA-256 at least 600 000 iterations as a WebCrypto-only fallback (verify against current guidance when implemented) |
| Fingerprint | SHA-256 of SPKI, full 256 bits in the QR, grouped display |

## 4. Tests to add to the design's section 11

- Wrap substitution: a relay-created wrap of a chosen key is rejected by the device (C2); a wrap with an epoch not greater than the current one is rejected.
- Registry authority: a rogue key injected into the relay registry is never wrapped to at rotation (C3).
- Two claims on one slot: slot dies, desktop alert, no key issued (H4); SAS mismatch prevents confirmation; expired and replayed slots rejected by the desktop even if the relay says otherwise.
- Emergency revoke with the desktop off, then rotation-before-publish on next start (H1).
- Manifest: kind mix-and-match, freeze past `validUntil`, fresh-device old-state serve, desktop counter loss leading to a new epoch (H6).
- Remote-safe ceiling: a queued prompt run while the desktop is in Bypass still uses the read-only tool set; Ask with no answer denies (H2).
- Capability subset: the extension's key set cannot decrypt a chat snapshot; the PWA's cannot sign a write request (H3).
- Chunked upload: truncated, reordered, duplicated, hash-mismatch captures are not ingested (M3).
- Content safety: a snapshot containing an image URL, HTML and a script tag renders inert and triggers no network request (H7).
- Log scan: no token, secret or fragment in relay or proxy logs after a full scenario (M6).
- Push endpoint: a private-address or non-allowlisted endpoint is refused (M4).
- Nonce budget: encrypting beyond the cap refuses; two senders never share a key (M1).

## 5. Decisions only you can make

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | PWA assurance model (reformulates R6 after C1) | A: PWA is full-capability (accepts that a malicious relay operator or PWA-host takeover reads everything for web clients); B: **tiered**, PWA read-only plus low-risk queue, writes and approvals only on native app and desktop; C: no PWA, native only | B, with the PWA on a separate origin and account; A only if you accept that residual risk in writing |
| D2 | Capability ceiling for remote-origin turns (H2) | inherit desktop mode (as designed); fixed read-only ceiling; per-device setting | fixed read-only ceiling, raised per device on the desktop |
| D3 | Recovery code (R5, M9) | none; local encrypted backup | none in v1 |
| D4 | Emergency revoke without the desktop (H1) | printed revoke code; any enrolled device may revoke others; none | printed revoke code (token kill only), mandatory rotate-first on next desktop start |
| D5 | Metadata posture (R11, M7) | on-change publishing; fixed-schedule heartbeat with jitter | fixed-schedule heartbeat; IP retention 72 hours |
| D6 | Hosting and accounts (R8, M5, M8) | VPS or Cloudflare; same or separate account for the PWA | separate origin and account for the PWA host; if VPS, name who provides DDoS protection and patching |
| D7 | Extension scope (R12, M3) | meeting upload only; plus snapshot reads | upload only (no snapshot keys) in v1 |
| D8 | Sharing scope (R2) | per user; per team | per user; if team, subkeys per user and a different wrap (cryptographic change, decide before R0) |
| D9 | External review before first public exposure | skip; paid external review | do it: first public service in the product; the internal reviews cover the code, not the design assumptions |

Questions R1, R3 and R4 in the design are unchanged by this review except that R3 should carry the H2 ceiling (what may be queued is also limited by what runs under the ceiling).

## 6. What this review did not do

- No code existed to read and none was written; no primitive was benchmarked or run; browser support for WebCrypto algorithms (Ed25519, X25519), HPKE, window capture exclusion and storage eviction rules were **not** verified online. R1 owns that.
- No formal analysis of the protocol (no model checker, no proof). The attacks here are by inspection; an external cryptographer should review the final written spec (D9).
- The Mac app's existing PIN and WebSocket path was not re-reviewed; its risks are listed in the sync-kit map section 8.
- Hosting-specific hardening (OS patching, firewall, Cloudflare configuration) is out of scope until D6.
