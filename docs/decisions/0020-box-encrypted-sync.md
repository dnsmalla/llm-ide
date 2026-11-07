---
title: "0020. User-owned storage as the encrypted sync medium (own server, Box, MEGA)"
status: proposed
date: 2026-11-05
supersedes: "0019 (decisions 1, 4, 5, 6, 7); 0018 decision 4 as the product path"
amends: "0018 (decision 4); relay design sections 2, 4.5, 4.6, 7.2, D4, D6, X1"
---

# ADR 0020: User-owned storage as the encrypted sync medium (own server, Box, MEGA)

**Status:** Proposed; amended by [ADR 0021](0021-team-hub.md) (2026-11-07: the team path is the core in hub mode; sync stays for solo users). The user approved the direction on 2026-11-05: Box as the sync medium, phone and
web working as far as possible with the desktop off, no desktop login, no money spent. Later the same
day the user asked for MEGA and the user's own server over SSH as more adapters behind one interface.
The first adapter is MEGA, by user decision on 2026-11-05; the own server (SFTP) and Box follow (see below).
**Date:** 2026-11-05
**Design:** [Box encrypted sync design](../superpowers/specs/2026-11-05-box-encrypted-sync-design.md).
**Research:** [offline desktop memo](../superpowers/research/2026-11-05-offline-desktop-research.md).

## Context

[ADR 0019](0019-public-accounts-desktop-data.md) put a public identity service on the VPS: passkey
accounts, desktop OAuth sign-in and commitment-based device linking, so phones and browsers could reach
the desktop through the relay. Three review rounds
([relay review](../superpowers/reviews/2026-11-05-relay-review.md)) found the envelope crypto, relay
auth and routing sound. They also found that the linking ceremony still lets a malicious account
service take over a link in about 1 s. The outbound Rust client loop is unfinished. Public exposure
still waits on a paid external review (G-EXT).

The user has now set three constraints:

1. The phone (native iPhone app) and the web app (PWA) must keep working as far as possible while the
   desktop is off.
2. The desktop must not need a login.
3. No money is spent. The VPS and the Apple Developer account are already paid for.

No design runs AI while the desktop is off. The user's Claude credential stays on the user's machine
(ADR 0015; ADR 0019 §3). So the most any option can offer with the desktop off is to **read the last
published snapshot and queue requests that run when the desktop is back** (research memo §0).

## Decision

1. **Storage the user already owns carries the desktop's own data, end-to-end encrypted.** The data is
   chats, meeting notes and meetings, tasks and plans, and usage. The desktop writes encrypted snapshot
   files and a signed manifest into one dedicated folder. Phones and browsers write encrypted requests
   into an inbox in the same folder. The storage provider sees only ciphertext plus file names, sizes and
   times, and the design keeps those to a minimum.
2. **One small storage interface (`SyncStore`) with one adapter per backend.** The interface is
   put, get, list and delete of opaque files under validated relative paths, plus an optional watch.
   Nothing in the encryption, snapshot, manifest or inbox format depends on the backend.
   **Build order (user decision, 2026-11-05): MEGA first, for now**, with a dedicated MEGA account whose
   email and password sit only in the core vault; then the own server, then Box. The adapters:
   1. **The user's own server over SFTP.** This is the existing VPS. The desktop uses an SSH key it
      generates. The server account is chrooted and SFTP-only. Phones and browsers reach their own
      per-device folder through a small nginx HTTPS location.
   2. **Box.** The desktop uses the Library connector's existing Client Credentials Grant (CCG)
      session, or a one-time OAuth consent where CCG cannot reach the user's own files. Phones and
      browsers use Box OAuth.
   3. **MEGA.** The client logs in with the account email and password. MEGA offers no OAuth. This
      adapter is opt-in and the design recommends a separate MEGA account (design §8.3).

   Google Drive or Dropbox later is one more adapter.
3. **The desktop is the only key authority. There is no server identity.** The desktop mints a
   per-epoch root key and an ECDSA P-256 signing key. Both live in the core's vault, which is encrypted
   by the vault master key the desktop keeps in the OS keychain. Each phone or browser gets its own
   signed key wrap, written into its own folder. It verifies the wrap against the desktop signing-key
   fingerprint carried in the **existing pairing QR**: the optical channel is the MITM-resistant step.
   Revoking a device deletes its folder. Rotation needs no server.
