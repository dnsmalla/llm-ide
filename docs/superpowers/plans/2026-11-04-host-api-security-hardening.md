# Host API v1 Security Hardening Implementation Plan (Plan 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both Host API v1 hosts (the Mac app and the desktop Node core) can serve v1 off loopback, safely. Each host has a self-signed TLS identity whose fingerprint is pinned by the client. Plaintext stays loopback-only behind the development flag. Browsers are refused unless their exact `Origin` is allowlisted. Device tokens carry the capabilities granted at pairing. Every session's command rate is limited. Pairings, revokes and auth failures are audit-logged.

**Architecture:** The work is the same on both hosts and is pinned by shared fixtures under `schema/host-api/v1/fixtures/security/`: the origin rule, and a P-256 test vector for the fingerprint.
- **Identity.** Each host gets a host identity module: a P-256 key, a hand-built self-signed X.509 DER certificate and a `sha256:<base64url SPKI hash>` fingerprint. No new dependency: CryptoKit plus Security on the Mac, `node:crypto` on the desktop.
- **Listeners.** The Plan 2 and Plan 3 v1 listeners gain a TLS mode: Network.framework `NWProtocolTLS` on the Mac, `https.createServer` with the existing upgrade path on the desktop. In TLS mode they may bind every interface. The plaintext mode keeps its loopback-only bind and peer check.
- **Gateways.** The Plan 2 and Plan 3 gateways gain four things: a per-session grant set (token scopes), two token buckets (frames per session, turns per device), an audit sink, and the fingerprint in `host.hello`.
- **Advertising (Mac).** The Mac puts the v1 port and the fingerprint in the pairing QR and in the Bonjour TXT record of its existing `_llmide._tcp` service.

**Tech Stack:** Swift 5.9, Network.framework (`NWListener`, `NWProtocolTLS`, `sec_protocol_options_*`), CryptoKit (`P256.Signing`), Security (`SecKeyCreateWithData`, `SecCertificateCreateWithData`, `SecIdentityCreate`), swift-testing. Node 22 (`node:https`, `node:tls`, `node:crypto` `X509Certificate`, `node:test`), better-sqlite3 migrations. Tauri 2 / Rust for the env pass-through.

**Spec:** [`docs/superpowers/specs/2026-11-03-host-api-design.md`](../specs/2026-11-03-host-api-design.md), delivery phase 6: "Security hardening: TLS certificate pinning, token scopes, origin allowlist, rate limits and audit logging". The transport design this reuses is [`2026-10-31-mobile-tls-pinning-design.md`](2026-10-31-mobile-tls-pinning-design.md) (sections 2, 3 and 5). The hosts it hardens:
- Plan 2 [`2026-11-04-host-api-mac-adapter.md`](2026-11-04-host-api-mac-adapter.md): `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/`.
- Plan 3 [`2026-11-04-host-api-desktop-adapter.md`](2026-11-04-host-api-desktop-adapter.md): `extension/routes/host-api/` and `extension/server/host-api-listener.mjs`.

**Prerequisite:** Plan 3 must be finished, because Tasks 6 to 8 edit its gateway, listener, device store and routes. Tasks 1 to 5 do not need it.

## Global Constraints

- Spec "Security", verbatim:
  - "TLS/WSS is required for non-loopback clients. The host certificate fingerprint is carried in the pairing QR and pinned by the client."
  - "Localhost development may use plaintext only when an explicit development environment flag is set; production builds refuse it."
  - "Tokens are stored hashed on the host and in Keychain on iOS."
  - "Tokens are scoped to granted capabilities and revocable per device."
  - "Pairing attempts are rate-limited with a lockout; auth failures are audit-logged."
  - "Web clients send an `Origin`; the host applies an allowlist and refuses unknown origins. No wildcard CORS."
  - "No frame may carry a credential after pairing except `host.auth.token` and the token in `host.auth.revoke` (self-revoke)."
- Spec "Ports and listeners", verbatim: "Host API v1 has a separate TLS listener, default **`wss://3016`**, falling back to the next free port when busy. Both listeners run at once. Discovery, the QR and the manual-entry screen advertise the exact v1 port; the default is never assumed." The v2 listener (`ws://3006`–`3015`) is **not touched**.
- Spec "Handshake": the `host.hello` result carries `"certificateFingerprint": "sha256:..."`. The frozen schema already has it as an optional string with `maxLength: 200` (`schema/host-api/v1/commands.json`, `host.hello.result`). **This plan changes no v1 schema.** A TLS host sends the field; a plaintext development host omits it.
- Spec "Pair a phone": "Mac shows QR: `wss://192.168.1.20:3016`, API 1, fingerprint, one-use PIN. Phone pins the certificate and sends `host.hello`."
- Spec "Risks": "Self-signed local TLS can be painful on iOS and browsers; fingerprint pinning and QR bootstrap are required, not optional."
- Spec "Testing": "TLS: certificate mismatch refused; plaintext refused outside loopback."
- Errors keep the stable codes. A scope refusal is `denied` and a rate refusal is `rate_limited` (with `retryable: true` and `retryAfterMs`). Messages are at most 500 characters and never contain tokens, PINs, key material or frame content.
- No audit row and no log line may contain a token, a PIN, key bytes or frame content. Log frames by type and size only (`MobileLogPolicy` on the Mac).
- Mac rules (root `CLAUDE.md`, `Features/MobileControl/CLAUDE.md`):
  - MobileControl is sealed. New Mac files live in `Features/MobileControl/Services/HostApi/` and may use Core only (`KeychainStore.backend`), never another feature.
  - Every new test file that names a MobileControl type goes into `mobileTestExcludes` in `mac/Package.swift`.
  - Tests always run with `LLMIDE_KEYCHAIN_BACKEND=memory`.
  - Mac Swift is feature-frozen except security and parity work. Everything here is security work; the only UI added is the "Reset security identity" button and the fingerprint line next to the existing QR.
  - `bash mac/Scripts/feature-boundaries.sh` must stay green.
- Core rules (root `CLAUDE.md`, `extension/CLAUDE.md`):
  - Layering lint at zero. `server/` may import `core` and `kb`; `kb/` may import only `core/`; `routes/` may import any Node layer.
  - Append-only migrations; every state-mutating kb helper takes `userId` first.
  - An HTTP wire change bumps `SERVER_API_VERSION` and updates `ALL_ENDPOINTS`, `schema/http/` and the inventory.
  - The Agent SDK stays lazy-loaded: the TLS listener is imported dynamically, like Plan 3's dev listener.
  - The main server's `127.0.0.1` bind invariant is unchanged. Only the v1 listener may bind other interfaces, and only in TLS mode.
- Desktop rules: env reaches the core only through explicit `.env(...)` in `desktop/src-tauri/src/core_host.rs`, never by widening `core_env.rs` `ALLOWED`.
- No new npm, SwiftPM or cargo dependency.
- Conventional Commits, one concern per commit, on `main`, never pushed by the executor. Every commit ends with the attribution line the session gives.

## Decisions this plan makes (revisit if wrong)

1. **Fingerprint format:** `sha256:` plus the unpadded base64url SHA-256 of the DER SubjectPublicKeyInfo (43 characters after the prefix).
   - It hashes the SPKI, not the whole certificate, so re-issuing the certificate for the same key (renewal at expiry) keeps every pin valid. This is the same choice as the 2026-10-31 design.
   - Both hosts compute it from the same shared test vector (Task 1), so a Swift and a Node host can never disagree on the format.
2. **Certificate:**
   - Key and signature: a P-256 key, self-signed with ECDSA-SHA256.
   - Contents: serial from 16 random bytes, validity 5 years from first start, CN `LLM-IDE <host name, at most 64 characters>`, `basicConstraints` CA:FALSE (critical), `keyUsage` digitalSignature (critical), `extKeyUsage` serverAuth. No subjectAltName: the pin is the only trust root, so names and IPs do not matter.
   - The DER is built by a ~40-line writer on each host, with no ASN.1 dependency. The platform parser checks it in tests (`SecCertificateCreateWithData` and Node `X509Certificate`).
