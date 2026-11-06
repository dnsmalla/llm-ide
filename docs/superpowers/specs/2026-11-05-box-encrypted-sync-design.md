# Encrypted sync through user-owned storage (own server, Box, MEGA): design

Status: **proposed**, 2026-11-05. Decision: [ADR 0020](../../decisions/0020-box-encrypted-sync.md).
The research it builds on is the [offline desktop memo](../research/2026-11-05-offline-desktop-research.md).
It reuses the [relay design](../plans/2026-10-31-relay-design.md) (kinds, manifest, read-only ceiling,
epochs, threat model) and the relay v1 envelope (`schema/relay/v1`, reviewed in
[relay review](../reviews/2026-11-05-relay-review.md) batch 1 "Holds up"). The first implementation plan is
[desktop producer](../plans/2026-11-05-box-sync-desktop-producer.md).

The filename keeps the approved name "box". **The first adapter is MEGA (user decision, 2026-11-05).** The
user's own server over SFTP and Box follow as later sub-projects (§14). ADR 0020 records the order.

## 1. Goals and non-goals

**Goals**

1. With the desktop off, the iPhone app and the PWA can read the last snapshot of the desktop's own
   data: chats, meeting notes and meetings, tasks and plans, and usage. Each view shows how old it is.
2. With the desktop off, they can queue a chat prompt. It runs when the desktop is back, at a fixed
   read-only ceiling, and its answer comes back to the device that asked.
3. The storage provider learns no content and as little metadata as the backend allows. It cannot forge
   data or make the desktop run anything the ceiling forbids.
4. The desktop needs no login. Storage setup is done once and is not a sign-in.
5. It costs $0: user-owned storage only, with no new service to operate.
6. The storage sits behind one small interface, so another backend is one more adapter.

**Non-goals**

- No AI, search, code graph or planner with the desktop off.
- No copy of Box documents or GitLab code. Those are read at the source (section 9).
- No meeting transcripts and no file contents in v1 snapshots (open question Q2).
- No push notifications (they need a server; relay §7.4 later).
- No multi-user sharing. Keys are per user (relay D8).
- No change to the loopback-only core (ADR 0004). The desktop only makes outbound calls to the storage.
- No recovery key (relay D3). Losing the desktop vault means re-pairing every device.

## 2. Architecture

```text
 iPhone app / PWA (per-device keys)                 Desktop (Node core; Tauri app or Mac app)
   read: manifest.bin -> s/<file>.bin                 routes/sync/producer.mjs  (snapshots + manifest)
   queue: in/<ts>-<rand>.bin                          routes/sync/consumer.mjs  (inbox -> phone chat turn)
   answer: out/<requestId>.bin                        routes/sync/keys.mjs      (root, signing key, wraps)
          |                                                     |
          |  HTTPS (own server: nginx)                          |  SyncStore adapter
          |  Box API / MEGA API (Box, MEGA)                     |  sftp.mjs | box.mjs | mega.mjs
          v                                                     v
   +--------------------- user-owned storage: one dedicated folder ---------------------+
   |  ciphertext + signed envelopes only; per-device sub-folders; no keys in clear        |
   +-------------------------------------------------------------------------------------+
```

- **Producer and consumer live in the Node core** (`extension/routes/sync/`). The data is there
  (`kb/chat-sessions.mjs`, `kb/meetings.mjs`, `kb/plans.mjs`, `kb/usage.mjs`), and so is the turn entry
  point (`startHostTurn` in `routes/agent-v2.mjs`), and so is the Box connector. They sit in the routes
  layer because they call `startHostTurn` and reuse `routes/host-api/reads.mjs`. Nothing imports them
  except `server.mjs`. The Mac app runs the same core, so sync works under both desktop apps.
- **`SyncStore` adapters live in `extension/connectors/sync-store/`** (L3). They know nothing about
  keys or formats.
- **The envelope library is `extension/core/sync-envelope.mjs`** (L0). It uses Node `crypto` only. It is
  a shipped port of the reference's seal, open, subkey and wrap, checked against
  `schema/relay/v1/vectors/v1.json` and the new `schema/sync/v1/vectors/v1.json`.
- **The Rust host does not change** in sub-project 1. The keys live in the core vault, whose master key
  the host already keeps in the OS keychain (`desktop/src-tauri/src/secrets.rs`, `ACCOUNT_VAULT`).
- **Host API v1 stays the "desktop on" path:** live chat, approvals and reads over pinned TLS.

### 2.1 `SyncStore` interface

Every method is async. Paths are relative to the adapter's root. A path is 1 to 6 segments joined by
`/`, and each segment matches `^[A-Za-z0-9_.-]{1,64}$`, never `.` or `..`. The adapter checks this
before any I/O.

| Method | Contract |
|---|---|
| `put(path, bytes)` | Creates or replaces the file **atomically**: a reader sees the old bytes or the new bytes, never a mix. Parent folders are created. Bytes are at most 1,048,576 + 4,096. |
| `get(path)` | Returns `Uint8Array`, or `null` when the file is absent. Bytes are capped at the same limit, and a larger file is refused. |
| `list(dir)` | Returns `[{ name, size, mtimeMs }]` for the files directly in `dir`, or `[]` when `dir` is absent. Never recursive. |
| `remove(path)` | Deletes a file. A missing file is not an error. Where the backend has a trash, the file is purged permanently. |
| `removeTree(dir)` | Deletes a folder and everything under it (revoke). |
| `watch?(dir, onChange)` | Optional change signal (Box user events). If it is absent, the caller polls. Returns `stop()`. |
| `describe()` | Returns non-secret facts for Settings: `{ kind, root, account? }`. |

An adapter is created as `createXStore(config, secrets)`, and secrets come from the vault.
`connectors/sync-store/memory.mjs` is the test adapter. One contract test suite
(`tests/helpers/sync-store-contract.mjs`) runs against every adapter.

## 3. Folder layout

The adapter's root is a dedicated folder: the SFTP chroot `data/`, the Box folder `llmide-sync`, or
the MEGA folder `llmide-sync`.

```text
<syncId>/                          syncId: 16 random bytes, base64url (22 chars), = desktopId in envelopes
  d/<dir>/                         one folder per device; dir: 16 random bytes base64url, NOT the device id
    key.bin                        desktop signing SPKI (DER); its SHA-256 is the QR's sfp
    wrap.bin                       signed syncwrap for this device and the current epoch
    manifest.bin                   signed + encrypted manifest (fixed name, replaced in place)
    s/<32 hex>.bin                 snapshot blobs, fresh random name per publish
    in/<13-digit ms>-<22 b64u>.bin requests written by the device
    out/<requestId>.bin            replies written by the desktop
  e/<slot>/                        enrollment slot while a device is being added (2 minutes)
```

