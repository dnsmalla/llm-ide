# Relay review (plan `plans/2026-11-05-relay.md`), 2026-11-05

## Batch 1: `147f29f5`..`d387b969`

Envelope spec and vectors, relay config, migration and import boundary, relay auth, routing, blindness tests, web envelope crypto and the Host API SocketLike. Tests: `account-service` 131/131, `check:boundary` ok, `web` 82/82.

**Verdict:** fine for local and private-network testing; not ready for the external review (G-EXT). The crypto, relay auth and routing match the spec, and the attempted breaks failed:

- HKDF info binds direction and recipient; the header is in both the AAD and the signature; v=1 is enforced on both ends.
- The signature is verified before decryption; replies need a desktop-chosen session and a strictly increasing seq.
- A wrap needs the pinned desktop signer and a higher epoch; Node and WebCrypto agree on the shared vectors.
- The token travels only in the first message, never in the URL; the challenge is fresh per connection; the proof binds role and token hash.
- Routing checks sender and recipient ids against the authenticated identity.

**Production:** not reachable. `ACCOUNTS_RELAY` is off by default and the upgrade listener attaches only when it is on; the service binds loopback; the nginx accounts vhost has no `/relay/` location and `/v1/` passes no Upgrade headers. Nothing refuses `ACCOUNTS_RELAY=1` in production yet: add a hard refusal until G-EXT closes.

### Important

- **I-A, relay auth trusts v1 links** (`account-service/src/relay/auth.mjs:35`): device auth accepts `status='linked'` from device linking v1, which still has C1, C2, I1, I2 and I3 open (see [device-linking-and-site-review](2026-11-05-device-linking-and-site-review.md)), and migration 0005 does not mark v1 links unverified. A rogue device linked through I2 or I3 passes relay auth, can see desktop presence, push ciphertext at the desktop and spend its budget. End-to-end encryption still holds in this batch, but the remaining guard is the Rust registry (Tasks 10 and 11), whose entries come through the flawed SAS (C1). **Fix the linking findings first, and mark every v1 link unverified.**
- **I-B, revoking the desktop leaves its devices connected and linked** (`account-service/src/devices.mjs:63-72`, `:103-115`; `relay/hub.mjs:157`): a web revoke closes only the desktop socket (`routes/desktop.mjs:59`); device sockets stay open, their `linked` rows and `relay_wraps` stay, and re-registering a desktop unlinks nothing, so old devices authenticate against the new desktop (`auth.mjs:38`). Revoke must do what replace does: unlink, purge wraps and disconnect.

### Medium

- **M-1** (`ws.mjs:108`, `hub.mjs:122`): a flooding device makes the relay close the receiving desktop socket (1013); add a per-sender budget so one device cannot cut the desktop off, plus a per-account budget.
- **M-2** (`web/src/relay/socket.ts:62`): the ±10 min `issuedAt` check runs before the wrap branch, so a stored wrap reaching a device that was offline for more than 10 minutes is silently dropped and the device never gets its keys.

### Linking flaws in this batch

- **C1, C2:** built on.
- **I1:** built on, partly sidestepped (the relay crypto never uses the desktop ECDH key).
- **I2:** built on for devices; worked around for the desktop role (needs a signing-key proof).
- **I3:** built on; revoke now closes the socket and drops the wrap, but confirm can still bring a revoked device back.
- **I4:** not fixed. The relay web library expects caller-supplied non-extractable deriveBits keys, so browsers linked under v1 cannot use it (deferred to sub-project 4).
- **I5:** worked around. The relay uses the raw-bytes hash consistently; the `tests/linking.test.mjs:31` fixture still hashes the string.

Not reviewed in this batch: commits after `d387b969` (the core bridge and Rust side, including the registry that I-A depends on).

## Batch 2: `4b07bf29`..`10c77a60`

Core relay bridge with tier caps, desktop envelope crypto, device registry and bridge client, link confirmation and the signed wrap, the desktop state machine, the outbound client, the Settings on/off control. Tests: `cargo test relay` 12/12, `cargo test account` 6/6, extension relay and Host API tests 143/143, `tsc` clean.

**Verdict:** not safe to use against a real account service and not ready for G-EXT. Exposure today is still nil (off by default, no nginx `/relay/` route).

**Holds up:** the core bridge is loopback only, allows no Origin, needs the bus host proof and a known tier; the web tier is capped to host, chat and read on both the token and the session, and remote turns are forced to `AUTO_READ_ONLY`; the webview cannot reach the bridge. In Rust: signature before decryption, per-device and per-direction keys, a wrap bound to device id, epoch, both SPKIs and tier, constant-time compares, keys only in the OS secret store, nothing secret logged.

### Critical