3. **Mac key storage:**
   - One generic-password item through `KeychainStore.backend`: account `mobile::hostapi-identity`, service `com.llmide.macapp`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (the real backend's write already sets it). It holds the raw P-256 private key and the certificate DER.
   - The `SecIdentity` is built in memory with `SecKeyCreateWithData` plus `SecIdentityCreate` (public on macOS 10.12+).
   - Deviation from the 2026-10-31 design, which preferred a non-exportable `kSecClassKey`: this way the identity works under the memory backend, so tests never touch the login keychain. It also uses the same single prompt path as `MobilePin`.
   - It fails closed like `secrets.rs`: a keychain read failure never generates a new identity, and only `.notFound` does.
4. **Desktop key storage is the core, not the Rust secret store.**
   - What is stored: one row in a new `host_api_identity` table. The PKCS#8 key is encrypted with the existing vault, `encrypt('host-api-identity', pkcs8Base64)` from `extension/server/vault.mjs`. That is AES-256-GCM under an HKDF of `LLMIDE_VAULT_KEY`, which `desktop/src-tauri/src/secrets.rs` already keeps in the OS keychain.
   - Why: the TLS listener runs in Node. Keeping the key in `secrets.rs` would put a second secret into the child's environment. This way the key never leaves the core process, and a headless `node server.mjs` and the tests work with no Rust host.
   - Recovery: a decrypt failure (the vault key changed) generates a new identity, revokes every v1 device and writes an `identity_reset` audit row. Every client then fails its pin check, which is the correct fail-closed result.
5. **One v1 listener per host, three modes, default off.**
   - `tls` when `LLMIDE_HOST_API_TLS=1`. On the Mac, the UserDefaults bool `HostApiV1.tlsEnabled` also selects it. It binds every interface on 3016+.
   - Otherwise `devPlaintext` under the existing Plan 2 and Plan 3 rule: DEBUG build or not production, plus `LLMIDE_HOST_API_DEV=1`. It binds loopback and checks the peer.
   - Otherwise there is no listener.
   - TLS stays opt-in until Plan 4 ships a v1 iOS client, so no LAN surface exists before a client does. Turning it on by default is Plan 4's decision.
6. **Origin allowlist: one rule on both hosts, pinned by `fixtures/security/origins.json`.**
   - Config:
     - Desktop: `LLMIDE_HOST_API_WEB_ORIGINS`.
     - Mac: that env var, else the UserDefaults string `HostApiV1.webOrigins`.
     - The value is comma-separated and defaults to empty.
   - Entry rules:
     - A valid entry is an exact `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>` (local web development), or an exact `https://<dns-name>[:port]` (the later VPS domain, for example `https://app.<your-domain>`).
     - `https://host:443` is normalised to `https://host`, because browsers omit the default port.
     - Wildcards, paths, a trailing `/`, `null`, plain `http` to a non-loopback host, and IP-literal https entries are dropped, and each dropped entry is logged by name at start.
   - Matching:
     - Comparison is case-insensitive exact string equality.
     - A request with no `Origin` header (iOS, the CLI) passes.
     - A request whose `Origin` is not listed gets HTTP 403 before the WebSocket opens.
   - This replaces Plan 3 decision 6's loopback-only regex, and gives the Mac the same allowlist the desktop got. No UI: the domain is set when the VPS exists.
7. **Token scopes.**
   - At pairing, the device is granted the host's served capabilities at that moment. `host` is always granted.
   - The grant is stored with the token: `MobilePairedDeviceStore.Device.scopes` on the Mac, the `host_api_devices.scopes` JSON column on the desktop.
   - A session's effective capabilities are `served ∩ granted`. That set is what `host.auth.*` returns, what `host.capabilities` pushes, and what the session gate checks.
   - A command whose capability the host serves but the device was not granted is refused with `denied` ("This device was not granted … — pair again to grant it.") and audited as `scope_denied`.
   - A capability enabled after pairing (for example the `tool_approvals` switch) needs a re-pair. This is the security-first reading of "scoped to granted capabilities".
   - A token with no stored scopes (paired before this plan) gets `["host", "chat", "approvals"]`, never `tool_approvals`.
   - The schema is unchanged: `host.auth.pair` has no request field for scopes, and the host decides.
8. **Audit log.**
   - Event names are shared by both hosts: `pair_ok`, `pair_failed`, `pair_throttled`, `token_failed`, `token_throttled`, `revoke_self`, `revoke_host`, `scope_denied`, `rate_closed`, `origin_refused`, `plaintext_refused`, `identity_created`, `identity_reset`. A row carries the time, event, peer address, device id when known, and a short reason (at most 200 characters).
   - *Throttled* and *refused* events are de-duplicated: at most one row per (event, peer or origin) per 60 s, so a locked-out attacker cannot fill the log.
   - **Desktop:** the existing `audit_log` table through `recordAudit(db, …)` (`extension/server/audit.mjs`), with action `host_api.<event>`. `user_id` is nullable, so unauthenticated failures fit, and the 90-day purge already exists.
   - **Mac:** a local append-only JSONL file, `~/Library/Application Support/llm-ide/host-api-audit.jsonl` (mode 0600, rotated to `.1` past 512 KiB). Each row is also echoed to the Mobile Control log pane.
   - Why not `ActivityStore`: it is a server-backed per-user feed that needs the backend and a signed-in user. Auth failures come from unauthenticated peers and must be recorded while the backend is down.
9. **Rate limits beyond pairing.**
   - Each gateway keeps its own token buckets, deleted with the session. It does not reuse `extension/server/rate-limit.mjs`, whose global map is keyed by scope (it would grow by one bucket per session id) and is persisted by `saveBuckets`.
   - Constants, identical on both hosts:

     | Bucket | Capacity | Refill | Keyed by |
     |---|---|---|---|
     | Frames | 40 | 10 per second | session |
     | Turns (`chat.send`) | 6 | 1 per 10 s | device |

   - An over-budget frame gets `rate_limited` with `retryAfterMs`. 100 rate refusals in one session close it and write `rate_closed`.
   - The pairing throttle (`PairingThrottle`, Plan 3's port) is unchanged, and the desktop keeps consulting it before a token check.
10. **Client-side pinning (iOS, web) is Plans 4 and 5.**
    - This plan ships the host side and a pinned **test** client on each host, which proves mismatch refusal end to end.
    - A browser cannot pin a self-signed certificate. How the VPS web client reaches a host (a trusted certificate on the domain, or the user trusting the host certificate once) is Plan 5's decision, recorded in Limits.
11. **Rotation:**
    - The Mac gets Settings → Mobile Control → **Reset security identity**: confirm, then a new key, every `h1-` device revoked, `identity_reset` audited, and the listener restarted. v2 devices are untouched, because v2 is a different listener.
    - A desktop reset route is deferred (Limits); the desktop rotates only on a vault-key change (decision 4).

## File Structure

| File | Responsibility |
|---|---|
| `schema/host-api/v1/fixtures/security/origins.json` (create) | Shared origin-rule cases: raw allowlist, parsed list, origin → refused |
| `schema/host-api/v1/fixtures/security/identity-vector.json` (create) | Test-only P-256 key (JWK `d`/`x`/`y`), its SPKI DER and fingerprint |
| `extension/kb/migrations/0062_host_api_security.sql` (create) | `host_api_identity` table, `host_api_devices.scopes` column |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Origins.swift` (create) | Parse the allowlist, refuse an unlisted `Origin` |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Certificate.swift` (create) | DER writer and self-signed certificate builder |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Identity.swift` (create) | Load or create the identity in the Keychain, build the `SecIdentity`, fingerprint, reset |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Listener.swift` (modify) | `Transport` (`devPlaintext` / `tls`), TLS options, allowlisted `Origin`, refusal callback |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift` (modify) | Fingerprint in hello, scopes, buckets, audit dependency |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1RateLimiter.swift` (create) | Token bucket and the two limits |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1AuditLog.swift` (create) | JSONL audit sink with de-duplication and rotation |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobilePairedDeviceStore.swift` (modify) | `Device.scopes`, `issueToken(…scopes:)`, `scopes(deviceId:)` |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift` (modify) | Mode choice, identity, `hostApiPort`/`hostApiFingerprint`, TXT, reset, audit wiring |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileConnectionInfo.swift`, `MobileBonjourAdvertiser.swift` (modify) | QR `h1port`/`h1fp`, TXT record |
| `mac/Sources/LlmIdeMac/Features/MobileControl/Views/MobileControlSettingsSection.swift` (modify) | Pass the v1 port and fingerprint to the QR; fingerprint line; Reset button |
| `mac/Package.swift` (modify) | `mobileTestExcludes` for each new test file |
| `extension/routes/host-api/origins.mjs` (create) | Node twin of `HostApiV1Origins` |
| `extension/server/host-identity.mjs` (create) | DER writer, certificate, vault-encrypted storage, fingerprint, reset |
| `extension/server/host-api-listener.mjs` (modify) | TLS mode via `https.createServer`, shared origin rule, refusal callback |
| `extension/routes/host-api/rate.mjs`, `extension/routes/host-api/audit.mjs` (create) | Token bucket; audit sink over `recordAudit` |
| `extension/routes/host-api/gateway.mjs`, `extension/kb/host-api-devices.mjs` (modify) | Fingerprint, scopes, buckets, audit |
| `extension/core/config.mjs`, `extension/server.mjs` (modify) | `hostApiTls`, mode choice, `fingerprint` in `POST /host-api/pin`, API bump |
| `desktop/src-tauri/src/core_host.rs` (modify) | Pass `LLMIDE_HOST_API_TLS` and `LLMIDE_HOST_API_WEB_ORIGINS` explicitly |
| `ui/screens/settings/sections/HostApiPairing.tsx` (modify) | Show the fingerprint next to the PIN |
| Tests: `mac/Tests/LlmIdeMacTests/HostApiV1{Origins,Identity,TLSListener,Advertisement,Scopes,AuditRate}Tests.swift`, `extension/tests/host-api-{origins,identity,tls,scopes,audit-rate}.test.mjs`, `extension/tests/helpers/pinned-ws.mjs` (create) | One file per task and host |
| `docs/explanation/invariants.md`, `extension/CLAUDE.md`, `mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md`, `docs/mobile/quick-start.md`, `schema/host-api/v1/README.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | Docs and plan status (Task 9) |

## Task order and parallelism

| Wave | Tasks | Why this order |
|---|---|---|
| A | **Task 1** | The fixtures and migration every later task reads. Small. |
| B | **Task 2 ∥ Task 3 ∥ Task 7** | Disjoint files: Mac identity (new files), desktop identity (new files), scopes. Task 7 edits both gateways and both device stores, which nothing else in this wave touches. |
| C | **Task 4 ∥ Task 6** | Mac listener + manager, and desktop listener + `server.mjs`. Both edit their gateway's `host.hello`, so each starts after Task 7 has committed. |
| D | **Task 5 ∥ Task 8** | Task 5 edits the Mac manager after Task 4. Task 8 edits both gateways after Tasks 4, 6 and 7. They touch disjoint files except `MobileControlManager.swift`. Run them sequentially if one implementer would touch the same region (Task 5's TXT/QR wiring and Task 8's audit wiring sit in different functions). |
| E | **Task 9** | Docs, plan status and the full gate |

---

### Task 1: Shared security fixtures and the migration

**Files:**
- Create: `schema/host-api/v1/fixtures/security/origins.json`, `schema/host-api/v1/fixtures/security/identity-vector.json`, `schema/host-api/v1/fixtures/security/README.md`
- Create: `extension/kb/migrations/0062_host_api_security.sql` (if Plan 3 or another plan has taken 0062 by then, use the next free number and say so in the report)
- Test: `extension/tests/host-api-security-fixtures.test.mjs`

**Interfaces:**
- Produces:
  - `origins.json`: `{allowlist: string, parsed: string[], cases: [{origin: string | null, refused: boolean}]}`. Here `origin: null` means no header.
  - `identity-vector.json`: `{d, x, y, spkiDerBase64, fingerprint}`, with `d`/`x`/`y` as base64url JWK members.
  - Migration 0062.

- [ ] **Step 1: Write `origins.json`**

```json
{
  "allowlist": "http://localhost:5173, https://App.Example.com, https://app.example.org:8443, https://example.net:443, http://evil.example, *, https://*.example.com, http://localhost:5173/, null, https://192.168.1.20, http://127.0.0.1:99999, http://[::1]:3000",
  "parsed": ["http://localhost:5173", "https://app.example.com", "https://app.example.org:8443", "https://example.net", "http://[::1]:3000"],
  "cases": [
    { "origin": null, "refused": false },
    { "origin": "http://localhost:5173", "refused": false },
    { "origin": "HTTP://LOCALHOST:5173", "refused": false },
    { "origin": "http://localhost:5174", "refused": true },
    { "origin": "https://app.example.com", "refused": false },
    { "origin": "https://app.example.com:443", "refused": true },
    { "origin": "https://evil.app.example.com", "refused": true },
    { "origin": "http://app.example.com", "refused": true },
    { "origin": "https://app.example.org:8443", "refused": false },
    { "origin": "https://example.net", "refused": false },
    { "origin": "null", "refused": true },
    { "origin": "", "refused": true },
    { "origin": "http://localhost:5173, https://app.example.com", "refused": true },
    { "origin": "http://[::1]:3000", "refused": false }
  ]
}
```

- [ ] **Step 2: Generate `identity-vector.json` once, with Node**

```bash
node -e "const c=require('crypto');const {privateKey,publicKey}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});const j=privateKey.export({format:'jwk'});const spki=publicKey.export({type:'spki',format:'der'});console.log(JSON.stringify({note:'TEST VECTOR ONLY - never a real host identity',d:j.d,x:j.x,y:j.y,spkiDerBase64:spki.toString('base64'),fingerprint:'sha256:'+c.createHash('sha256').update(spki).digest('base64url')},null,2))" > schema/host-api/v1/fixtures/security/identity-vector.json
```

Cross-check the fingerprint independently with openssl, from `spkiDerBase64`:

```bash
node -e "process.stdout.write(Buffer.from(require('./schema/host-api/v1/fixtures/security/identity-vector.json').spkiDerBase64,'base64'))" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='
```

The output must equal the part after `sha256:`. If the repo's secret scanner (`make regression` guardrails, a pre-commit hook) flags the file, add it to that scanner's documented test-fixture allowlist. Do not weaken the pattern.

`README.md` (three lines): what each file is, that both hosts' tests read them, and that the key is a public test vector.

- [ ] **Step 3: Write the migration**

```sql
-- Host API v1 security (Plan 6): the desktop host's TLS identity (one row; key vault-encrypted)
-- and the capabilities each paired device was granted (JSON array; NULL = paired before scopes).
CREATE TABLE host_api_identity (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  cert_der    BLOB NOT NULL,
  key_enc     BLOB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  not_after   INTEGER NOT NULL
);
ALTER TABLE host_api_devices ADD COLUMN scopes TEXT;
```

`host_api_identity` is install-level, not per-user, so it is **not** added to the per-user deletion list in `kb/db.mjs`. Say so in a one-line comment beside that list (near the migration 0061 entry, `kb/db.mjs:1050`).

- [ ] **Step 4: Write the fixture test, run it**

`extension/tests/host-api-security-fixtures.test.mjs` checks three things:
- the vector's fingerprint equals `sha256:` plus base64url(SHA-256(`spkiDerBase64`));
- `crypto.createPrivateKey({key: {kty: 'EC', crv: 'P-256', d, x, y}, format: 'jwk'})` exports the same SPKI;
- the migration applies on a fresh temp DB (copy the header of `tests/host-api-devices.test.mjs`) and `host_api_devices` has a `scopes` column (`PRAGMA table_info`).

Run: `cd extension && node --test tests/host-api-security-fixtures.test.mjs`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add schema/host-api/v1/fixtures/security extension/kb/migrations/0062_host_api_security.sql extension/kb/db.mjs extension/tests/host-api-security-fixtures.test.mjs
git commit -m "test(host-api): add shared origin and TLS identity fixtures and the security migration"
```

---

### Task 2: Mac host identity (key, certificate, fingerprint) — parallel-safe with Tasks 3 and 7

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Certificate.swift`, `…/HostApi/HostApiV1Identity.swift`
- Modify: `mac/Package.swift` (`mobileTestExcludes` += `HostApiV1IdentityTests.swift`)
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1IdentityTests.swift`

**Interfaces:**
- Produces:
  - `enum HostApiV1Certificate { static func selfSigned(key: P256.Signing.PrivateKey, commonName: String, notBefore: Date, notAfter: Date, serial: Data) throws -> Data }`
  - `enum HostApiV1Identity`:
    - `static let account = "mobile::hostapi-identity"`
    - `static let validity: TimeInterval = 5 * 365 * 24 * 3600`
    - `struct Loaded { let identity: SecIdentity; let certificateDER: Data; let fingerprint: String; let notAfter: Date; let created: Bool }`
    - `enum Failure: Error, Equatable { case keychain(OSStatus), corrupt, securityFramework(String) }`
    - `static func loadOrCreate(hostName: String, now: Date = Date(), backend: RawKeychainAccess = KeychainStore.backend) throws -> Loaded`
    - `static func reset(backend: RawKeychainAccess = KeychainStore.backend)`
    - `static func fingerprint(spkiDER: Data) -> String`
    - `static func fingerprint(certificate: SecCertificate) -> String?`

- [ ] **Step 1: Write the failing tests**

```swift
import Testing
import Foundation
import CryptoKit
import Security
@testable import LlmIdeMacLib

@Suite("HostApiV1Identity")
struct HostApiV1IdentityTests {
    static let vector: [String: String] = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../schema/host-api/v1/fixtures/security/identity-vector.json").standardized
        return (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: String] ?? [:]
    }()
    static func b64url(_ s: String) -> Data {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)!
    }

    @Test("the fingerprint matches the shared Node/openssl vector")
    func vectorFingerprint() throws {
        let key = try P256.Signing.PrivateKey(rawRepresentation: Self.b64url(Self.vector["d"]!))
        #expect(key.publicKey.derRepresentation.base64EncodedString() == Self.vector["spkiDerBase64"])
        #expect(HostApiV1Identity.fingerprint(spkiDER: key.publicKey.derRepresentation) == Self.vector["fingerprint"])
    }

    @Test("the certificate parses, carries the key, and verifies its own signature")
    func certificateParses() throws {
        let key = P256.Signing.PrivateKey()
        let der = try HostApiV1Certificate.selfSigned(key: key, commonName: "LLM-IDE Test", notBefore: Date(timeIntervalSince1970: 1_760_000_000),
                                                       notAfter: Date(timeIntervalSince1970: 1_760_000_000 + HostApiV1Identity.validity), serial: Data(repeating: 0x7F, count: 16))
        let cert = try #require(SecCertificateCreateWithData(nil, der as CFData))
        #expect(HostApiV1Identity.fingerprint(certificate: cert) == HostApiV1Identity.fingerprint(spkiDER: key.publicKey.derRepresentation))
        #expect((SecCertificateCopySubjectSummary(cert) as String?) == "LLM-IDE Test")
        // Self-signature: the TBS (first element of the outer SEQUENCE) verifies under the public key.
        let (tbs, sig) = try #require(Self.split(der))
        #expect(key.publicKey.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: sig), for: tbs))
    }

    @Test("load-or-create persists one identity; reset makes a new one; a read failure never regenerates")
    func persistence() throws {
        let backend = InMemoryKeychainAccess()
        let a = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend)
        let b = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend)
        #expect(a.created && !b.created)
        #expect(a.fingerprint == b.fingerprint)
        #expect(a.fingerprint.hasPrefix("sha256:") && a.fingerprint.count == 7 + 43)
        HostApiV1Identity.reset(backend: backend)
        #expect(try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend).fingerprint != a.fingerprint)
        let locked = FailingKeychain(status: errSecInteractionNotAllowed)
        #expect(throws: HostApiV1Identity.Failure.keychain(errSecInteractionNotAllowed)) { try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: locked) }
        #expect(locked.writes == 0)
        let corrupt = InMemoryKeychainAccess()
        _ = corrupt.write(account: HostApiV1Identity.account, service: "com.llmide.macapp", data: Data("junk".utf8))
        #expect(throws: HostApiV1Identity.Failure.corrupt) { try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: corrupt) }
    }

    /// Outer SEQUENCE → (tbs TLV bytes, signature DER without the BIT STRING's unused-bits byte).
    static func split(_ der: Data) -> (Data, Data)? { /* walk: skip outer header, read TLV 1 (tbs), TLV 2 (alg), TLV 3 (bitstring) */ HostApiV1CertificateTestDER.split(der) }
}

final class FailingKeychain: RawKeychainAccess, @unchecked Sendable {
    let status: OSStatus; private(set) var writes = 0
    init(status: OSStatus) { self.status = status }
    func read(account: String, service: String) -> KeychainRawRead { .failed(status) }
    func write(account: String, service: String, data: Data) -> Bool { writes += 1; return false }
    func delete(account: String, service: String) {}
    func deleteAll(service: String) -> OSStatus { errSecSuccess }
}
```

Write `HostApiV1CertificateTestDER.split` in the test file. It is a 15-line TLV walker that reads the length forms 0x81 and 0x82. If `RawKeychainAccess` has more requirements than the four listed at `KeychainStore.swift:17–22`, add them to `FailingKeychain`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1IdentityTests > /tmp/h6-t2.log 2>&1; tail -20 /tmp/h6-t2.log`
Expected: compile failure, because `HostApiV1Identity` is not defined.

- [ ] **Step 3: Implement**

`HostApiV1Certificate.swift`:

```swift
import Foundation
import CryptoKit

/// Self-signed X.509 v3 server certificate for the Host API v1 TLS listener, hand-built DER (no ASN.1
/// dependency). The client pins the SPKI hash, so names and the CA chain carry no trust; the fields are
/// the minimum a TLS stack accepts. Mirrored byte-for-byte in structure by extension/server/host-identity.mjs.
enum HostApiV1Certificate {
    static func tlv(_ tag: UInt8, _ body: Data) -> Data {
        var out = Data([tag])
        if body.count < 0x80 { out.append(UInt8(body.count)) } else {
            var n = body.count; var len: [UInt8] = []
            while n > 0 { len.insert(UInt8(n & 0xFF), at: 0); n >>= 8 }
            out.append(0x80 | UInt8(len.count)); out.append(contentsOf: len)
        }
        return out + body
    }
    static func seq(_ parts: Data...) -> Data { tlv(0x30, parts.reduce(Data(), +)) }
    static func oid(_ bytes: [UInt8]) -> Data { tlv(0x06, Data(bytes)) }
    static func int(_ raw: Data) -> Data {
        var b = [UInt8](raw)
        while b.count > 1, b[0] == 0, b[1] & 0x80 == 0 { b.removeFirst() }
        if let f = b.first, f & 0x80 != 0 { b.insert(0, at: 0) }
        return tlv(0x02, Data(b))
    }
    static func utcTime(_ date: Date) -> Data {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyMMddHHmmss'Z'"
        return tlv(0x17, Data(f.string(from: date).utf8))
    }

    static let ecdsaWithSHA256: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]

    static func selfSigned(key: P256.Signing.PrivateKey, commonName: String, notBefore: Date, notAfter: Date, serial: Data) throws -> Data {
        // UTCTime covers years < 2050; a 5-year certificate minted before 2045 never needs GeneralizedTime.
        precondition(Calendar(identifier: .gregorian).component(.year, from: notAfter) < 2050)
        let name = seq(tlv(0x31, seq(oid([0x55, 0x04, 0x03]), tlv(0x0C, Data(commonName.utf8)))))
        let alg = seq(oid(ecdsaWithSHA256))
        let extensions = tlv(0xA3, seq(
            seq(oid([0x55, 0x1D, 0x13]), tlv(0x01, Data([0xFF])), tlv(0x04, seq())),                          // basicConstraints CA:FALSE, critical
            seq(oid([0x55, 0x1D, 0x0F]), tlv(0x01, Data([0xFF])), tlv(0x04, tlv(0x03, Data([0x07, 0x80])))),  // keyUsage digitalSignature, critical
            seq(oid([0x55, 0x1D, 0x25]), tlv(0x04, seq(oid([0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01]))))  // extKeyUsage serverAuth
        ))
        let tbs = seq(tlv(0xA0, int(Data([2]))), int(serial), alg, name,
                      seq(utcTime(notBefore), utcTime(notAfter)), name, key.publicKey.derRepresentation, extensions)
        let signature = try key.signature(for: tbs).derRepresentation
        return seq(tbs, alg, tlv(0x03, Data([0]) + signature))
    }
}
```

`HostApiV1Identity.swift`:

```swift
import Foundation
import CryptoKit
import Security

/// The Mac's Host API v1 TLS identity: created once, kept in the Keychain (ThisDeviceOnly, never synced),
/// never sent anywhere. Clients pin `fingerprint` (SHA-256 of the SPKI) from the QR. A keychain read failure
/// is an error, never a reason to mint a new identity (that would silently break every pin).
enum HostApiV1Identity {
    static let account = "mobile::hostapi-identity"
    private static let service = "com.llmide.macapp"   // same item service as MobilePin / KeychainStore
    static let validity: TimeInterval = 5 * 365 * 24 * 3600

    struct Loaded { let identity: SecIdentity; let certificateDER: Data; let fingerprint: String; let notAfter: Date; let created: Bool }
    enum Failure: Error, Equatable { case keychain(OSStatus), corrupt, securityFramework(String) }
    private struct Material: Codable { let key: Data; let cert: Data; let notAfter: Date }

    static func loadOrCreate(hostName: String, now: Date = Date(), backend: RawKeychainAccess = KeychainStore.backend) throws -> Loaded {
        switch backend.read(account: account, service: service) {
        case .failed(let status): throw Failure.keychain(status)
        case .found(let data):
            guard let m = try? JSONDecoder().decode(Material.self, from: data),
                  let key = try? P256.Signing.PrivateKey(rawRepresentation: m.key) else { throw Failure.corrupt }
            return try build(key: key, cert: m.cert, notAfter: m.notAfter, created: false)
        case .notFound:
            let key = P256.Signing.PrivateKey()
            var serial = Data((0..<16).map { _ in UInt8.random(in: 0...255) }); serial[0] = (serial[0] & 0x7F) | 0x01
            let notAfter = now.addingTimeInterval(validity)
            let cn = "LLM-IDE " + String(hostName.prefix(64))
            let cert = try HostApiV1Certificate.selfSigned(key: key, commonName: cn, notBefore: now.addingTimeInterval(-300), notAfter: notAfter, serial: serial)
            let blob = try JSONEncoder().encode(Material(key: key.rawRepresentation, cert: cert, notAfter: notAfter))
            guard backend.write(account: account, service: service, data: blob) else { throw Failure.keychain(errSecIO) }
            return try build(key: key, cert: cert, notAfter: notAfter, created: true)
        }
    }

    static func reset(backend: RawKeychainAccess = KeychainStore.backend) { backend.delete(account: account, service: service) }

    static func fingerprint(spkiDER: Data) -> String {
        "sha256:" + Data(SHA256.hash(data: spkiDER)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func fingerprint(certificate: SecCertificate) -> String? {
        guard let pub = SecCertificateCopyKey(certificate),
              let x963 = SecKeyCopyExternalRepresentation(pub, nil) as Data?,
              let key = try? P256.Signing.PublicKey(x963Representation: x963) else { return nil }
        return fingerprint(spkiDER: key.derRepresentation)
    }

    private static func build(key: P256.Signing.PrivateKey, cert der: Data, notAfter: Date, created: Bool) throws -> Loaded {
        guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { throw Failure.corrupt }
        let attrs: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits: 256]
        var err: Unmanaged<CFError>?
        guard let secKey = SecKeyCreateWithData(key.x963Representation as CFData, attrs as CFDictionary, &err) else {
            throw Failure.securityFramework(String(describing: err?.takeRetainedValue()))
        }
        guard let identity = SecIdentityCreate(nil, cert, secKey) else { throw Failure.securityFramework("SecIdentityCreate returned nil") }
        guard let fp = fingerprint(certificate: cert), fp == fingerprint(spkiDER: key.publicKey.derRepresentation) else { throw Failure.corrupt }
        return Loaded(identity: identity, certificateDER: der, fingerprint: fp, notAfter: notAfter, created: created)
    }
}
```

Add `"HostApiV1IdentityTests.swift"` to `mobileTestExcludes` in `mac/Package.swift` (the set at about line 242).

- [ ] **Step 4: Run the tests and the boundary gate**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1IdentityTests > /tmp/h6-t2.log 2>&1; tail -20 /tmp/h6-t2.log && cd .. && bash mac/Scripts/feature-boundaries.sh`
Expected: 3 tests pass and the gate is clean. Run SwiftPM unsandboxed if it reports "Operation not permitted".

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Certificate.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Identity.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1IdentityTests.swift mac/Package.swift
git commit -m "feat(mac): create and keep a pinned Host API v1 TLS identity in the Keychain"
```

---

### Task 3: Desktop host identity — parallel-safe with Tasks 2 and 7

**Files:**
- Create: `extension/server/host-identity.mjs`
- Test: `extension/tests/host-api-identity.test.mjs`

**Interfaces:**
- Produces:
  - `buildSelfSignedCert({privateKey, publicKey, commonName, notBefore, notAfter, serial}) -> Buffer` (DER)
  - `fingerprintOfSpki(spkiDer: Buffer) -> string`
  - `loadOrCreateHostIdentity(db, {hostName, now = Date.now(), onEvent = () => {}}) -> {certPem, keyPem, fingerprint, notAfter, created}`
  - `resetHostIdentity(db)`
  - `VALIDITY_MS = 5 * 365 * 24 * 3600 * 1000`
- `onEvent(name)` receives `'identity_created'` or `'identity_reset'`; Task 8 wires it to the audit sink.
- On a vault decrypt failure the function calls `resetHostIdentity`, deletes every `host_api_devices` row (`DELETE FROM host_api_devices`, a deliberate all-users wipe with a comment saying why), emits `identity_reset`, and creates a new identity.

- [ ] **Step 1: Write the failing test**

```js
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const id = await import('../server/host-identity.mjs');
const { getDb } = await import('../kb/db.mjs');
const vector = JSON.parse(readFileSync(new URL('../../schema/host-api/v1/fixtures/security/identity-vector.json', import.meta.url)));

test('the fingerprint matches the shared vector', () => {
  assert.equal(id.fingerprintOfSpki(Buffer.from(vector.spkiDerBase64, 'base64')), vector.fingerprint);
});

test('the certificate parses, is self-signed, not a CA, for server auth, and holds the key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = id.buildSelfSignedCert({ privateKey, publicKey, commonName: 'LLM-IDE Test', notBefore: 1_760_000_000_000,
    notAfter: 1_760_000_000_000 + id.VALIDITY_MS, serial: Buffer.alloc(16, 0x7f) });
  const x = new X509Certificate(der);
  assert.equal(x.subject, 'CN=LLM-IDE Test');
  assert.equal(x.ca, false);
  assert.ok(x.verify(x.publicKey), 'self-signature verifies');
  assert.ok(x.checkPrivateKey(privateKey));
  assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.1']);
});