- **Per-device copies.** Each device gets its own copy of every snapshot, encrypted under its own key.
  Revoking a device is `removeTree(d/<dir>)` and needs no rotation. On the own server, a device's
  capability is exactly its folder (§8.1). Cost: a few MiB per device.
- **Names carry no meaning.** Kind names, device names and request content never appear in a path.
  Request file names carry the issue time, which the server sees anyway.
- **One writer per file.** The desktop writes `key.bin`, `wrap.bin`, `manifest.bin`, `s/` and `out/`.
  The device writes only new, uniquely named files in `in/` and `e/<slot>/`. No file has two writers,
  so there is nothing to merge.

## 4. Formats (`schema/sync/v1`)

### 4.1 Envelope

The relay v1 format is reused **byte for byte**: canonical `enc`, padding buckets 1 KiB to 1 MiB, the
header field order, AES-256-GCM with a random 96-bit nonce, AAD = `enc(header ++ [extra])`, ECDSA P-256
P1363 over `"llmide/<purpose>/v1\0" || enc(header ++ [extra, nonce, ct])`, the JSON form, and verify
before decrypt (`schema/relay/v1/README.md`). Sync v1 adds purposes and keys:

| Purpose | Sender → recipient | Key | Plaintext |
|---|---|---|---|
| `request` | device → desktop | `subkey(purpose 'request', sender deviceId, recipient syncId)` (relay v1) | JSON request (4.4) |
| `reply` | desktop → device | `subkey('reply', syncId, deviceId)` (relay v1) | JSON reply (4.4) |
| `snapshot` | desktop → device | `subkey('snapshot', syncId, deviceId)` | JSON kind (4.2) |
| `manifest` | desktop → device | `subkey('manifest', syncId, deviceId)` | JSON manifest (4.3) |
| `syncwrap` | desktop → device | ECDH wrap key with info label `"llmide/syncwrap/v1"` instead of `"llmide/wrap/v1"` | `enc([request, reply, snapshot, manifest])`, four 32-byte keys |
| `enroll` | device → desktop | `HKDF(es, salt = SHA-256("llmide-sync-enroll-v1"), info = enc(["enroll", syncId, slot]))` | `enc([ecdhSpki, signingSpki, name, mac])` (5.3) |

`subkey` is the relay v1 function: `HKDF-SHA-256(K_root[epoch], SHA-256("llmide-relay-v1" ||
enc([userId, desktopId])), enc([purpose, epoch, "", sender, recipient]), 32)`. Header values are
`userId` = the core user id, `desktopId` = `syncId`, `from`/`to` = sender/recipient, `session` = `""`,
and `tier` = `web` or `ios` on a syncwrap, `""` otherwise. `seq` is the publish counter (4.5). The
2^24-messages-per-key cap applies, and the desktop rotates long before it.

### 4.2 Snapshot kinds and size

The producer publishes a fixed allow-list of kinds. It re-redacts every string
(`redactSecretsForStorage`) and clamps it, the same way `routes/host-api/reads.mjs` does. One kind is
one blob, and its frame is at most 1,048,572 bytes (the largest bucket). Items are dropped from the
oldest end until the frame fits, and the frame then says `"truncated": true`.

| Kind | Content (v1) | Default depth |
|---|---|---|
| `chats` | sessions `{ id, title, updatedAt, phoneChat? }` + last messages `{ seq, role (user/assistant), content ≤ 8,000 chars }` | 20 sessions × 30 messages |
| `meetings` | `{ id, title, date, durationSec, participants ≤ 20, notes: [{ kind, text ≤ 500 }] ≤ 40 }` (notes = extracted entities: decisions, actions, questions). No transcript. | 50 meetings |
| `plans` | `{ id, title, goal ≤ 2,000, updatedAt, tasks: [{ title, status, owner, due, milestone, risk }] ≤ 100 }` | 30 plans |
| `usage` | `usageOf(usageSummary())` from `routes/host-api/reads.mjs`, unchanged | — |

The plaintext is `{"v":1,"kind":"chats","generatedAt":<ms>,"truncated":false,"items":[…]}`. The kind
name sits inside the ciphertext only.

### 4.3 Manifest

The plaintext is
`{"v":1,"manifestSeq":<n>,"epoch":<e>,"generatedAt":<ms>,"validUntil":<ms>,"kinds":{"chats":{"file":"s/<hex>.bin","seq":<n>,"sha256":"<hex of the blob file bytes>"},…}}`.
The header `seq` equals `manifestSeq`. A device:

1. verifies and decrypts `manifest.bin`;
2. refuses `manifestSeq` lower than the highest it has seen (rollback, relay H6);
3. fetches only the files the manifest names, and checks each file's SHA-256 before verifying the
   envelope. This prevents mix-and-match;
4. shows "Desktop last seen <generatedAt>" and, after `validUntil`, "Desktop offline or storage
   withholding updates".

The heartbeat republishes the manifest every 15 minutes with `validUntil = now + 45 min`.

### 4.4 Inbox and outbox

The request plaintext is a closed schema, and an unknown field is a refusal:
`{"v":1,"requestId":"<22 b64u>","class":"chat.send","text":"<1..4000 chars>"}`. The header `issuedAt`
is the device clock, and `seq` is a device-local counter (informational only). The file name is
`in/<issuedAt 13 digits>-<requestId>.bin`. The file is at most 64 KiB.

The reply plaintext is `{"v":1,"requestId":…,"ok":true,"text":"<≤ 100,000 chars>","finishedAt":<ms>}`
or `{"v":1,"requestId":…,"ok":false,"code":"<code>"}`. The codes are `expired`, `quota`,
`needs_approval`, `turn_failed`, `refused` and `stale_epoch`. It is written to `out/<requestId>.bin`,
and the desktop deletes it after 7 days.

### 4.5 Counters

The desktop keeps one durable counter per user: `seq = max(seq + 1, Date.now())`. Manifests and blobs
take values from it. It stays monotonic across a database restore from backup (relay §4.3, hybrid
counter) as long as the clock does not jump back. If the vault is restored without the counter, the
desktop starts a new epoch.

## 5. Keys

### 5.1 Hierarchy and custody

| Key | Where | Lifetime |
|---|---|---|
| `K_root[epoch]` (32 random bytes) | core vault `sync.rootKey` (internal key) | until rotation |
| Desktop signing key (ECDSA P-256, PKCS8) | core vault `sync.signingKey` | until "Reset sync" (devices re-pair) |
| MEGA sync-account email and password (MEGA adapter, SP1) | core vault `sync.megaEmail`, `sync.megaPassword` (internal keys) | until changed in Settings |
| SSH key (ed25519, OpenSSH) for the own-server adapter (later sub-project SP5) | core vault `sync.sshKey` | until "Replace key" |
| Per-device request/reply/snapshot/manifest keys | derived; sent to the device in its `syncwrap` | per epoch |
| Device ECDH and ECDSA P-256 pairs | device: iOS Keychain / Secure Enclave where possible; PWA non-extractable `CryptoKey` in IndexedDB | until revoke |