4. **Envelope crypto is the relay v1 format that passed review.** It is canonical encoding,
   AES-256-GCM, HKDF, ECDSA P1363, padding buckets and the signed ECDH wrap
   (`schema/relay/v1`, `desktop/src-tauri/src/relay/crypto.rs`, `web/src/relay/crypto.ts`). It adds
   three purposes: `snapshot`, `manifest` and `syncwrap` (`schema/sync/v1`).
5. **Queued requests run at the relay design's fixed read-only ceiling.** That ceiling is relay D2 and
   section 5.2: `auto_read_only`, never Bypass, Ask resolves as deny, at-most-once delivery. In v1 the
   only queued class is a chat prompt into the per-user phone chat.
6. **Documents stay in Box and code in GitLab, and they are read at the source.** Phones and browsers
   call the Box and GitLab APIs directly with the user's own login. They are not copied into the sync.
   gitlab.com answers CORS for `api/v4` (checked 2026-11-05), so no proxy is needed for gitlab.com.
7. **Public accounts are retired from the product path. The relay is parked.** `account-service/`
   (passkeys, email links, desktop OAuth, device linking v1), `desktop/src-tauri/src/account_oauth.rs`
   and the relay hub stay in the repository, off by default and not deployed as a product path. The
   relay keeps its code and stays off. Host API v1 (PIN/QR pairing, pinned TLS) stays as the
   "desktop on" path, and the only path that gives the phone live AI.

### Ruling: the own-server adapter comes before Box

> Superseded for the build order by the user decision of 2026-11-05: MEGA comes first. The comparison
> below still holds between the own server and Box, and it is why SFTP is the next adapter after MEGA.

The user approved Box. The coordinator then asked for SFTP to the user's own server and allowed
reordering if grounding showed SFTP to be simpler and safer for this user. It does:

- **Scope:** a Box OAuth token on the phone or PWA has scope over the whole Box account (no app-folder
  scope). With the own server, each device's capability is its own folder, and nginx enforces that.
- **Secrets in the PWA:** Box's token endpoint documents `client_secret` for `authorization_code` and
  documents no `code_verifier`, so PKCE for a public client is unverified. The PWA would have to hold an
  OAuth client secret. The own server needs no OAuth app at all.
- **Desktop credential:** Box CCG writes into a Service Account's tree unless the subject is a user,
  which needs App + Enterprise Access and admin authorisation. A one-time OAuth consent fallback has a
  single-use refresh token that dies after 60 days unused. An SSH key never expires and is installed
  once.
- **Metadata:** only the user's own server sees file names, sizes and times. No third party sees them.
- **Cost:** $0. The VPS is already paid for, and nginx, Certbot and sshd already run on it.

The cost is one new npm dependency (`ssh2`, pure JavaScript) and a small nginx and sshd configuration on
the VPS. Box stays the second adapter, for users without a server. The filename of this ADR and the
design keep the approved name.

## What this supersedes

| Earlier text | Change |
|---|---|
| ADR 0019 decision 1 (public accounts at `account-service/`) | Withdrawn from the product path; code kept, service off. |
| ADR 0019 decision 4 (email + passkey sign-in) | Withdrawn; nobody signs in anywhere except to their own storage. |
| ADR 0019 decision 5 (pending device + commitment SAS + relay wrap) | Replaced by the pairing QR carrying the desktop signing-key fingerprint and a one-time enrollment secret; the signed `syncwrap` lands in the device's own folder. |
| ADR 0019 decision 6 (desktop OAuth sign-in, one outbound relay connection) | Withdrawn: the desktop has no login. It does a one-time storage setup: an SSH key, the Box connector, or a MEGA session. |
| ADR 0019 decision 7 (PWA delegates passkeys, BFF) | Withdrawn. The PWA holds a per-device capability for its folder (own server) or a Box/MEGA session. |
| ADR 0019 decisions 2 and 3 | **Stand:** data stays on the desktop; the user's own AI credentials; no server AI. |
| ADR 0018 decision 4 (relay as the always-on store) | The always-on store is user-owned storage behind `SyncStore`; the relay is parked. |
| Relay design D4 (printed revoke code at the relay) | Without the desktop, a lost device's folder can be deleted directly on the storage (SSH, Box web, MEGA web). On its next start the desktop notices the folder is gone and drops the device. |
| Relay design D6, X1 | Answered: no relay host and no relay account in the product path. |
| MASTER-PLAN Q-WEB-1/2 | Update: PWA reads user-owned storage; the VPS serves the static PWA and the own-server sync location. |