test('load-or-create persists one identity, encrypted; a vault change resets and wipes v1 devices', () => {
  const db = getDb();
  id.resetHostIdentity(db);
  const events = [];
  const a = id.loadOrCreateHostIdentity(db, { hostName: 'Desk', onEvent: (e) => events.push(e) });
  const b = id.loadOrCreateHostIdentity(db, { hostName: 'Desk' });
  assert.ok(a.created && !b.created);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^sha256:[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT key_enc FROM host_api_identity').get();
  assert.ok(!row.key_enc.toString('latin1').includes('PRIVATE KEY'), 'key is not stored in the clear');
  db.prepare('UPDATE host_api_identity SET key_enc = ?').run(Buffer.alloc(40, 1)); // simulates a vault key change
  const c = id.loadOrCreateHostIdentity(db, { hostName: 'Desk', onEvent: (e) => events.push(e) });
  assert.notEqual(c.fingerprint, a.fingerprint);
  assert.deepEqual(events, ['identity_created', 'identity_reset', 'identity_created']);
});
```

Copy the temp-DB header (`NODE_TEST_CONTEXT`) from `tests/host-api-devices.test.mjs`. In the reset test, also issue a device first through `issueDeviceToken`, and assert that it no longer authenticates after the reset.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/host-api-identity.test.mjs`
Expected: FAIL, `Cannot find module '../server/host-identity.mjs'`.

- [ ] **Step 3: Implement**

```js
// Host API v1 TLS identity for the desktop core (Plan 6). One self-signed P-256 certificate per install;
// clients pin fingerprintOfSpki(SPKI). The private key is stored vault-encrypted (LLMIDE_VAULT_KEY, kept
// in the OS keychain by the Rust host) and never leaves this process. Structure mirrors the Mac's
// HostApiV1Certificate.swift; both are checked against schema/host-api/v1/fixtures/security/.
import crypto, { X509Certificate } from 'node:crypto';
import { encrypt, decrypt } from './vault.mjs';

export const VALIDITY_MS = 5 * 365 * 24 * 3600 * 1000;
const VAULT_SCOPE = 'host-api-identity'; // HKDF salt: separates this key from every per-user vault key

const tlv = (tag, body) => {
  const n = body.length;
  let len;
  if (n < 0x80) len = Buffer.from([n]);
  else { const b = []; for (let v = n; v > 0; v >>= 8) b.unshift(v & 0xff); len = Buffer.from([0x80 | b.length, ...b]); }
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
const int = (raw) => {
  let b = raw;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const utc = (ms) => {
  const d = new Date(ms);
  if (d.getUTCFullYear() >= 2050) throw new Error('UTCTime covers years before 2050 only');
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const ECDSA_SHA256 = '2a8648ce3d040302';

export function buildSelfSignedCert({ privateKey, publicKey, commonName, notBefore, notAfter, serial }) {
  const name = seq(tlv(0x31, seq(oid('550403'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
  const alg = seq(oid(ECDSA_SHA256));
  const ext = tlv(0xa3, seq(
    seq(oid('551d13'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())),
    seq(oid('551d0f'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x07, 0x80])))),
    seq(oid('551d25'), tlv(0x04, seq(oid('2b06010505070301')))),
  ));
  const tbs = seq(tlv(0xa0, int(Buffer.from([2]))), int(serial), alg, name, seq(utc(notBefore), utc(notAfter)), name,
    publicKey.export({ type: 'spki', format: 'der' }), ext);
  return seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
}

export const fingerprintOfSpki = (spki) => `sha256:${crypto.createHash('sha256').update(spki).digest('base64url')}`;

export function resetHostIdentity(db) { db.prepare('DELETE FROM host_api_identity').run(); }

export function loadOrCreateHostIdentity(db, { hostName, now = Date.now(), onEvent = () => {} }) {
  const row = db.prepare('SELECT cert_der, key_enc, fingerprint, not_after FROM host_api_identity WHERE id = 1').get();
  if (row) {
    try {
      const keyPem = crypto.createPrivateKey({ key: Buffer.from(decrypt(VAULT_SCOPE, row.key_enc), 'base64'), format: 'der', type: 'pkcs8' })
        .export({ type: 'pkcs8', format: 'pem' });
      return { certPem: new X509Certificate(row.cert_der).toString(), keyPem, fingerprint: row.fingerprint, notAfter: row.not_after, created: false };
    } catch {
      // The vault key changed (or the row was tampered with): the old key is unrecoverable. Every pinned
      // client will now fail its pin check, which is the intended fail-closed result; their tokens were
      // bound to the old identity, so they go too (all users: the identity is per install).
      db.transaction(() => { resetHostIdentity(db); db.prepare('DELETE FROM host_api_devices').run(); })();
      onEvent('identity_reset');
    }
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01;
  const notAfter = now + VALIDITY_MS;
  const der = buildSelfSignedCert({ privateKey, publicKey, commonName: `LLM-IDE ${String(hostName).slice(0, 64)}`, notBefore: now - 300_000, notAfter, serial });
  const fingerprint = fingerprintOfSpki(publicKey.export({ type: 'spki', format: 'der' }));
  const keyEnc = encrypt(VAULT_SCOPE, privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
  db.prepare('INSERT INTO host_api_identity (id, cert_der, key_enc, fingerprint, created_at, not_after) VALUES (1, ?, ?, ?, ?, ?)')
    .run(der, keyEnc, fingerprint, now, notAfter);
  onEvent('identity_created');
  return { certPem: new X509Certificate(der).toString(), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint, notAfter, created: true };
}
```

Check whether `decrypt` returns a string (it mirrors `encrypt`'s string input), and adjust the `Buffer.from(…, 'base64')` if it does not.

- [ ] **Step 4: Run the tests and the lint**

Run: `cd extension && node --test tests/host-api-identity.test.mjs && npx eslint server/host-identity.mjs`
Expected: 3 pass and 0 problems.

- [ ] **Step 5: Commit**

```bash
git add extension/server/host-identity.mjs extension/tests/host-api-identity.test.mjs
git commit -m "feat(server): create a vault-encrypted Host API v1 TLS identity"
```

---

### Task 4: Mac TLS listener, Origin allowlist and the fingerprint in `host.hello` (after Tasks 1, 2 and 7)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Origins.swift`
- Modify: `…/HostApi/HostApiV1Listener.swift`, `…/HostApi/HostApiV1Gateway.swift`, `…/Services/MobileControlManager.swift` (the block at about lines 447–474, and `makeHostApiDependencies` at about 559)
- Modify: `mac/Package.swift` (`mobileTestExcludes` += `HostApiV1OriginsTests.swift`, `HostApiV1TLSListenerTests.swift`)
- Modify: `mac/Tests/LlmIdeMacTests/HostApiV1ListenerTests.swift` (the `origin` test now passes an allowlist)
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1OriginsTests.swift`, `mac/Tests/LlmIdeMacTests/HostApiV1TLSListenerTests.swift`

**Interfaces:**
- `enum HostApiV1Origins`:
  - `static func parse(_ raw: String, log: (String) -> Void) -> [String]`
  - `static func refused(headers: [(name: String, value: String)], allowlist: [String]) -> Bool`
  - `static func configured(environment: [String: String], defaults: UserDefaults) -> String`: env `LLMIDE_HOST_API_WEB_ORIGINS`, else the string at `HostApiV1.webOrigins`, else `""`.
  - Same patterns as Task 6's Node twin:
    - loopback: `^http://(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$`
    - https: `^https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([0-9]{1,5}))?$`
    - Parsing: lowercase, trim, drop a port outside 1–65535, strip `:443` from https, drop an https host that is all digits and dots, de-duplicate.
  - Use `NSRegularExpression` so the pattern strings are literally the Node ones.
- `HostApiV1Listener`:
  - `enum Transport { case devPlaintext; case tls(SecIdentity) }`
  - `enum Mode: Equatable { case off, devPlaintext, tls }`
  - `static func mode(environment: [String: String], defaults: UserDefaults, isDebugBuild: Bool) -> Mode`: `tls` if `LLMIDE_HOST_API_TLS == "1"` or `defaults.bool(forKey: "HostApiV1.tlsEnabled")`; else `devPlaintext` if `devListenerAllowed`; else `off`.
  - `init(…, transport: Transport, originAllowlist: [String], onRefused: @escaping (_ event: String, _ peer: String, _ detail: String) -> Void, …)`, keeping every existing parameter.
  - `static func refusesHandshake(headers:)` becomes `refusesHandshake(headers:allowlist:)`.
  - `static func tlsOptions(identity: SecIdentity) -> NWProtocolTLS.Options`
- `HostApiV1Gateway.Dependencies` gains `certificateFingerprint: () -> String?`. `host.hello` passes it to the generated `HostApiHostHelloResult` initializer; check that generated initializer's label order in SharedProtocol, where the generator sorts labels.
- `MobileControlManager` gains `private(set) var hostApiPort: Int?` and `private(set) var hostApiFingerprint: String?`, declared like `activePort` (line 73, `@Observable` class).

- [ ] **Step 1: Write the failing tests**

`HostApiV1OriginsTests.swift` loads `schema/host-api/v1/fixtures/security/origins.json` the way `HostApiV1IdentityTests` loads the vector. It asserts:
- `parse(allowlist) == parsed`, and the log received one line per dropped entry (7 of them);
- for every case, `refused(headers: origin == nil ? [] : [("Origin", origin)], allowlist: parsed) == refused`;
- `configured` prefers the env value over a `UserDefaults(suiteName: "h6-test-\(UUID())")` value, and returns `""` when neither is set.

`HostApiV1TLSListenerTests.swift` (`@Suite(.serialized)`, binds ephemeral ports in `3016 + Int.random(in: 1000...1900)`):

```swift
import Testing
import Foundation
import Network
import Security
@testable import LlmIdeMacLib

@Suite("HostApiV1 TLS listener", .serialized)
struct HostApiV1TLSListenerTests {
    /// A pinned v1 test client: TLS whose verify block accepts ONLY the expected SPKI fingerprint, WebSocket on top.
    static func pinnedClient(port: Int, fingerprint: String, queue: DispatchQueue) -> NWConnection {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let t = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let chain = SecTrustCopyCertificateChain(t) as? [SecCertificate], let leaf = chain.first,
                  let fp = HostApiV1Identity.fingerprint(certificate: leaf) else { return complete(false) }
            complete(fp == fingerprint)
        }, queue)
        let params = NWParameters(tls: tls)
        params.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        return NWConnection(to: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(port))!), using: params)
    }
    // Tests:
    // 1. mode(): TLS env or default → .tls (even without DEBUG); dev flag + DEBUG → .devPlaintext; nothing → .off;
    //    TLS wins over dev when both are set.
    // 2. "a pinned client with the right fingerprint connects and its frame reaches the gateway":
    //    identity = loadOrCreate(backend: InMemoryKeychainAccess()); start a .tls listener; the pinned client
    //    sends host.ping; FrameBox gets it.
    // 3. "a client pinned to another fingerprint is refused before any frame": a second identity's fingerprint;
    //    the connection reaches .failed (or .waiting with a TLS error), and onOpen/onFrame are never called
    //    (wait 2 s).
    // 4. "plaintext to the TLS port is refused": URLSession ws:// to the TLS port fails, and onOpen is never called.
    // 5. "a listed Origin is accepted and an unlisted one refused, with origin_refused reported": two raw
    //    handshakes over the pinned TLS client, adding the header with NWProtocolWebSocket.Options.setAdditionalHeaders;
    //    onRefused receives ("origin_refused", "-", "https://evil.example").
    // 6. "the dev plaintext listener still binds loopback only": reuse the existing loopbackRoundTrip with transport
    //    .devPlaintext; static check that bind(.devPlaintext) sets requiredLocalEndpoint to loopback (assert through a
    //    `static func parameters(for:port:)` helper you extract, so the test inspects NWParameters without binding).
}
```

Write each test fully with `#expect`/`#require`, reusing `FrameBox` from `HostApiV1ListenerTests.swift`. In `HostApiV1ListenerTests.origin`, replace the call with `refusesHandshake(headers:allowlist: [])`. The existing three expectations keep their meaning: an empty allowlist refuses every `Origin`.

Add one scenario to `HostApiV1GatewayTests.swift`: `host.hello` includes `certificateFingerprint` when the dependency returns one, and omits it when it returns nil.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter 'HostApiV1(Origins|TLSListener|Listener|Gateway)Tests' > /tmp/h6-t4.log 2>&1; tail -30 /tmp/h6-t4.log`
Expected: compile failure.

- [ ] **Step 3: Implement**

Listener changes, in `HostApiV1Listener.swift`:

```swift
static func tlsOptions(identity: SecIdentity) -> NWProtocolTLS.Options {
    let tls = NWProtocolTLS.Options()
    let sec = tls.securityProtocolOptions
    sec_protocol_options_set_local_identity(sec, sec_identity_create(identity)!)
    sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv12)
    return tls
}

static func parameters(for transport: Transport, port: NWEndpoint.Port, ws: NWProtocolWebSocket.Options) -> NWParameters {
    let params: NWParameters
    switch transport {
    case .devPlaintext:
        params = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
    case .tls(let identity):
        // Every interface: TLS is what makes a non-loopback peer acceptable (spec "Security").
        params = NWParameters(tls: tlsOptions(identity: identity), tcp: NWProtocolTCP.Options())
    }
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    return params
}
```

- In `bind()`:
  - Build `params` with `parameters(for:port:ws:)`.
  - In TLS mode, create the listener with `NWListener(using: params, on: port)`. Keep the `requiredLocalEndpoint` form for plaintext.
  - The client request handler refuses with `Self.refusesHandshake(headers: pairs, allowlist: originAllowlist)`. On a refusal, call `onRefused("origin_refused", "-", <the Origin value clamped to 200>)`, because Network.framework does not hand this handler the peer.
  - Change the ready log line to say "TLS, all interfaces" or "development, loopback only".
- In `accept()`, keep the loopback guard **only** for `.devPlaintext`. A non-loopback peer there calls `onRefused("plaintext_refused", "\(host)", "")` before `conn.cancel()`.

Gateway: add `certificateFingerprint` to `Dependencies` and pass it in `.hostHello`.

Manager (the block that now checks `devListenerAllowed`):

```swift
switch HostApiV1Listener.mode(environment: ProcessInfo.processInfo.environment, defaults: .standard, isDebugBuild: HostApiV1Listener.isDebugBuild) {
case .off: break
case .devPlaintext: startHostApi(transport: .devPlaintext, fingerprint: nil)
case .tls:
    do {
        let id = try HostApiV1Identity.loadOrCreate(hostName: Self.deviceName())
        startHostApi(transport: .tls(id.identity), fingerprint: id.fingerprint)
    } catch {
        append(.stderr, "Host API v1 TLS listener did not start: the security identity is unavailable (\(error)). Unlock the keychain or use Reset security identity.")
    }
}
```

Move the existing listener, gateway and drain construction into `private func startHostApi(transport:fingerprint:)` unchanged, then add the new pieces:
- `originAllowlist: HostApiV1Origins.parse(HostApiV1Origins.configured(environment:defaults:), log: { [weak self] l in self?.append(.info, l) })`;
- `onRefused` appends a log line (Task 8 adds the audit row);
- `onListening: { [weak self] port in Task { @MainActor in self?.hostApiPort = port } }`;
- `hostApiFingerprint = fingerprint`;
- `makeHostApiDependencies(fingerprint:)` passing `certificateFingerprint: { fingerprint }`.

In the teardown (about line 594), clear `hostApiPort` and `hostApiFingerprint`.

- [ ] **Step 4: Run the tests, the whole Mac suite and the gate**

Run:
- `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1 > /tmp/h6-t4.log 2>&1; tail -30 /tmp/h6-t4.log`
- `LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/mac-test.log 2>&1; tail -5 /tmp/mac-test.log`
- `cd .. && bash mac/Scripts/feature-boundaries.sh`

Run them unsandboxed (they bind ports). Expected: all pass and the gate is clean.

If the TLS handshake fails only because the `SecKey` is in memory (an `errSecItemNotFound` / `-25300` in the listener log), stop and report it. The fallback is a permanent `kSecClassKey` item (2026-10-31 design §3.1) behind the same `HostApiV1Identity` interface, and it needs a decision because its test then cannot use the memory backend.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Origins.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Listener.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift mac/Package.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1OriginsTests.swift mac/Tests/LlmIdeMacTests/HostApiV1TLSListenerTests.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1ListenerTests.swift mac/Tests/LlmIdeMacTests/HostApiV1GatewayTests.swift
git commit -m "feat(mac): serve Host API v1 over pinned TLS and allowlist web origins"
```

---

### Task 5: Mac QR, Bonjour TXT and Reset security identity (after Task 4)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileConnectionInfo.swift`, `…/Services/MobileBonjourAdvertiser.swift`, `…/Services/MobileControlManager.swift`, `…/Views/MobileControlSettingsSection.swift`
- Modify: `mac/Package.swift` (`mobileTestExcludes` += `HostApiV1AdvertisementTests.swift`)
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1AdvertisementTests.swift`

**Interfaces:**
- `MobileConnectionInfo`:
  - `current(port:hostApiPort: Int? = nil, hostApiFingerprint: String? = nil)`.
  - When both v1 values are non-nil, the QR gains `h1port=<port>&h1fp=<fingerprint>&api=1`. The existing `ip`/`port`/`pin` stay first and unchanged, so today's iOS parser (`ios_app/MyApp/Views/Control/QRScannerView.swift`, which looks items up by name) keeps working.
  - New stored fields `hostApiPort` and `hostApiFingerprint`, for the Settings text.
- `MobileBonjourAdvertiser`:
  - `func setTXT(_ fields: [String: String])` stores the fields and, when published, calls `service.setTXTRecord(NetService.data(fromTXTRecord: fields.mapValues { Data($0.utf8) }))`.
  - `start()` applies the stored fields after `publish()`.
- `MobileControlManager`:
  - `nonisolated static func hostApiTXT(port: Int?, fingerprint: String?) -> [String: String]` returns `["api": "2"]` without TLS, or `["api": "1,2", "h1port": "\(port)", "h1fp": fingerprint]`.
  - It is applied on v2 bind (`mobileServerDidBind`) and again when the v1 TLS listener reports its port.
  - The development plaintext listener is never advertised, as in Plan 2.
- `MobileControlManager.resetHostApiIdentity()`:
  1. Stop the v1 listener (the Task 4 teardown).
  2. Call `HostApiV1Identity.reset()`.
  3. For each `pairedDeviceStore.all` whose id has `MobilePairedDeviceStore.hostApiDevicePrefix`, call `revokeDevice(id)`.
  4. Log `identity_reset` (Task 8 turns this into an audit row).
  5. Start the v1 listener again through the Task 4 switch. A new identity is minted then.

- [ ] **Step 1: Write the failing tests**

`HostApiV1AdvertisementTests.swift`:
- `hostApiTXT(port: nil, fingerprint: nil) == ["api": "2"]`.
- `hostApiTXT(port: 3017, fingerprint: "sha256:abc")` equals the full dictionary, and `NetService.data(fromTXTRecord:)` of it is under 255 bytes per value.
- A QR built with `hostApiPort: 3017, hostApiFingerprint: "sha256:abc"` parses back with `URLComponents` to `h1port=3017` and `h1fp=sha256:abc`, with `ip`/`port`/`pin` as before. Without the v1 values, the QR has no `h1` items.
- `resetHostApiIdentity()` on a manager built the way the existing manager tests build one (memory keychain, temp paired-device file):
  - an `h1-` device and a v2 device are seeded first;
  - after the reset the `h1-` device is gone and the v2 device remains;
  - the identity fingerprint changed.

  If the manager cannot be built in a test without starting sockets, extract the device filter into `nonisolated static func hostApiDeviceIds(_ devices: [MobilePairedDeviceStore.Device]) -> [String]` and test that instead.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1AdvertisementTests > /tmp/h6-t5.log 2>&1; tail -20 /tmp/h6-t5.log`
Expected: compile failure.

- [ ] **Step 3: Implement**

Apply the interfaces above. In `MobileControlSettingsSection.swift`:
- `refreshConnection()` passes `hostApiPort: mobile.hostApiPort, hostApiFingerprint: mobile.hostApiFingerprint`.
- Under the QR, when `connection.hostApiFingerprint` is non-nil, show one selectable caption line: `Host API v1 (encrypted): port <p> · fingerprint <first 16 chars>…`.
- A **Reset security identity** button, shown only when the v1 TLS listener is running. It is destructive and confirmed: `.confirmationDialog`, default Cancel, with the text "Every device paired over Host API v1 must pair again. Phones on the older link are not affected." On confirm it calls `mobile.resetHostApiIdentity()`.

Use the existing button style the section uses for **Revoke**.

- [ ] **Step 4: Run the tests, the suite and the gate**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/mac-test.log 2>&1; tail -5 /tmp/mac-test.log && cd .. && bash mac/Scripts/feature-boundaries.sh` (unsandboxed)
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileConnectionInfo.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileBonjourAdvertiser.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Views/MobileControlSettingsSection.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1AdvertisementTests.swift mac/Package.swift
git commit -m "feat(mac): advertise the Host API v1 port and fingerprint and add identity reset"
```

---

### Task 6: Desktop WSS listener, shared Origin rule, fingerprint in hello and the PIN route (after Tasks 1, 3 and 7)

**Files:**
- Create: `extension/routes/host-api/origins.mjs`, `extension/tests/helpers/pinned-ws.mjs`
- Modify: `extension/server/host-api-listener.mjs`, `extension/core/config.mjs`, `extension/server.mjs`, `extension/routes/host-api/gateway.mjs`
- Modify: `schema/http/host-api.schema.json` and its fixtures, `schema/http/INVENTORY.md`, and the generated types and OpenAPI that `make contract-gates` names
- Modify: `desktop/src-tauri/src/core_host.rs`, `ui/screens/settings/sections/HostApiPairing.tsx` and its test
- Test: `extension/tests/host-api-origins.test.mjs`, `extension/tests/host-api-tls.test.mjs`; extend `extension/tests/host-api-listener.test.mjs` and `host-api-routes.test.mjs`

**Interfaces:**
- `origins.mjs`:
  - `parseOriginAllowlist(raw, log = () => {}) -> readonly string[]`
  - `originRefused(headers, allowlist) -> boolean`
  - The patterns and rules are Task 4's, verbatim. A non-string or array `Origin`, and a comma-joined duplicate header, are refused.
- `config.mjs`:
  - `hostApiTls`: `process.env.LLMIDE_HOST_API_TLS === '1'`.
  - `hostApiWebOrigins` = `parseOriginAllowlist(process.env.LLMIDE_HOST_API_WEB_ORIGINS, log)`. This replaces Plan 3's loopback-only regex, which is deleted.
  - `hostApiMode`: `'tls'` if `hostApiTls`, else `'dev'` if `hostApiDev`, else `'off'`.
- `startHostApiListener({gateway, tls = null, basePort = 3016, candidates = 10, log, onRefused = () => {}})`:
  - With `tls = {certPem, keyPem}` it uses `https.createServer({cert, key, minVersion: 'TLSv1.2'})` on host `'0.0.0.0'`. Otherwise it keeps Plan 3's `http.createServer` on `127.0.0.1`.
  - The upgrade checks are unchanged (path, then `handshakeRefusal`), except that:
    - the `Origin` check becomes `originRefused(req.headers, config.hostApiWebOrigins)` and calls `onRefused('origin_refused', peer, origin)`;
    - the loopback-peer check applies **only without TLS**, and a refusal calls `onRefused('plaintext_refused', peer, '')`.
  - `tlsClientError` is logged by error code only, at most once per peer per minute, with no audit row (decision 8 de-duplication; a pin mismatch shows up here as the client aborting the handshake).
- Gateway: `createGateway({…, certificateFingerprint = () => null})`. `host.hello` adds `certificateFingerprint` when it is non-null.
- `POST /host-api/pin` returns `{pin, expiresAt, port, fingerprint}`, with `fingerprint: string | null` (null outside TLS mode). This is an HTTP wire change: bump `SERVER_API_VERSION` to the next number, add a changelog line, and update the schema and fixtures.
- In `server.mjs`, where Plan 3 starts the dev listener, switch on `config.hostApiMode`:
  - `'tls'`: `loadOrCreateHostIdentity(getDb(), {hostName: os.hostname()})` (dynamically imported), then start with `tls`.
  - `'dev'`: unchanged.
  - `'off'`: nothing.
- `core_host.rs`:

```rust
/// Host API v1 env the core may receive. TLS and the web-origin list are allowed in release builds
/// (they only tighten or enable the pinned listener); the plaintext dev flag stays debug-only (Plan 3).
fn host_api_env(key: &str, value: Option<&str>) -> Option<String> {
    match (key, value) {
        ("LLMIDE_HOST_API_TLS", Some("1")) => Some("1".into()),
        ("LLMIDE_HOST_API_WEB_ORIGINS", Some(v)) if v.len() <= 2048 => Some(v.into()),
        _ => None,
    }
}
```

  Call it for both keys where Plan 3 added the dev flag, with an explicit `cmd.env(key, v)`. Add a cargo test `host_api_env_passes_only_known_values`.
- `HostApiPairing.tsx`: below the PIN and port, show `Fingerprint: <value>` (selectable, monospace) when it is non-null. The card test asserts that it renders.

- [ ] **Step 1: Write the failing tests**

`extension/tests/helpers/pinned-ws.mjs` is the pinned test client:

```js
// Test-only pinned Host API client: TLS with no CA trust, accepted ONLY if the server's leaf SPKI hash
// equals `fingerprint`; then a raw WebSocket upgrade. Resolves {status, socket} or rejects 'pin_mismatch'.
import tls from 'node:tls';
import { fingerprintOfSpki } from '../../server/host-identity.mjs';

export function pinnedUpgrade({ port, fingerprint, origin, path = '/host-api/v1' }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const spki = socket.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' });
      if (fingerprintOfSpki(spki) !== fingerprint) { socket.destroy(); return reject(new Error('pin_mismatch')); }
      socket.write([`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? [`Origin: ${origin}`] : []), '', ''].join('\r\n'));
      socket.once('data', (buf) => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.toString('latin1'))?.[1]), socket }));
    });
  });
}
```

`host-api-origins.test.mjs` runs `origins.json`:
- `parseOriginAllowlist(allowlist)` deep-equals `parsed`, and `log` was called 7 times;
- every case matches `originRefused({origin}, parsed)`; for `origin: null`, pass `{}`.

`host-api-tls.test.mjs` uses a fake gateway like Plan 3's listener test and an identity from `loadOrCreateHostIdentity` on the temp DB. Assertions:
1. `pinnedUpgrade` with the right fingerprint gives `status === 101`, and `opened` was called once.
2. With another identity's fingerprint it rejects with `pin_mismatch`, and `opened` was never called (wait 300 ms).
3. A plain `http.request` upgrade to the TLS port errors (`ECONNRESET` or `socket hang up`), and `opened` was never called.
4. With `LLMIDE_HOST_API_WEB_ORIGINS` parsed to `['https://app.example.com']` (pass the list through a test seam on the listener, `originAllowlist` defaulting to `config.hostApiWebOrigins`), an upgrade with that origin gives 101. With `https://evil.example` it gives 403 and `onRefused('origin_refused', …)`.
5. The listener in TLS mode reports an address of `0.0.0.0`; without TLS, `127.0.0.1`.
6. A plaintext listener given a fake non-loopback `req.socket.remoteAddress` (call its exported `upgradeRefusal(req, {tls: false})` helper directly) refuses with 403 and `plaintext_refused`.