The vault (`server/vault.mjs`) encrypts with a per-user key derived from `LLMIDE_VAULT_KEY`. The Tauri
host keeps that key in the OS keychain (`secrets.rs`), and the Mac app keeps it in its own keychain. A
dedicated OS keychain item per sync key would need a new Rust command and IPC to the core. It is
deferred and recorded as open question Q13. Either way, nothing secret is written outside the vault or
logged.

### 5.2 Hand-over at pairing (MITM resistance from the QR channel)

The existing pairing QR (`llmide://pair?…`, shown by `ui/screens/settings/sections/HostApiPairing.tsx`)
gains sync fields when sync is on. The web form is `https://llm-ide.com/#pair=…`, with the fragment only
and `history.replaceState` before any other code runs.

| Field | Meaning |
|---|---|
| `sid` | syncId |
| `sfp` | SHA-256 of the desktop signing SPKI (base64url, the full 256 bits) |
| `dir` | the new device's folder name |
| `slot` | enrollment slot id (16 random bytes) |
| `es` | enrollment secret (16 random bytes), in the QR only, never stored by the storage or logged |
| `sv` | payload version, `1` |
| `st` | store descriptor: `sftp-https:<base URL>` / `box:<root folder id>` / `mega:<root node handle>` (non-secret) |

The flow follows relay §4.5, without a relay and without the v1 commitment flaws:

1. On an explicit click, the desktop opens slot `e/<slot>/` and device folder `d/<dir>/`, writes
   `d/<dir>/key.bin`, and shows the QR for 2 minutes. The window is excluded from screen capture where
   the OS allows it.
2. The device checks `key.bin` against `sfp` from the QR and pins it. It generates its two key pairs;
   `deviceId = b64u(SHA-256(signingSpki)[0..16])`. It writes `e/<slot>/<rand>.bin`, an `enroll` envelope signed by
   its new signing key (`eph` = its signing SPKI), with `mac = HMAC(E("bind"), enc([sid, slot, dir, sfp, tier,
   deviceId, ecdhSpki, signingSpki, name]))`.
3. The desktop reads the slot and **pins the first claim it sees; it never fetches it again**. It checks one claim
   only (a second kills the slot and raises an alert), the MAC and the 2-minute window by its own clock. It then
   writes one `e/<slot>/ack.bin` (`enrollack`, signed, under `E("enrollack")`) carrying a fresh 16-byte `nD` and
   `claimHash` of the pinned claim. The device accepts only an ack for its own claim. Both screens show
   `SAS = HMAC(E("sas"), enc([sid, slot, dir, sfp, tier, deviceId, ecdhSpki, signingSpki, name, nD]))` as 6 digits.
   `nD` is chosen after the claim is committed, so a QR photographer who also controls storage cannot grind keys
   to match the phone's code. The tier is the one the user picked on the desktop.
4. On "Codes match", the desktop records the device in its local registry, writes `d/<dir>/wrap.bin`, publishes, then deletes the slot.
5. The device verifies `wrap.bin` with the pinned key (tier = its own, epoch > 0), unwraps, erases `es`, and from
   then on reads only its own folder. Full contract: `schema/sync/v1/README.md` "Enrollment".

Why the storage cannot sit in the middle: it never sees `es`, so it cannot compute the MAC or the SAS
for keys of its choosing. It does not hold the desktop signing key, whose fingerprint came through the
QR, so it cannot forge `key.bin` or `wrap.bin`. This is the property the v1 linking ceremony lacked
(review round 3: the service picked the commitment after the reveal). Here no value the storage
supplies enters the SAS or the trust decision. Someone who photographs the QR inside the 2 minutes can
race the claim. They are caught by the contested-claim alert, or by the SAS on the phone in the user's
hand, as in relay T6 and T22.

The PIN for Host API v1 is untouched. One QR serves both: the Host API fields (`ip`, `pin`, `h1port`,
`h1fp`) and the sync fields.

### 5.3 Rotation and revoke without a server

- **Revoke a device** (Settings): the desktop deletes the registry row and runs `removeTree(d/<dir>)`.
  The other devices' keys are independent, so no rotation is needed.
- **Lost device, desktop off:** the user deletes the device's folder directly. On the own server that
  is `ssh` plus `rm -r`, as root on their own host. On Box or MEGA it is the provider's web UI. When the
  desktop next starts and finds a registered device without its folder, it drops the device and says
  so. It never recreates the folder.
- **Rotate keys** (Settings, or on suspected compromise of the desktop vault): new `K_root`, epoch + 1,
  a new `wrap.bin` for every registered device, full republish, then deletion of the old blobs. The
  order is relay §4.9: rotate, wrap, publish, delete. Devices erase old-epoch keys once the new manifest
  verifies. A request sealed under the old epoch gets `stale_epoch` under the old reply key, which the
  desktop keeps for 24 hours after a rotation.
- **Reset sync:** a new signing key and syncId. Every device re-pairs.

## 6. With the desktop off

| Works | Does not work |
|---|---|
| Read the last `chats`, `meetings`, `plans` and `usage` snapshot; see its age | AI, search, code graph, planning, approvals |
| Queue a chat prompt (`chat.send`) | Any write, edit, dispatch, Loop or Auto Task start |
| Read Box documents and GitLab code at the source (section 9) | Fresh chat or meeting data |
| Revoke a lost device by deleting its folder | Adding a device (the desktop must confirm) |

**Read-only ceiling for queued requests** (relay D2 and §5.2, unchanged):

1. Closed-schema validation first: size, then the envelope signature by the **registered** device
   signing key, `from` = that device, `to` = syncId, epoch = current, class in the allow-list. An
   unknown field is a refusal.
2. The age comes from the desktop clock: `issuedAt` no older than 24 hours and no more than 10 minutes
   ahead. A wrong-clock device is told (`expired`), not trusted.
3. At-most-once: the `(device, requestId)` row is recorded **before** the turn, and the inbox file is
   deleted after the record. A crash after the record answers `turn_failed` and never runs the turn
   twice.
4. The turn runs through `startHostTurn` in **`auto_read_only`**, in the per-user phone chat (the same
   one Host API v1 uses, `host_api_quick_chat`), in the extension chat workspace, never the open
   project. The desktop's own permission mode and Bypass grant do not matter. An approval request is
   never answered remotely: the consumer cancels the turn and replies `needs_approval`. A turn is capped
   at 10 minutes.