## What is kept, parked

**Update 2026-11-06:** the parked code below was removed from the repo (git history keeps it). What stays is
the relay v1 byte format sync builds on: `schema/relay/v1` and `scripts/relay-reference.mjs` (plus its byte
helpers in `web/src/sync/wire.ts`; the web relay client was removed 2026-11-07). The VPS units are retired with the one-time note in `deploy/vps/README.md`.

- `account-service/` with its relay unit, tests and migrations. `ACCOUNTS_RELAY` stays off. Add a hard
  refusal in production before any redeploy.
- `desktop/src-tauri/src/relay/*` and `account_oauth.rs`, unchanged and off by default. The crypto
  (`relay/crypto.rs`) and its WebCrypto twin are reused as the reference format.
- `deploy/vps/` units for the account service stay disabled.
- The relay design document as the source for the threat model, ceiling and rotation rules.

## Consequences

- **Positive:** $0. No public identity service, so no mail, abuse handling, terms or breach duties for
  an account database, and no G-EXT bill for an identity service. No desktop login. The data stays E2E.
  All five platforms work through plain HTTPS or SFTP.
- **Positive:** the open linking flaws (C1, C2, I1 to I5) leave the product path with the code that has
  them. Nothing in this design trusts a server to choose keys.
- **Positive:** the backend is replaceable. Losing the storage loses nothing the desktop cannot
  republish (one-copy rule, relay design §3).
- **Negative:** with the desktop off there is no AI and no live data. The phone shows the snapshot's
  age, and queued prompts run only when the desktop returns.
- **Negative:** each backend brings its own setup: the server configuration once, a Box developer app,
  or MEGA credentials. The setup is documented, but it is real work for a user who is not technical.
- **Negative:** each adapter is a new external dependency surface: `ssh2`, the Box API and the
  unofficial `megajs`.
- **Trade-off (MEGA first, user decision):** MEGA has no OAuth, so the desktop holds a MEGA password in
  its vault, and that password opens the whole MEGA account. A dedicated account that holds only
  ciphertext limits the damage to deletion or freeze. Two-factor login must be off on that account,
  because the desktop logs in unattended.

## Risks

1. **Freeze and rollback.** A storage operator can delete, freeze or serve old files. A signed manifest
   with `manifestSeq` and `validUntil` makes this visible but cannot prevent it (relay T3).
2. **Own server availability.** The VPS is a single host. If it is down the phone sees nothing new, but
   the desktop and Host API v1 are unaffected.
3. **Capability URL leakage** (own server). A per-device folder name is a bearer secret in the URL path.
   Access logs for `/sync/` are turned off, it is served only over HTTPS, and it can be revoked by
   deleting the folder.
4. **Box whole-account scope and client secret** on the phone and PWA, as stated in the ruling.
   Mitigations are in design §8.2.
5. **MEGA credentials.** megajs cannot resume a session without the password. The official SDK's
   session dump contains key material equivalent to full account access. Use a separate MEGA account
   for LLM-IDE only (design §8.3).
6. **Key loss.** Losing the desktop vault means re-pairing every device (relay D3, no recovery in v1).
7. **ADR churn.** ADR 0019 must be marked superseded in its header when this ADR is accepted, so that
   two half-designs do not coexist.

The iPhone uses its own minimal HTTPS client (SP4), not the official SDK; its saved session has the same power and the same custody (Keychain, this device only).

SP6 (2026-11-06) builds Box with a one-time OAuth consent on the desktop (not CCG) and the user's own Box app on phone and web; see the SP6 plan.
