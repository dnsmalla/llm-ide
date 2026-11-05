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