5. Quota: 5 requests per device per drain, 50 per device per day. Over the quota the reply is `quota`.
6. Raising the ceiling, or adding a class, is a code change plus a desktop setting. It is never
   something a device can ask for.

## 7. Conflict and ordering rules

- Every file has one writer (§3), so the store never merges anything.
- The desktop's clock and counter are authoritative. `manifestSeq` only increases, and devices reject
  anything lower.
- Snapshot update order: write the new blobs (new names), then the manifest, then delete the blobs the
  old manifest named. A device that reads an old manifest and finds a blob gone (404) refetches the
  manifest once, then reports "updating".
- Requests are processed per device in `issuedAt` order, then by name. Devices are drained round-robin.
  Prompts from two devices go into the one phone chat in drain order. Each reply goes only to its
  sender's `out/`.
- `put` is atomic per file. The SFTP adapter writes a temporary file then uses `posix-rename`. Box
  uploads a new version. MEGA uploads a new node with the same name, then deletes the old one
  permanently. Until the delete lands, a reader takes the newest node of that name.
- A device that sends the same `requestId` twice gets one execution. The second file is deleted
  without a turn, and its reply is the first one's.

## 8. Adapters

### 8.1 Own server over SFTP (later sub-project SP5)

Written first as the first adapter; the user then chose MEGA first (2026-11-05). The design below stands for SP5.

**Desktop library.** The Node core uses `ssh2` 1.17.0 (npm, MIT, published 2025-08-20). It is pure
JavaScript, and its optional native `cpu-features`/`nan` only speed it up. Its SFTP client provides
`readFile`, `writeFile`, `readdir`, `unlink`, `rmdir`, `mkdir` and `ext_openssh_rename`. Its
`hostVerifier(keyBlob)` hook pins the host key, and `utils.generateKeyPairSync('ed25519')` makes the
key. `ssh2-sftp-client` 12.1.1 (Apache-2.0) is a thin promise wrapper and is not needed. The Rust
options were considered and not chosen: `russh` 0.65.1 (Apache-2.0, 2026-11-03) with `russh-sftp`
3.0.1, or `ssh2` crate 0.9.6, which binds libssh2 in C. They would need the core to ask the host over
IPC for every file, and they would touch `desktop/src-tauri`, which another workstream is editing.

**Key and host key.**

- The desktop generates an ed25519 key, stores the OpenSSH private key in the vault (`sync.sshKey`),
  and shows the public line `ssh-ed25519 AAAA… llmide-sync-<syncId>`.
- The user pastes the server's host-key fingerprint, which they read on the server with
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
- The desktop connects only if the fingerprint of the presented key matches exactly. The fingerprint is
  `SHA256:` plus the unpadded base64 of SHA-256 over the key blob. There is never trust-on-first-use. A
  mismatch later is a hard stop with "The server's identity changed", and the setup must be redone.

**Server setup** (once, as root; `deploy/vps/sync-sftp.md` in SP5):

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin llmidesync
install -d -m 755 -o root -g root /srv/llmide-sync                 # chroot: root-owned, not writable
install -d -m 2770 -o llmidesync -g llmidesync /srv/llmide-sync/data
usermod -aG llmidesync www-data                                    # nginx reads data/, writes in/
install -d -m 755 /etc/ssh/authorized_keys
printf 'restrict %s\n' "<public line from Settings>" > /etc/ssh/authorized_keys/llmidesync
chmod 644 /etc/ssh/authorized_keys/llmidesync                      # root-owned: the sftp user cannot edit its keys
```

`/etc/ssh/sshd_config.d/50-llmidesync.conf`:

```text
Match User llmidesync
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ChrootDirectory /srv/llmide-sync
    ForceCommand internal-sftp -d /data -u 0007
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    PermitTunnel no
    X11Forwarding no
    PermitTTY no
    PermitUserRC no
```

Then run `sshd -t && systemctl reload ssh`. Check from the desktop machine that
`ssh llmidesync@72.62.76.92` is refused a shell and that `sftp` lands in `/data`.

**Phone and web endpoint (nginx, same origin as the PWA).** Browsers cannot speak SSH. A location on
the existing `llm-ide.com` vhost serves each device **only its own folder**. The folder name `dir` is
the bearer capability. Serving it on the PWA's own origin means no CORS at all.

```nginx
# GET: the device's own manifest, key, wrap, snapshots and replies. Nothing else, no listing.
location ~ "^/sync/(?<sid>[A-Za-z0-9_-]{22})/(?<f>d/[A-Za-z0-9_-]{22}/(?:key\.bin|wrap\.bin|manifest\.bin|s/[0-9a-f]{32}\.bin|out/[A-Za-z0-9_-]{22}\.bin)|e/[A-Za-z0-9_-]{22}/ack\.bin)$" {
    limit_except GET { deny all; }
    alias /srv/llmide-sync/data/$sid/d/$dir/$f;
    access_log off;                        # the path is a capability
    add_header Cache-Control "no-store" always;
    limit_req zone=llmidesync burst=40 nodelay;
}
# PUT: new request files into the device's own inbox, and enrollment claims. Small bodies only.
location ~ "^/sync/(?<sid>[A-Za-z0-9_-]{22})/(?<f>d/[A-Za-z0-9_-]{22}/in/[0-9]{13}-[A-Za-z0-9_-]{22}\.bin|e/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}\.bin)$" {
    limit_except PUT { deny all; }
    alias /srv/llmide-sync/data/$sid/$f;
    dav_methods PUT;
    create_full_put_path off;              # only folders the desktop created
    dav_access group:rw;
    client_max_body_size 64k;
    access_log off;
    limit_req zone=llmidesync burst=10 nodelay;
}
location /sync/ { access_log off; return 404; }
# in the http block: limit_req_zone $binary_remote_addr zone=llmidesync:1m rate=2r/s;
```

nginx writes the PUT body to a temporary file and renames it, so readers never see a partial request.

As built (SP5): the vhost file is normative; see `docs/superpowers/plans/2026-11-06-sync-sp5-sftp.md` "Spec corrections" for the `^~` shadowing, the ack GET, the PUT temp folder group, desktop-made folders, CORS and the inbox cap.
Ubuntu's `nginx` package includes the DAV module; check with `nginx -V 2>&1 | grep -o http_dav_module`.

Risks, stated plainly:

1. **The folder name is a bearer secret in a URL.** Access logs for `/sync/` are off, the PWA keeps it
   in IndexedDB, it travels only over HTTPS, and it can be revoked by deleting the folder. Error logs
   can still record paths when a request fails. The error log level is set to `crit` for this location.
2. **Overwrite.** A capability holder could PUT over its own earlier request name. That changes nothing
   the device could not send anyway, because every request is signed by the device key.
3. **Space.** A capability holder could fill its own `in/` with 64 KiB files at 2 requests per second.
   The desktop deletes anything it cannot verify. A size quota is set with `client_max_body_size` and
   the rate limit. Disk-full on the VPS affects the user's other sites, so the risk is stated, and a
   per-device cap of 200 files is checked by the desktop, which deletes the oldest.
4. **Same host as the PWA.** The operator of the PWA host and of the storage is the user. The relay §7.2
   statement stands: a web client is only as trustworthy as the host that serves it.

**iPhone: the HTTPS endpoint, not SFTP.** URLSession needs no new dependency, and the capability is
narrow, because nginx exposes one folder. SFTP from the phone would need Citadel (MIT) on swift-nio-ssh
(Apache-2.0), a per-device SSH key added to the server, and either a per-device Unix account or access
to the whole chroot. That is more code and a wider scope for the same function.

### 8.2 Box (later sub-project SP6)

**Desktop: CCG first, one-time consent as the fallback.** This is grounded in
`extension/connectors/box.mjs`. Today the connector authenticates with a Client Credentials Grant
(`buildTokenForm`: `grant_type=client_credentials`, `box_subject_type`, `box_subject_id`). The
non-secret config (`clientId`, `subjectType`, `subjectId`, `folderId`) lives in the desktop webview's
`localStorage` (`ui/screens/library/sources/source-config.ts`). The client secret lives in the vault
(`box.clientSecret`), and every call re-sends the config in the request body
(`routes/router.mjs` `/kb/box/test`, `/kb/connect-box`). The session (`makeSession`, ~60-minute tokens,
refresh on 401) and the pinned GET helper (`boxGet`: 429 back-off, redirect re-validation) are
reusable. The sync adapter adds:

- upload (`POST https://upload.box.com/api/2.0/files/content` and `/files/:id/content`; the host is
  already allowed by `isAllowedBoxUrl`);