Extend `host-api-routes.test.mjs`: `fingerprint` is `null` with the dev flag, and matches `/^sha256:/` with `LLMIDE_HOST_API_TLS=1`.

Add one gateway scenario to `host-api-gateway.test.mjs`: `host.hello` includes `certificateFingerprint` when the dependency returns one.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd extension && node --test tests/host-api-origins.test.mjs tests/host-api-tls.test.mjs`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement** as specified. Extract `upgradeRefusal(req, {tls, allowlist}) -> {status, event, detail} | null` from the listener's upgrade handler, so the plaintext and origin rules are unit-testable without sockets.

- [ ] **Step 4: Run every gate this touches**

Run (unsandboxed, because the tests bind ports):
- `cd extension && node --test tests/host-api-*.test.mjs tests/lazy-engine.test.mjs && npx eslint routes/host-api server/host-api-listener.mjs server/host-identity.mjs`
- `cd .. && make contract-gates`
- `cd desktop/src-tauri && cargo test host_api_env`
- `cd ../.. && cd desktop && npm test 2>&1 | tail -5 && npx tsc --noEmit -p .`

Expected: all pass.

- [ ] **Step 5: Commit** (two commits)

```bash
git add extension/routes/host-api/origins.mjs extension/server/host-api-listener.mjs extension/core/config.mjs extension/server.mjs \
  extension/routes/host-api/gateway.mjs extension/tests/helpers/pinned-ws.mjs extension/tests/host-api-origins.test.mjs \
  extension/tests/host-api-tls.test.mjs extension/tests/host-api-listener.test.mjs extension/tests/host-api-gateway.test.mjs \
  extension/tests/host-api-routes.test.mjs schema/http