- **C1 is now exploitable end to end.** The desktop discards its own nonce (`desktop/src-tauri/src/account_oauth.rs:487`) and computes the SAS from the nonce the service returns (`:456`, `:464`); `link_confirm_blocking` (`:523-555`) then adds the service's keys to the registry and seals the Host API token and subkeys to them. A malicious service gets a working token. **Fix C1 (and C2) before anything else.**

### Important

- **The tier is self-declared:** `account_oauth.rs:529` takes it from the requester-chosen `kind` (`account-service/src/routes/linking.mjs:7`, `:88`), and `ios` means no cap (`extension/core/host-api-relay.mjs:3`), so a browser claiming `ios` can answer approvals. The tier must come from something the requester cannot choose.
- **Linking while the relay runs loses the device:** the loop saves the registry copy it loaded at connect after every envelope (`relay/client.rs:302`), overwriting the device just added (`account_oauth.rs:550`); the core token is orphaned and the wrap is never sent, because wraps go out only at connect (`client.rs:265`).
- **The relay cannot connect over a real network:** a 50 ms read timeout, and WouldBlock is treated as fatal in the challenge and ready loops (`client.rs:228`, `:237`, `:259`), so any round trip over 50 ms fails. Tests pass only on loopback.
- **wss:// panics:** rustls 0.23.46 is built without `ring` or `aws-lc-rs` and no provider is installed (`Cargo.toml:44`), so `ClientConfig::builder()` panics in the relay thread. It fails closed, and the TLS path has never run (certificate checking uses webpki-roots with no skip).
- **No revoke on the desktop:** `Registry::remove` (`relay/registry.rs:56`) is never called, `Out::CloseDevice` is never produced (`client.rs:312`), and the epoch is fixed at 1 (rotation deferred to R4). A device revoked on the web keeps working until the user also revokes it under Host API devices.

### Medium

- **Kill-switch race:** `enabled=true` set in memory (`client.rs:267`) can be saved back after the user turns the relay off (`:302`), and the shell then resumes it on the next launch.
- **Bridge threads leak** (`relay/bridge.rs:38`): after 8 leaks the core's 8-connection cap (`extension/server/relay-bridge.mjs:25`) refuses every new session until a restart.
- **Relay sessions never expire** (`client.rs:66`): repeated device reloads fill the session slots.
- **The SAS check at confirm proves nothing:** the webview passes back the SAS it was shown (`AccountSection.tsx:67`).
- **New crates have no justification comments:** `aes-gcm`, `hkdf`, `tungstenite` are pinned exactly but uncommented.

**Untested guards:** the `link_confirm_blocking` gates, the session-to-device binding (`client.rs:78`), the reply cap, the registry overwrite, any wss connection, `attachRelayBridge`, `bridge::pair`.

### Prior findings at `10c77a60`

- **C1:** still open, now load-bearing (`account_oauth.rs:487`, `:456`, `:464`).
- **C2:** still open (`account-service/public/link.js:71-79`, `:89-94`).
- **I1:** partly. The SAS still omits the desktop ECDH key (`account_oauth.rs:398-401`, `linking.mjs:16-17`), but the wrap uses a signed ephemeral key.
- **I2:** still open. `nativeClient` is only a marker (`account-service/src/http.mjs:65-68`), and approve and confirm accept a bare token (`linking.mjs:159`, `:193`).
- **I3:** partly. Confirm requires state `keys` (`linking.mjs:199`), but revoke and replace leave `link_requests` (`devices.mjs:104-116`, `:78-92`), and the device update has no status guard (`linking.mjs:205`).
- **I4:** still open (`link.js:42-43`).
- **I5:** partly. `link.js` hashes raw bytes; the `tests/linking.test.mjs:31` fixture still hashes the string.
- **I-A:** partly. `relay/auth.mjs:35` is unchanged and no migration marks v1 links unverified; the desktop registry now drops unknown senders (`client.rs:58`), but it is fed through C1.
- **I-B:** still open (`devices.mjs:104-116`), and the desktop has no revoke either.
- **M-1:** still open (`account-service/src/relay/ws.mjs:108`).
- **M-2:** still open and now reachable. `web/src/relay/socket.ts:62` runs before the wrap branch, and the desktop replays the wrap with its confirm-time `issued_at` (`account_oauth.rs:547`, `client.rs:265`), so a device first connecting more than 10 minutes after linking never gets its keys.

### Fix order

1. C1 and C2 (keep each side's own nonce; compute the SAS only from values committed before the reveal), with a malicious-service test.
2. Tier from a value the requester cannot choose.
3. I2 (desktop signature on approve and confirm).
4. I-B and the desktop revoke.
5. The registry overwrite.
6. The real-network blockers: timeouts, WouldBlock handling, a rustls crypto provider.
7. M-2, then the Medium items.