- delete plus trash purge (`DELETE /files/:id`, then `DELETE /files/:id/trash`);
- folder create;
- a server-side copy of the non-secret sync config, so that the background producer does not depend
  on the webview.

**Default: CCG with `box_subject_type=user`.** It needs no browser step, so the desktop has no login.
The subject must be the user's own Box user. With `enterprise`, the token acts as the app's Service
Account, and files land in a tree the user's phone login cannot see. The sync setup therefore refuses
`enterprise` with that explanation. Per Box's CCG guide, a user subject needs the app setting
"Generate user access tokens" (and "App + Enterprise Access" for a managed user), and the app must be
authorised by an enterprise admin. A free developer account authorises its apps automatically.
**Unverified:** whether a Box Individual (personal, free) account can authorise a CCG app at all.

**Fallback: one-time OAuth 2.0 consent.** The flow is the authorization code in the system browser, a
loopback redirect, and the refresh token in the vault. Box refresh tokens are **single use and valid 60
days**, so each refresh returns a new one, which is stored in the same transaction. If the desktop
stays off for more than 60 days, Settings shows "Reconnect Box". The user decided this counts as setup,
not login (Q6).

**iPhone and PWA.** Box OAuth 2.0 with a "User Authentication" app the user creates in the Box
developer console:

- The PWA origin goes into the app's **CORS domains**. Box answers listed origins with
  `Access-Control-Allow-Origin: *` and others with 403 `cors_origin_not_whitelisted`.
- **Scope risk:** Box has no app-folder scope. Writing the inbox needs `root_readwrite`, which reaches
  the whole Box account. Mitigations: a separate Box app for LLM-IDE; tokens in the iOS Keychain, or
  in the PWA only in IndexedDB under the CSP of relay §7.3 (no third-party script, no raw HTML, no
  remote images); the scope shown in plain words at connect time; revocation in Box's console.
- **Client secret risk:** Box's token reference lists `client_secret` for `authorization_code` and does
  not document `code_verifier`. Treat the secret as required. Since it is the user's **own** app, its
  secret is delivered to their devices inside the encrypted enrollment bundle and kept in secure
  storage. It is never a shared app secret. An optional 20-line token-exchange location on the VPS
  could keep it server-side, but that reintroduces a server holding a credential, so it is not the
  default (Q7). Verify Box PKCE in sub-project 5 before building either.
- Change signal: Box user-event long polling (`GET /events` with `stream_position`) works from both the
  CCG and the OAuth session (`watch` in the adapter). Polling is the fallback.

### 8.3 MEGA (first adapter, user decision 2026-11-05)

Facts, checked 2026-11-05:

| Topic | Finding |
|---|---|
| Official SDK | `meganz/sdk`, C++, **BSD-2-Clause**, active (last push 2026-10-30). `fastLogin(session)` resumes from `dumpSession()`; `multiFactorAuthLogin(email, password, pin)`; `killSession(handle)`; needs an app key (`API_EAPPKEY`). Bindings exist for iOS (Objective-C, usable from Swift); there is **no Node binding**. |
| JS library | `megajs` (npm), **MIT**, **unofficial**, latest 1.3.10 (published 2026-04-20) and `next` 1.3.13-next.1, one maintainer, repository `qgustavor/mega` last pushed 2026-04-20 and not archived. Runs in Node and browsers (fetch-based, no native code); dependencies `pumpify` and `stream-skip` (MIT). It handles MEGA's `X-Hashcash` challenge and supports `secondFactorCode`. Its `login()` refuses to start a session without email and password ("starting a session without credentials isn't supported"). **Correction (read in the 1.3.10 package):** `Storage#toJSON()` / `Storage.fromJSON()` do resume a session without the password, but the JSON carries the session id **and the account master key**, so it is as powerful as the password. |
| OAuth / app tokens | None found. Third-party clients log in with email + password (+ 2FA code) and get a session. Absence is not confirmed by an official statement. |
| Session secret | A MEGA session that a client can resume (SDK `dumpSession`, MEGAcmd `session`) carries the session id **and the account key material**. Holding it gives full read and write to the whole account until it is killed (`killSession`, or "close other sessions" in the MEGA web app). |
| CORS | `g.api.mega.co.nz` answers a cross-origin preflight with `Access-Control-Allow-Origin: *` (checked with curl). A PWA can call the API. |
| Limits | API error `ERATELIMIT (-4)`: "exceeded your command weight per time quota". No numbers are published. The free plan's transfer quota number was not found (third-party pages say only "limited transfer"). Storage on the free plan is 20 GB (third-party pages). |
| Terms | mega.io could not be fetched from here. **Unverified:** terms for third-party and automated clients, and deletion of inactive free accounts. |

**Plain risk.** With no OAuth, the user gives LLM-IDE their MEGA credentials once on the desktop and
once per phone or browser. That conflicts in part with "the desktop needs no login": it is a one-time
setup, but it is the account password.