git commit -m "feat(server): serve Host API v1 over pinned TLS and allowlist web origins"
git add desktop/src-tauri/src/core_host.rs ui/screens/settings/sections/HostApiPairing.tsx ui/screens/settings/tests
git commit -m "feat(desktop): pass the Host API TLS settings and show the pairing fingerprint"
```

Also stage the generated contract files that `make contract-gates` rewrote; `git status` names them.

---

### Task 7: Token scopes on both hosts — parallel-safe with Tasks 2 and 3

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobilePairedDeviceStore.swift`, `…/HostApi/HostApiV1Gateway.swift`, `…/MobileControlManager.swift` (`makeHostApiDependencies`)
- Modify: `extension/kb/host-api-devices.mjs`, `extension/routes/host-api/gateway.mjs`
- Modify: `mac/Package.swift` (`mobileTestExcludes` += `HostApiV1ScopesTests.swift`)
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1ScopesTests.swift`, `extension/tests/host-api-scopes.test.mjs`. Update the device-store tests whose return shapes change (`HostApiV1DeviceStoreTests.swift`, `host-api-devices.test.mjs`).

**Interfaces:**
- Mac `MobilePairedDeviceStore`:
  - `Device.scopes: [String]?` is additive. Synthesized `Codable` decodes a missing key as nil, so old files load.
  - `static let legacyHostApiScopes = ["host", "chat", "approvals"]`
  - `issueToken(deviceId:name:scopes: [String]? = nil, now:)`. v2 callers are unchanged and store nil.
  - `func scopes(deviceId: String) -> [String]` returns the stored value, or `legacyHostApiScopes`.
- Mac gateway:
  - `Dependencies.issueToken: (_ deviceId: String, _ name: String, _ scopes: [String]) -> String`
  - `Dependencies.scopes: (_ deviceId: String) -> [String]`
  - The gateway keeps `grants: [Int: Set<String>]` per session, set at pair (`Set(deps.capabilities())`) and at token auth (`Set(deps.scopes(deviceId))`), and removed in `closed`.
  - `effective(session) = deps.capabilities().filter { grants[session]?.contains($0) == true }`, in served order.
- Desktop:
  - `issueDeviceToken(userId, name, now = Date.now(), scopes = null)` stores `JSON.stringify(scopes)` or NULL.
  - `authenticateDeviceToken(token, now)` returns `{userId, deviceId, scopes}`, with `scopes` = the parsed column or `LEGACY_SCOPES`.
  - `export const LEGACY_SCOPES = Object.freeze(['host', 'chat', 'approvals'])`.
  - The gateway mirrors the Mac with a `grants` map.
- Behaviour, both hosts:
  1. `host.auth.pair` grants exactly the capabilities served at that moment and returns them.
  2. `host.auth.token` returns `effective`.
  3. After auth, before `HostApiV1Session.gate` / `HostApiSession.gate`: if the command's capability is served but not granted, refuse with `denied`: "This device was not granted \(capability) — pair again to grant it." Otherwise call the gate with `served = Set(effective)`.
  4. `capabilitiesChanged()` sends each authed session its own `effective` list, only when that session's list changed. Keep a `lastSent: [Int: [String]]` in place of the single `lastCapabilities`.
  5. `host` is always in the grant, so the result is never empty (schema `minItems: 1`).

- [ ] **Step 1: Write the failing tests**

The same scenarios run on both hosts, Swift in `HostApiV1ScopesTests.swift` and Node in `host-api-scopes.test.mjs`. Drive the gateway with the fakes the existing gateway tests use, extended with a scopes store:
1. Pair while `tool_approvals` is **not** served. Then turn it on and call `capabilitiesChanged()`. The session's pushed list stays without `tool_approvals`, and `toolApprovals.answer` gets `denied` with "pair again".
2. Pair while `tool_approvals` **is** served. The token on a new session authenticates with `tool_approvals` in its result, and the answer is accepted (owned command, as in the existing gateway tests).
3. A legacy token (nil or NULL scopes) authenticates with `["host", "chat", "approvals"]` and never `tool_approvals`, even while it is served.
4. A granted but no-longer-served capability gives `capability_unavailable` (the gate's existing refusal), not `denied`.
5. Store round trip: `issueToken(…, scopes: ["host","chat"])` then `scopes(deviceId:)` gives `["host","chat"]`. A JSON file written without `scopes` loads, and its devices get the legacy set. On Node, the same through the column.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter 'HostApiV1(Scopes|DeviceStore|Gateway)Tests' > /tmp/h6-t7.log 2>&1; tail -20 /tmp/h6-t7.log` and `cd extension && node --test tests/host-api-scopes.test.mjs`
Expected: FAIL (compile errors on the Mac, missing exports on Node).