**Safest approach (default, Q8):**

1. **A separate MEGA account used only for LLM-IDE.** It holds nothing but our ciphertext, so its
   compromise exposes no personal files and no plaintext. The user's own MEGA account is never
   connected.
2. Desktop: the dedicated account's email and password are stored in the vault (`sync.megaEmail`,
   `sync.megaPassword`), which is keychain-rooted. The secret in custody is then that account's
   password and nothing else. A megajs `toJSON()` session, or the official SDK's `dumpSession()`, is
   not stored instead: it holds the master key, so it is just as powerful, and an expired session
   needs the password anyway.
3. 2FA: an unattended re-login needs a fresh TOTP every time, so 2FA is **off on the dedicated
   account**. 2FA stays on the user's personal account, which is never connected. Our own E2E envelope
   means a stolen dedicated account yields ciphertext only. Its worst case is deletion or freeze, which
   the manifest makes visible.
4. iPhone: a minimal HTTPS MEGA client in ios_app/SharedProtocol (MegaClient; OS crypto only, ported from megajs 1.3.10 and checked against megajs by a fixture), instead of the MEGA iOS SDK (C++ core plus six binary frameworks, an app key, non-OS crypto, and it would link into the Mac app through SharedProtocol). The password is typed once and never stored; the resumable session (session id + master key, as powerful as the SDK's dumpSession) is kept in the Keychain (ThisDeviceOnly). An expired session asks for the password again. Decision recorded in docs/superpowers/plans/2026-11-06-sync-sp4-ios.md.
   once and never stored.
5. PWA: megajs in the browser. The password is asked for **per app session** and never stored. The
   session lives in memory only.
6. MEGA's own E2E encryption stays on and is not relied on: defence in depth, one format for every
   backend.

**Desktop adapter choices (SP1).** Marked **[user]** where the user decided; the rest is design.

| Topic | Choice |
|---|---|
| Order | **[user]** MEGA is the first adapter, for now. SFTP (SP5) and Box (SP6) come later. |
| Library | `megajs` **1.3.10, exact pin** in `extension/package.json`, with a justification comment. Every newly locked transitive package must be MIT or ISC. |
| Account | **[user]** A dedicated MEGA account for LLM-IDE, recommended in plain words on the Settings card. |
| Credential custody | **[user]** Email and password only in the core vault (internal keys `sync.megaEmail`, `sync.megaPassword`). They are never logged. No route returns them: status shows the masked email (`l***@example.com`) and the folder only. The webview sends the password once, on Save, and clears the field. |
| 2FA | Not supported for the sync account. The adapter never sends a code. MEGA's `EMFAREQUIRED (-26)` becomes `SYNC_MFA_REQUIRED`, and the card tells the user to use a dedicated account with two-factor off. A refused login (`SYNC_AUTH_FAILED`, `SYNC_MFA_REQUIRED`) turns sync off instead of retrying, so MEGA never sees repeated failed logins. |
| Session | One logged-in megajs `Storage` per user, cached by the scheduler and reused while the core runs (`keepalive: true` keeps the file tree current). It is logged out on shutdown, on a setup change and when sync is turned off. A listener on `storage.api` `error` (a dead keepalive poll) drops the session; without one, Node would crash the core. |
| Expiry | `ESID (-15)` → drop the session, log in again once, retry the operation once. A second `ESID` is `SYNC_AUTH_FAILED`. |
| Rate limits | megajs already retries `EAGAIN (-3)` 4 times (2 to 16 s). The adapter then retries `EAGAIN`, `ERATELIMIT (-4)`, `ETOOMANY (-6)`, `ETEMPUNAVAIL (-18)` and `ETOOMANYCONNECTIONS (-19)` twice more (2 s, 8 s) and surfaces `SYNC_RATE_LIMITED`. The scheduler's exponential back-off (60 s doubling to 15 min) takes over from there. Operations on one store run one at a time. |
| Quota | `EOVERQUOTA (-17)`, `EGOINGOVERQUOTA (-24)` and an HTTP 509 on download → `SYNC_QUOTA`. |
| Folder | `llmide-sync` by default (editable, one path segment), at the root of the account's Cloud Drive, created on first use, which is the Test that runs right after Save. |
| Writes | Only sealed sync v1 envelopes are uploaded, on top of MEGA's own encryption. The one exception is the Settings probe, two bytes `ok` under a random `syncId`, deleted at once. Replace = upload a new node, then delete the old one. Every delete is permanent (`delete(true)`, no rubbish bin). |
| Watch | `watch(dir, onChange)` uses megajs's `add`/`update`/`delete` events. It is optional: the scheduler still polls. |
| Tests | The `SyncStore` contract suite runs against the memory adapter and a fake MEGA client (`tests/helpers/fake-mega.mjs`), with no network in CI. An opt-in manual run uses a real throwaway account: `LLMIDE_SYNC_MEGA_IT=1` plus `LLMIDE_SYNC_MEGA_IT_EMAIL` and `LLMIDE_SYNC_MEGA_IT_PASSWORD`. |

### 8.4 Comparison

| | Own server (SFTP + nginx) | Box | MEGA |
|---|---|---|---|
| Money | $0 (VPS already paid) | $0 (10 GB free, 250 MB/file) | $0 (20 GB free, third-party figure) |
| Desktop setup | key generated; public line + sshd/nginx config once; host key pasted | existing CCG connector (subject = user) or one-time consent | dedicated account email + password once |
| Desktop login needed | no | no (CCG) / consent once, again after 60 days off (OAuth) | password once (stored) |
| Phone/web | HTTPS to own folder, same origin, no new dependency | Box OAuth, whole-account scope, client secret on device | megajs (web), own HTTPS client (iOS), password per web session |
| Device scope | its own folder (nginx) | whole Box account | whole dedicated account |
| Metadata seen by | the user's own server only | Box: names (random), sizes, times, IPs | MEGA: sizes, times, IPs (names are encrypted by MEGA) |
| Rate limits | none beyond nginx `limit_req` | 1000 req/min/user, 240 uploads/min/user | unpublished command-weight quota; transfer quota on free plan |
| Availability | one VPS | Box | MEGA |
| New dependency | `ssh2` (npm, MIT) | none (extends `box.mjs`) | `megajs` (MIT, unofficial) |
| Works for users without a server | no | yes | yes |

## 9. Direct reads at the source (with the desktop off)

- **Box documents:** `GET /2.0/folders/:id/items`, `GET /2.0/files/:id/content`, and the
  `extracted_text` representation that `box.mjs` uses. The PWA origin must be in the Box app's CORS
  domains. If Box is not the sync backend, the doc-reading app asks for `root_readonly` only (Q11).
- **GitLab code:** `GET /api/v4/projects/:id/repository/tree` and `…/files/:path/raw?ref=`. Checked
  2026-11-05 with curl from a foreign origin: gitlab.com answers the preflight for `GET` with an
  `Authorization` header with `access-control-allow-origin: *`, `access-control-allow-headers:
  authorization`, and the same on the response. `/oauth/token` answers a `POST` preflight with `*`.
  **No proxy is needed for gitlab.com.** A self-hosted GitLab may differ. For that case only, there is
  an optional credential-less nginx `location /gitlab/` on the VPS that forwards the user's
  `Authorization` header, stores nothing, and has access logs off. Auth: GitLab OAuth with PKCE
  (short-lived token, `read_api` + `read_repository`) is preferred over a PAT in browser storage (Q12).
  The limits are 5,000 requests per hour and 100 per minute burst on Free.
- Those calls use the user's own provider logins and never pass through the sync store.

## 10. Rate limits and quotas

| Item | Budget |
|---|---|
| Producer check | every 60 s ± 15 s jitter; per device ≤ (changed kinds × 2) + 1 calls; heartbeat manifest every 15 min |
| Consumer drain | every 30 s: one `list` per device + one `get`/`remove` per request |
| Worst case, 3 devices, all 4 kinds changing | ~ 30 calls/min, far under Box's 1000/min. SFTP has no limit; one SSH connection per cycle, closed after. |
| Storage | ≤ 4 MiB per device (4 kinds × ≤ 1 MiB) + inbox ≤ 200 × 64 KiB + outbox (7 days) |
| Box free | 10 GB, 250 MB per upload, 240 uploads/min/user: unaffected |
| Back-off | 429/`Retry-After` (Box); `-3`/`-4`/`-6`/`-18`/`-19` (MEGA: two in-adapter retries at 2 s and 8 s, then the scheduler); SSH connect failure: exponential back-off up to 15 min; never blocks desktop work |

## 11. Privacy and metadata

- The storage provider sees ciphertext; random file and folder names; sizes rounded up to the padding
  buckets (1, 4, 16, 64, 256, 1024 KiB); write times; and the IP addresses of the desktop and devices.
- Not visible to it: kind names, device names, counts of chats or meetings (inside padded ciphertext),
  request content, and which kind changed (all blobs are renamed on publish; v1 does not add cover
  traffic, as relay §9 T15 states).
- The heartbeat is on a fixed schedule (relay D5), so activity timing leaks only at 60-second
  resolution.
- The desktop never logs decrypted content, folder capabilities, `es`, keys, the SSH key or the MEGA login. The logger
  records counts and error codes only.

## 12. Failure behaviour

| Failure | Behaviour |
|---|---|
| Storage unreachable, auth refused | back off; Settings shows the last error code and last successful publish; desktop work never waits on sync |
| Host key mismatch (SFTP) | stop, show "The server's identity changed", no retry until the setup is redone |
| MEGA login refused or 2FA required | sync turns off, Settings shows the code with guidance, no retry until the user saves the setup again (no lockout from repeated logins) |
| Disk full / quota | publish fails, the old manifest stays valid until `validUntil`; error shown |
| Desktop crash mid-publish | new blobs may be orphaned; the next publish lists `s/` and removes names the manifest does not reference |
| Crash after recording a request, before the reply | reply `turn_failed` on the next drain; never re-run |
| Device folder missing (deleted by the user) | device dropped from the registry, a notice is shown, the folder is never recreated |
| Unverifiable inbox file | deleted, counted in Settings ("2 requests refused"), no reply |
| Vault unreadable (vault key changed) | sync goes to "Reset needed"; every device must re-pair |
| Clock jump backwards | counter stays monotonic (`max(seq+1, now)`) |

## 13. Testing strategy

- **Shared vectors:** `scripts/sync-vectors.mjs` builds `schema/sync/v1/vectors/v1.json` with the
  independent reference `scripts/relay-reference.mjs`, using fixed keys, nonces and ephemeral keys for
  `snapshot`, `manifest`, `syncwrap` and `enroll`, plus negatives (flip, truncate, wrong purpose, wrong
  epoch, wrong `to`). The vectors are checked by:
  - Node `core/sync-envelope.mjs` (sub-project 1);
  - WebCrypto in `web/src/sync/` (sub-project 3);
  - Swift CryptoKit in `ios_app/SharedProtocol` (sub-project 4);
  - Rust only if a Rust consumer appears.

  The relay v1 vectors must keep passing in the Node port, which proves the shared primitives are the
  same bytes.
- **`SyncStore` contract suite:** atomic replace, absent-file `null`, list shape, path validation (`..`,
  `/`, empty, over-long), `removeTree`. In SP1 it runs against memory and MEGA (a fake MEGA client,
  plus an opt-in live run against a throwaway account with `LLMIDE_SYNC_MEGA_IT=1`). Later it runs
  against SFTP (a fake SFTP object over a temp directory, plus an opt-in live run with
  `LLMIDE_SYNC_SFTP_IT=user@host:port`, SP5) and Box (fetch stubs as in `tests/box-connector.test.mjs`, SP6).
- **Producer:** decrypt everything a test device would read. Check that the manifest hash binds the
  blobs, `manifestSeq` is monotonic, the size cap and truncation hold, old blobs are deleted after the
  manifest, and the store holds no plaintext marker (relay blindness test).
- **Consumer:** the permission matrix from relay §11.1, run with the desktop in Ask, Accept Edits and
  Bypass. The turn always goes through `startHostTurn` (`auto_read_only`); a replay runs once; a crash
  between record and reply does not re-run; an expired or future `issuedAt` is refused; unknown fields
  are refused; a wrong device signature or an unregistered device is refused; an approval request
  cancels the turn and replies `needs_approval`; the quota is enforced.
- **Enrollment** (sub-project 2): a malicious-store test. A fake store substitutes device keys, the
  wrap, `key.bin` and the slot contents at every step. Assert that the SAS differs, nothing enters the
  registry, and the device rejects the forged wrap.
- **nginx:** a curl script for the user (SP5 docs). GET outside the allow-list → 404; PUT to
  `manifest.bin` → 403/405; PUT larger than 64 KiB → 413; no `/sync/` lines in the access log.
- No regression: `make test`, `make regression`, `cd desktop && npm test`.

## 14. Decomposition

| # | Sub-project | Depends on | Delivers |
|---|---|---|---|
| **SP1** | Desktop producer: `SyncStore` + memory + **MEGA adapter** (**[user]** MEGA first, 2026-11-05; desktop megajs, dedicated account), sync v1 envelope + vectors, keys in the vault, snapshot producer, inbox consumer at the ceiling, Settings card | — | **plan written**; testable with a fake device and a fake MEGA client |
| SP2 | Enrollment and device registry: QR sync fields, slot flow with SAS, `wrap.bin`, revoke, rotate, missing-folder detection | SP1 | devices can be added and removed |
| SP3 | PWA sync tier: WebCrypto envelope (reuses `web/src/relay/crypto.ts` patterns), read views with staleness, queued prompt + reply, CSP; **MEGA client in the browser (megajs, password per app session)** | SP2 | web works with the desktop off — **plan written** (docs/superpowers/plans/2026-11-06-sync-sp3-web.md) |
| SP4 | iPhone sync tier: SharedProtocol envelope in Swift, read views + queue; **MEGA client (own HTTPS client in SharedProtocol, Keychain session)** | SP2 | iPhone works with the desktop off |
| SP5 | Own-server adapter: SFTP over `ssh2`, host-key pinning, desktop SSH key; sshd + nginx setup on the VPS, check script; URLSession / same-origin HTTPS clients for iPhone and PWA | SP1; clients after SP3/SP4 | users with their own server — **implemented (desktop, web, iPhone, 2026-11-06)** (docs/superpowers/plans/2026-11-06-sync-sp5-sftp.md) |
| SP6 | Box adapter: desktop upload/delete/purge/events in `box.mjs`, server-side sync config, CCG-user check, consent fallback; device Box OAuth (verify PKCE first) | SP1; clients after SP3/SP4 | users of Box — **plan written** (docs/superpowers/plans/2026-11-06-sync-sp6-box.md) |
| SP7 | Direct reads: Box documents and GitLab code in the PWA and the iPhone app (GitLab OAuth PKCE) | SP3/SP4 shells | docs and code with the desktop off — **implemented (web + iPhone, 2026-11-06)** (docs/superpowers/plans/2026-11-06-sync-sp7-direct-reads.md; owns the shared device OAuth module that SP6 reuses) |
| SP8 | Park and retire: ADR 0019 header "superseded by 0020", production refusal for `ACCOUNTS_RELAY` and the account service, nginx accounts vhost off, MASTER-PLAN Q-WEB-1/2, docs | — | one design in the docs |

## 15. Open questions for the user (secure, free defaults)

| # | Question | Default |
|---|---|---|
| Q1 | First adapter? | **[user, 2026-11-05]** MEGA first, for now; own server (SFTP) next, then Box |
| Q2 | Which kinds sync? Transcripts? | chats, meetings (extracted notes, no transcript), plans/tasks, usage; transcripts off |
| Q3 | Which requests may be queued? | chat prompt only |
| Q4 | Snapshot depth | 20 chats × 30 messages, 50 meetings, 30 plans |
| Q5 | Sync endpoint origin for the PWA | same origin `https://llm-ide.com/sync/` (no CORS) |
| Q6 | Box desktop auth | CCG with subject = user; one-time OAuth consent counts as setup, not login |
| Q7 | Box client secret on phone/web | the user's own Box app, secret in the enrollment bundle and device secure storage; no VPS exchange shim |
| Q8 | MEGA custody | **[user]** a dedicated MEGA account; email + password in the vault only; 2FA off on that account only (the adapter refuses 2FA accounts with guidance); PWA asks per session |
| Q9 | Scheduled key rotation | none; manual "Rotate keys" and after any suspected compromise |
| Q10 | Desktop-off revoke | delete the device folder on the storage; the desktop drops the device on its next start |
| Q11 | Box doc reads scope when Box is not the sync backend | `root_readonly` |
| Q12 | GitLab on phone/web | GitLab OAuth with PKCE, `read_api` + `read_repository`, short-lived; PAT only as fallback |
| Q13 | Sync keys in the vault (keychain-rooted) or dedicated OS keychain items | vault now; keychain items when a Rust change is convenient |

## 16. Grounding

**Verified on 2026-11-05:**

- Box: CCG subject types and admin authorisation (developer guide); refresh token single use and 60
  days; CORS domains behaviour; the token endpoint lists `client_secret` and no `code_verifier`.
- gitlab.com CORS (curl).
- MEGA API CORS (curl).
- Package and repository facts from the npm registry, crates.io and the GitHub API: `ssh2` 1.17.0,
  `ssh2-sftp-client` 12.1.1, `russh` 0.65.1, `russh-sftp` 3.0.1, `ssh2` crate 0.9.6, Citadel MIT,
  swift-nio-ssh Apache-2.0, `megajs` 1.3.10 MIT, `meganz/sdk` BSD-2-Clause.
- megajs login code; MEGA SDK `fastLogin`, `dumpSession`, `killSession` and `multiFactorAuthLogin` in
  `megaapi.h`.
- megajs 1.3.10 package contents (npm tarball, `dist/main.node-es.mjs`, `types/es.d.ts`): the `ERRORS`
  table and message format, its own 4 `EAGAIN` retries, keepalive `error` events on `storage.api`,
  `delete(permanent)`, `upload({ name, size }, buffer).complete`, `toJSON`/`fromJSON` content, and the
  `Storage` ESM export. Registry facts: version, `latest`/`next` tags, MIT, one maintainer, publish
  dates; GitHub API: last push 2026-04-20, not archived.

**Not verified:**

- Whether a Box Individual (personal, free) account can authorise a CCG app.
- Box PKCE support.
- Box version-history retention on free accounts. It does not matter for secrecy, because only
  ciphertext is stored.
- MEGA terms for third-party clients, the free transfer quota number, and the official absence of
  OAuth.
- That MEGA's server-command channel delivers a session's own deletes back to it. The MEGA adapter
  does not depend on it: it hides the nodes it deleted until the packet arrives.
- Whether MEGA locks an account after repeated failed logins. The design avoids the case: a refused
  login turns sync off.
- The `russh-sftp` license.
- The `ssh2` npm license field is empty in registry metadata. The repository states MIT; confirm before
  adding the dependency.

Sources: <https://developer.box.com/guides/authentication/client-credentials/>,
<https://developer.box.com/guides/authentication/client-credentials/client-credentials-setup/>,
<https://developer.box.com/guides/authentication/tokens/refresh/>,
<https://developer.box.com/guides/security/cors/>, <https://developer.box.com/reference/post-oauth2-token/>,
<https://github.com/qgustavor/mega>, <https://www.npmjs.com/package/megajs>,
<https://github.com/meganz/sdk> (`include/megaapi.h`), <https://github.com/t3rm1n4l/go-mega/pull/51>
(session dump and 2FA reuse), <https://forum.gitlab.com/t/gitlab-api-and-the-same-origin-policy/73983>,
<https://gitlab.com/gitlab-org/gitlab/-/issues/300077> (older reports that the curl check supersedes for
gitlab.com), and the research memo's sources.