- [ ] **Step 3: Implement** per the interfaces. On the Mac, `makeHostApiDependencies` wires `issueToken: { id, name, scopes in pairedDeviceStore.issueToken(deviceId: id, name: name, scopes: scopes) }` and `scopes: { [pairedDeviceStore] in pairedDeviceStore.scopes(deviceId: $0) }`. Update the existing tests' expected shapes:
- `authenticateDeviceToken` now also returns `scopes`;
- the fake `issueToken` takes three arguments.

- [ ] **Step 4: Run the tests and the gates**

Run:
- `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/mac-test.log 2>&1; tail -5 /tmp/mac-test.log`
- `cd ../extension && node --test tests/host-api-*.test.mjs && npx eslint kb/host-api-devices.mjs routes/host-api`
- `cd .. && bash mac/Scripts/feature-boundaries.sh`

Expected: all pass.

- [ ] **Step 5: Commit** (one per host)

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobilePairedDeviceStore.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift mac/Package.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1ScopesTests.swift mac/Tests/LlmIdeMacTests/HostApiV1DeviceStoreTests.swift mac/Tests/LlmIdeMacTests/HostApiV1GatewayTests.swift
git commit -m "feat(mac): bind Host API v1 tokens to the capabilities granted at pairing"
git add extension/kb/host-api-devices.mjs extension/routes/host-api/gateway.mjs extension/tests/host-api-scopes.test.mjs \
  extension/tests/host-api-devices.test.mjs extension/tests/host-api-gateway.test.mjs
git commit -m "feat(host-api): bind desktop device tokens to the capabilities granted at pairing"
```

---

### Task 8: Audit log and per-session rate limits on both hosts (after Tasks 4, 6 and 7)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1AuditLog.swift`, `…/HostApi/HostApiV1RateLimiter.swift`
- Create: `extension/routes/host-api/audit.mjs`, `extension/routes/host-api/rate.mjs`
- Modify: both gateways; `MobileControlManager.swift` (audit wiring for the listener's `onRefused`, `revokeDevice`, `resetHostApiIdentity` and identity creation); `extension/server.mjs` (wiring the listener's `onRefused`, the identity's `onEvent` and the revoke route to the sink)
- Modify: `mac/Package.swift` (`mobileTestExcludes` += `HostApiV1AuditRateTests.swift`)
- Test: `mac/Tests/LlmIdeMacTests/HostApiV1AuditRateTests.swift`, `extension/tests/host-api-audit-rate.test.mjs`

**Interfaces:**
- Shared constants, defined once per host:

  | Name | Value |
  |---|---|
  | `frameCapacity` | 40 |
  | `framePerSecond` | 10 |
  | `turnCapacity` | 6 |
  | `turnPerSecond` | 0.1 |
  | `closeAfterRefusals` | 100 |
  | `dedupeWindow` | 60 s |
  | `detailMax` | 200 |

- Mac:
  - `struct HostApiV1TokenBucket { init(capacity: Double, perSecond: Double, now: Date); mutating func take(now: Date) -> TimeInterval? }` returns nil when allowed, else the wait.
  - `struct HostApiV1RateLimiter { mutating func frame(session: Int, now: Date) -> TimeInterval?; mutating func turn(deviceId: String, now: Date) -> TimeInterval?; mutating func refused(session: Int) -> Bool /* true = close */; mutating func drop(session: Int) }`
- Mac:
  - `struct HostApiV1AuditEvent: Codable, Equatable { let ts: Date; let event: String; let peer: String; let deviceId: String?; let detail: String? }`
  - `final class HostApiV1AuditLog: @unchecked Sendable`, with:
    - `init(fileURL: URL = defaultFileURL(), maxBytes: Int = 512 * 1024, echo: @escaping (String) -> Void = { _ in })`
    - `func record(_ event: String, peer: String, deviceId: String? = nil, detail: String? = nil, dedupeKey: String? = nil, now: Date = Date())`
    - `func recent(limit: Int) -> [HostApiV1AuditEvent]`
    - `static func defaultFileURL() -> URL` (Application Support `llm-ide/host-api-audit.jsonl`)
  - Writes run on a private serial queue. The file is created with `0o600`. Past `maxBytes` it is renamed to `.1`, replacing the previous `.1`. `detail` is clamped to 200 characters.
- Node:
  - `createAuditSink({db = getDb(), log, now = Date.now}) -> {record(event, {peer, userId, deviceId, clientName, detail, dedupeKey})}` calls `recordAudit(db, {userId, ip: peer, userAgent: clientName, action: 'host_api.' + event, resource: deviceId, outcome, detail: detail ? {reason: String(detail).slice(0, 200)} : undefined})`.
  - The outcome is `success` for `pair_ok`, `revoke_self`, `revoke_host`, `identity_created` and `identity_reset`, and `denied` for `origin_refused`, `plaintext_refused` and `scope_denied`. Every other event is `failure`.
  - `rate.mjs` exports `TokenBucket` and `createRateLimiter()` with the Swift methods as `frame(session, now)`, `turn(deviceId, now)`, `refused(session)` and `drop(session)`.
- Gateway wiring, both hosts:
  - **Rate check order.** Check the frame bucket first in `receive`, before parsing. Its refusal is `rate_limited` with `retryAfterMs` and the request id when it can be read cheaply; otherwise `replyTo: null`.
  - **Turn bucket.** Check it in `chat.send` after the scope check and before any work.
  - **Closing.** `refused` returning true closes the session and writes `rate_closed`.
  - **Throttle events.** The pairing throttle's `.wait` / `.lockedOut` / `.serverThrottled` write `pair_throttled` or `token_throttled` with `dedupeKey: peer`.
  - **Auth outcomes.** A wrong PIN writes `pair_failed`, a bad token `token_failed`, a pair `pair_ok` with the device id and client name, and a self-revoke `revoke_self`.
  - **Scope refusals.** A scope refusal (Task 7) writes `scope_denied` with the capability as detail and `dedupeKey: deviceId + capability`.
  - **Mac dependency.** `Dependencies.audit: (_ event: String, _ peer: String, _ deviceId: String?, _ detail: String?, _ dedupeKey: String?) -> Void` (the Node gateway takes `deps.audit`).
  - **Host-side events.** These are written by the manager or `server.mjs`, not the gateway:
    - the Settings revoke writes `revoke_host`;
    - the identity writes `identity_created` and `identity_reset`;
    - the listener's `onRefused` writes `origin_refused` (`dedupeKey: origin`) and `plaintext_refused` (`dedupeKey: peer`).

- [ ] **Step 1: Write the failing tests** (both hosts, same scenarios)
1. **Bucket:** 40 frames at t=0 pass, the 41st waits 0.1 s, and at t=0.1 one more passes. 6 turns pass, the 7th waits 10 s.
2. **Gateway frame limit:** 41 `host.ping` frames in one tick. The 41st reply is `rate_limited`, `retryable: true`, with `retryAfterMs` ≥ 100.
3. **Close after refusals:** 140 frames in one tick close the session after the 100th refusal (the `close` fake is called) and write `rate_closed`.
4. **Turn limit:** a 7th `chat.send` within 10 s on the same device, even from a new session, is `rate_limited`, and the `turn`/`forward` fake was called 6 times.
5. **Audit rows:**
   - a wrong PIN writes `pair_failed` with the peer;
   - a correct pair writes `pair_ok` with the device id;
   - a bad token writes `token_failed`;
   - a self-revoke writes `revoke_self`;
   - a scope refusal writes `scope_denied`.
   - No row's JSON contains the PIN, the token or the frame text: assert `!JSON.stringify(rows).includes(pin|token|text)`.
6. **De-duplication:** 10 `pair_throttled` events for one peer within 60 s give 1 row, and one more at t=61 s gives a second row.
7. **Mac file:** rows survive a new `HostApiV1AuditLog` on the same temp URL, the file mode is `0o600`, and past `maxBytes` (use 1 KiB in the test) a `.1` file exists and the live file is smaller than the limit.
8. **Node:** rows land in `audit_log` with `action` `host_api.pair_failed` and `user_id` NULL (read with a direct `SELECT`, because `listAuditForUser` filters by user). A `pair_ok` row carries the pairing user's id.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1AuditRateTests > /tmp/h6-t8.log 2>&1; tail -20 /tmp/h6-t8.log` and `cd extension && node --test tests/host-api-audit-rate.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** per the interfaces. In the manager, own one `HostApiV1AuditLog` (`echo: { [weak self] l in Task { @MainActor in self?.append(.info, l) } }`) and pass `audit.record` into the gateway dependencies and the listener's `onRefused`. Wire `revokeDevice(_:)` for `h1-` ids only (the v2 link is not audited by this plan), `resetHostApiIdentity()`, and `Loaded.created`. The echo line names the event and the peer only.

- [ ] **Step 4: Run the tests, both suites and the gates**

Run (unsandboxed):
- `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/mac-test.log 2>&1; tail -5 /tmp/mac-test.log`
- `cd ../extension && node --test tests/host-api-*.test.mjs && npm test 2>&1 | tail -15 && npx eslint routes/host-api server`
- `cd .. && bash mac/Scripts/feature-boundaries.sh`

Expected: all pass.

- [ ] **Step 5: Commit** (one per host)

```bash
git add mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1AuditLog.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1RateLimiter.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift \
  mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift mac/Package.swift \
  mac/Tests/LlmIdeMacTests/HostApiV1AuditRateTests.swift
git commit -m "feat(mac): audit Host API v1 auth events and rate-limit each session"
git add extension/routes/host-api/audit.mjs extension/routes/host-api/rate.mjs extension/routes/host-api/gateway.mjs \
  extension/server.mjs extension/tests/host-api-audit-rate.test.mjs
git commit -m "feat(host-api): audit desktop auth events and rate-limit each session"
```

---

### Task 9: Docs, invariants, plan status and the full gate

**Files:**
- Modify: `docs/explanation/invariants.md`, `extension/CLAUDE.md`, `mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md`, `docs/mobile/quick-start.md`, `schema/host-api/v1/README.md`, `docs/superpowers/MASTER-PLAN.md`

- [ ] **Step 1: Invariants.** Add a "Host API v1 transport security" section to `docs/explanation/invariants.md`. Each rule has a one-line why and names its test:
  1. The v1 listener binds a non-loopback interface only in TLS mode (`HostApiV1TLSListenerTests`, `host-api-tls.test.mjs`).
  2. An identity read failure never regenerates the identity (Mac `persistence` test). A desktop vault change resets the identity and wipes v1 devices (`host-api-identity.test.mjs`).
  3. The fingerprint is `sha256:` plus base64url(SHA-256(SPKI)), pinned by `fixtures/security/identity-vector.json`.
  4. The `Origin` rule is exact and shared (`fixtures/security/origins.json`), with no wildcard.
  5. Effective capabilities are served ∩ granted, and a legacy token never gets `tool_approvals`.
  6. Audit rows and logs never hold a PIN, a token, key bytes or frame content.
- [ ] **Step 2: Guides.**
  - `extension/CLAUDE.md` "Host API v1 (desktop)": add `LLMIDE_HOST_API_TLS=1` (binds `0.0.0.0:3016+`, TLS only), `LLMIDE_HOST_API_WEB_ORIGINS` (exact origins; loopback `http` or `https://<domain>`), where the identity lives and how it resets, and the `host_api.*` audit actions.
  - MobileControl `CLAUDE.md` "Host API v1": add the three modes, the `HostApiV1.tlsEnabled` and `HostApiV1.webOrigins` defaults keys, the QR `h1port`/`h1fp`, the TXT `api`/`h1port`/`h1fp`, Reset security identity, and the audit file path.
  - `docs/mobile/quick-start.md`: add a short "Host API v1 (encrypted, preview)" section covering how to turn it on and that the fingerprint in the QR is what the phone trusts.
  - `schema/host-api/v1/README.md`: one line on `fixtures/security/`.
- [ ] **Step 3: Master plan.** In `docs/superpowers/MASTER-PLAN.md` S6, split the "Host API Plans 3 to 6" item so that Plan 6 is its own line:
  - `[~]` citing this plan's commits;
  - "manual pinned-pairing check against a real phone deferred to the product stage (you; not a gate)".

  Then run `node scripts/plan-status.mjs --fix && node scripts/plan-status.mjs --check`.
- [ ] **Step 4: Full gate.** Run (unsandboxed, memory keychain): `LLMIDE_KEYCHAIN_BACKEND=memory make regression > /tmp/h6-regression.log 2>&1; tail -30 /tmp/h6-regression.log`. Also run `make docs-check` if the regression gate does not.

Expected: pass. Fix anything this plan broke. Report any failure this plan did not cause, with its first error line.
- [ ] **Step 5: Commit**

```bash
git add docs/explanation/invariants.md extension/CLAUDE.md mac/Sources/LlmIdeMac/Features/MobileControl/CLAUDE.md \
  docs/mobile/quick-start.md schema/host-api/v1/README.md docs/superpowers/MASTER-PLAN.md
git commit -m "docs: record Host API v1 TLS pinning, scopes, origins, rate limits and audit"
```

---

## Limits

- **Client-side pinning is not in this plan.** The iOS `HostConnection` (Plan 4) must pin `h1fp` from the QR exactly as the 2026-10-31 design §4 describes. The pinned clients here are test-only.
- **Browser reach from the VPS domain is Plan 5's decision.** A browser cannot pin a self-signed certificate, so a page on `https://<domain>` cannot open `wss://<LAN IP>:3016` without either a certificate the browser trusts or the user trusting the host certificate once. This plan only makes the host accept that page's `Origin`. A local web app (`http://localhost:<port>`) to a loopback dev listener works today.
- **TLS is off by default** (`LLMIDE_HOST_API_TLS=1` or `HostApiV1.tlsEnabled`) until Plan 4 ships a v1 iOS client.
- **The desktop has no Bonjour, no QR and no identity-reset button.**
  - Node has no mDNS without a new dependency.
  - Pairing on the desktop is manual entry with the fingerprint shown in Settings.
  - The desktop identity rotates only on a vault-key change.
- **There is no UI for the origin allowlist, the audit log or each device's granted scopes.** They are env or defaults keys, a JSONL file and `audit_log`. These are follow-ups when a product surface needs them.
- **Widening scopes requires a re-pair** (decision 7).
- **The v2 link (`ws://3006`) is unchanged and still plaintext.** Its TLS migration is the 2026-10-31 design, not this plan, and v2 retires at spec phase 7.
- **The manual pairing and device checks are deferred to the product stage** (user decision 2026-11-04). They are not a gate for this plan.

## Workflow

Subagent-driven: a fresh implementer per task, with each task reviewed before the next one in its wave starts. Every task here is security code, so each review runs on Sonnet or a stronger model. Tasks 2, 3, 4 and 6 (key handling and listeners) get the most capable model, with the review prompt pointing at decisions 3–5 and the Global Constraints. Follow the waves in "Task order and parallelism". Within a wave, parallel implementers must stage only their own files (`git add <paths>`, never `-A`) and retry on `.git/index.lock`. Commit on `main`, and do not push.

## Commands

```bash
cd extension && node --test tests/host-api-*.test.mjs tests/lazy-engine.test.mjs     # Node host (unsandboxed: binds ports)
cd extension && npm test && npx eslint routes/host-api server
make contract-gates && make host-api-check
cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter HostApiV1 > /tmp/h6.log 2>&1   # Mac host (unsandboxed)
cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > /tmp/mac-test.log 2>&1
bash mac/Scripts/feature-boundaries.sh
cd desktop/src-tauri && cargo test host_api
cd desktop && npm test && npx tsc --noEmit -p .
LLMIDE_KEYCHAIN_BACKEND=memory make regression                                          # unsandboxed
```

## Self-review

**Spec coverage, phase 6:**
- TLS certificate pinning:
  - identity and fingerprint: Tasks 2 and 3;
  - WSS listeners: Tasks 4 and 6;
  - fingerprint in `host.hello`: Tasks 4 and 6;
  - in the QR and Bonjour: Task 5;
  - on the desktop Settings card: Task 6;
  - "certificate mismatch refused" by the pinned test clients: Task 4 test 3, Task 6 test 2.
- "Plaintext refused outside loopback": Task 4 tests 4 and 6, Task 6 tests 3 and 6. Plaintext stays behind the development flag (decision 5).
- Origin allowlist with exact match, shared fixture and the production `https://<domain>` form: Tasks 1, 4 and 6. "No wildcard": the fixture's `*` and `*.` entries are dropped.
- Token scopes: Task 7.
- Rate limits beyond pairing: Task 8. Audit logging of auth failures, pairings and revokes: Task 8.
- "Discovery, the QR and the manual-entry screen advertise the exact v1 port": Task 5 (Mac) and Task 6 (the desktop card shows the port, from Plan 3, and now the fingerprint).
- No v1 schema change: `certificateFingerprint` is already optional. The one HTTP wire change (the `fingerprint` in `POST /host-api/pin`) bumps the API (Task 6).

**Placeholders:** every step names its code or its exact source. These must be read from existing files before writing:
- the generated `HostApiHostHelloResult` initializer's label order (Task 4);
- whether `vault.decrypt` returns a string (Task 3);
- the full `RawKeychainAccess` requirement list (Task 2);
- how the existing manager tests build a manager (Task 5, with a static-function fallback named);
- the migration number if 0062 is taken (Task 1).

One risk has a named stop condition: an in-memory `SecKey` refused by the TLS stack (Task 4 step 4).

**Type consistency:**
- `HostApiV1Identity.Loaded.fingerprint` (Task 2) is used in Tasks 4 and 5.
- `HostApiV1Listener.Transport` and `.mode` (Task 4) are used in Task 5.
- `loadOrCreateHostIdentity` (Task 3) is used in Task 6.
- `fingerprintOfSpki` (Task 3) is used by the Task 6 test helper.
- `issueToken(…scopes:)`, `scopes(deviceId:)`, `LEGACY_SCOPES` and the `{userId, deviceId, scopes}` shape (Task 7) are used by the Task 8 gateway wiring.
- The audit event names (decision 8) are the same strings in Tasks 4, 5, 6 and 8.
- The rate constants are defined once per host (Task 8).
