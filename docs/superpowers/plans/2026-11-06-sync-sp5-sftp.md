# Sync SP5: own server (SFTP + HTTPS) storage adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user's own server (the VPS) becomes a second sync storage next to MEGA, behind the existing `SyncStore` interface. The desktop writes over SFTP with an ed25519 key it generated, connects only to the pinned host key, and the web app and iPhone read and write their own device folder over a small HTTPS endpoint (nginx) on the same server.

**Architecture:** A new adapter `extension/connectors/sync-store/sftp.mjs` follows `mega.mjs`: `createSftpStore(config, secrets, { connect })`, one cached connection per user, serial operations, coded errors, and `ssh2` imported only on the first connection or key generation. The scheduler picks the adapter by `sync_state.store_kind` (`'sftp'` is already allowed by migration 0064). A new route `POST /kb/sync/sftp` saves the setup and generates the key. Switching the storage kind unlinks every device and reuses the SP1 store-change reset. On the server, sshd gets a chrooted, SFTP-only `Match` block and nginx gets two regex locations: GET for the files a device may read, PUT for the files it may write. The device side gets a store that talks plain HTTPS to them: `web/src/sync/https-store.ts` and `ios_app/SharedProtocol/.../SyncHttpsClient.swift`. In CI, the whole own-server path runs on a fake SFTP over a temp folder plus an nginx emulator that reads the location regexes from the real vhost file.

**Tech Stack:** Node 22 ESM, `ssh2` 1.17.0 (npm, MIT, exact pin), `node:test`; React 19 + TypeScript (desktop Settings in `ui/`, web app in `web/`); Swift 5.9 package + swift-testing (`ios_app/SharedProtocol`), SwiftUI app; nginx (DAV module, Ubuntu 24.04 package) and OpenSSH `internal-sftp` on the VPS.

**Spec:** `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md`: §2.1 SyncStore contract, §3 folder layout, §8.1 own server (normative for this plan, with the corrections in "Spec corrections" below), §11 privacy, §13 testing, §14 SP5 row, §15 Q5. ADR `docs/decisions/0020-box-encrypted-sync.md`. Read with the built code this plan extends:
- `extension/connectors/sync-store/index.mjs` (contract, `withTimeouts`, memory store) and `mega.mjs` (the shape to follow);
- `extension/routes/sync/scheduler.mjs` (`storeFor`, `dropStore`, `SETUP_ERRORS`), `http-routes.mjs` (`/kb/sync/mega`), `enroll.mjs`, `producer.mjs` (`writeDeviceWrap`), `registry.mjs`;
- `extension/kb/sync-state.mjs` (`storeKind`, `storeConfig`, `resetSyncPublish`, `deleteSyncDevice`);
- `ui/screens/settings/sections/SyncSection.tsx` + `ui/screens/settings/sync-model.ts`;
- `web/src/sync/mega-store.ts`, `controller.ts`, `web/src/screens/SyncTier.tsx`;
- `ios_app/SharedProtocol/Sources/SharedProtocol/MegaClient.swift`, `SyncDevice.swift`, `SyncEnroll.swift`, `ios_app/MyApp/Services/SyncStore.swift`;
- `deploy/vps/README.md`, `deploy/vps/llm-ide.com.nginx`.

## Global Constraints

- **Dependency:** `ssh2` **1.17.0** exactly (npm, `licenses: [{ type: "MIT" }]`, published 2025-08-20; deps `asn1`, `bcrypt-pbkdf`; optional `cpu-features`, `nan`). Pin without `^`. Add a `//` note in `extension/package.json` like the megajs one. `ssh2-sftp-client` is not added (spec §8.1).
- **Lazy:** `ssh2` is never loaded by the boot path or by importing any sync module. Only `connectSftp()` and `generateSyncSshKey()` import it, with `await import('ssh2')`. `ssh2` is CommonJS, so use `(await import('ssh2')).default`. This is checked by `tests/lazy-engine.test.mjs` (boot path) and the new `tests/sync-sftp-lazy.test.mjs` (sync modules). See `extension/CLAUDE.md` "Lazy engine".
- **No native code ships:** the desktop stage strips ssh2's optional compiled binding and `cpu-features`, so the pure-JS path always runs (Task 1).
- **Key custody:** the desktop generates an ed25519 key with `ssh2`'s `utils.generateKeyPairSync('ed25519', { comment: 'llmide-sync-<syncId>' })`. The OpenSSH private key lives in the vault only, as `sync.sshKey` (server-internal: never client-settable, listed or returned). The public line is not secret. It is kept in `storeConfig.publicKey` and shown in Settings.
- **Host key pinning (spec §8.1):** the user pastes the fingerprint printed by `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. It is `SHA256:` + the unpadded base64 of SHA-256 over the key blob. The client offers only `ssh-ed25519` as the server host key algorithm and connects only on an exact match. There is never trust-on-first-use. A mismatch is `SYNC_HOST_KEY_CHANGED`: sync turns off and the user must redo the setup. Auth is public key only (`authHandler: ['publickey']`).
- **Paths:** the SFTP root is `/data` inside the chroot `/srv/llmide-sync`, so files are at `/srv/llmide-sync/data/<path>` on disk and `https://<webHost>/sync/<path>` for devices. `checkPath` runs before any I/O (contract §2.1). `put` is atomic: write `.<name>.<12 hex>.part` in the same folder, then `posix-rename@openssh.com` over the target. `list` hides names that start with `.`. `removeTree` never follows a symlink.
- **Store descriptor `st`** (QR field, `schema/sync/v1/README.md`): `sftp:<webHost>`, where `webHost` is a lower-case DNS name matching `^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$` (no port, no IP: TLS needs the certificate's name). The same regex appears in Node, TypeScript and Swift; keep the three identical.
- **Device rule on the own server:** nginx never creates folders (`create_full_put_path off`). The desktop creates every folder a device writes into: `e/<slot>/` at enrollment start and `d/<dir>/in/` whenever it writes `key.bin`. It does this with the new optional `SyncStore.ensureDir(dir)`. MEGA and memory do not implement it; callers use `store.ensureDir?.(…)`.
- **HTTPS endpoint auth (decision D1):** the 22-char random folder names in the path (`sid`, `dir`, `slot`: 128 bits each) are the only capability. There is no bearer token. Why: a per-device token would sit in the same QR and the same device storage as `dir`, so it adds no secret the attacker would not get together with `dir`. Plain nginx cannot check per-device tokens without a reload per device or an extra service (`auth_request`, njs) on the VPS. Revoking by deleting the folder takes effect at once. Everything behind the capability is sealed and signed end to end, so holding it gives only ciphertext reads and writes of requests nobody can sign. Mitigations, all in the vhost: access logs off for `/sync/`, error log at `crit`, `Cache-Control: no-store`, `Referrer-Policy` (the server-level `no-referrer` plus `referrerPolicy: "no-referrer"` on every fetch), a 64 KiB PUT cap, and `limit_req` at 2 r/s per client address with status 429.
- **CORS:** answered only for exact origins in the vhost `map` (default: `https://llm-ide.com` only). Same-origin PWA requests need none. Never `*`. The web app dev origin `http://127.0.0.1:5180` is a commented line (decision D3).
- **CSP:** the web app's `connect-src` adds exactly `https://llm-ide.com` (decision D2). It stays identical in `web/vite.config.ts`, `web/scripts/serve.mjs` and `deploy/vps/llm-ide.com.nginx` (checked by `web/tests/scaffold.test.mjs`).
- **Switching storage kind (decision D4):** saving MEGA while the own server is configured, or the reverse, runs the switch under the per-user lock, then saves the new setup. The switch drops a pending enrollment, unlinks every device row, deletes the old kind's vault secrets (`sync.megaEmail`, `sync.megaPassword`, `sync.sshKey`) and calls `resetSyncPublish` (the SP1 store-change reset of wraps and blob records). The old storage's files are left in place, and Settings says so. Settings asks before switching.
- **Never log** the private key, folder names, `es`, decrypted content or request text. Error messages carry codes only. Error texts: `SYNC_HOST_KEY_CHANGED`, `SYNC_AUTH_FAILED`, `SYNC_UNREACHABLE`, `SYNC_IO`, `SYNC_TOO_LARGE`, `SYNC_TIMEOUT`, `SYNC_BAD_PATH`.
- **API:** `SERVER_API_VERSION` 113 → 114. Add `/kb/sync/sftp` to `ALL_ENDPOINTS`. Add the schema entry, a fixture, and regenerate `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml` and `schema/http/INVENTORY.md`. `make contract-gates` must pass.
- **Mac app frozen:** no change under `mac/Sources/`. `mac/Package.swift` links `ios_app/SharedProtocol`, so `cd mac && swift build` must still pass. New SharedProtocol top-level types start with `Sync` and are never named `SyncError` or `SyncProvider` (both exist in the Mac app).
- **Other workstreams:** at plan time `desktop/src-tauri/**`, `desktop/scripts/verify-bundle*.mjs`, `desktop/scripts/check-dompurify*.mjs`, `ios_app/MyApp/Supporting/Info.plist`, `ui/screens/settings/sections/ServerSection.tsx`, `ui/screens/shell/**`, `ui/screens/explorer/**` and `ui/screens/bridge/**` had uncommitted changes that are not ours. Do not touch them. If you must edit a file with foreign hunks, stage only your own hunks (`git add -p`).
- **Tests:** extension `cd extension && node --test tests/<file>`; desktop UI `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs`; web `cd web && node --test --experimental-strip-types tests/<file>`; iOS `make test-shared-protocol` (needs full Xcode, see SP4 plan). Tests that bind `127.0.0.1` fail inside a sandbox without local binding; retry outside it and say so.
- Commit on `main` (user rule: no branches), Conventional Commits, one concern per commit, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Spec corrections (found while grounding; this plan follows the corrected form)

1. **`location ^~ /sync/` would shadow the regex locations.** In nginx, a matching `^~` prefix location stops the regex search, so every `/sync/` request would be 404. The catch-all is a plain prefix: `location /sync/ { access_log off; return 404; }`.
2. **The GET allow-list misses the enrollment ack.** A device reads `<sid>/e/<slot>/ack.bin` (`web/src/sync/device.ts readAck`, `SyncDevice.readAck`). The GET regex gains `e/<Id22>/ack\.bin`.
3. **nginx PUT files must be readable by the SFTP user.** nginx writes the body to `client_body_temp_path` and renames it into place. A rename keeps the temp file's group, so files would be `www-data:www-data 0660` and the desktop could not read them. The temp folder is `/srv/llmide-sync-tmp`, mode `2770`, owner `www-data`, group `llmidesync`, on the same filesystem. Its files are created with group `llmidesync`, and the rename is atomic.
4. **The device cannot create folders on the own server** (nginx `create_full_put_path off`), so the desktop creates `e/<slot>/` and `d/<dir>/in/` with `ensureDir` (Global Constraints).
5. **CORS:** §8.1 says the endpoint is served on the PWA's own origin "so no CORS at all". That holds for the deployed PWA. The web dev server (`http://127.0.0.1:5180`) is cross-origin, and so is any other app origin, so the vhost answers CORS only for an exact allow-list (D3).
6. **Per-device 200-file inbox cap (§8.1 risk 3): not built.** `routes/sync/consumer.mjs drainOnce` already deletes every inbox file it cannot verify, every 30 s, without counting it toward `perDrain`. With `limit_req` at 2 r/s, that bounds `in/` to about 60 unverifiable files per drain. Valid requests need the device's signing key. Recorded as a known limit in `deploy/vps/sync-sftp.md`.

## File structure

| File | Responsibility |
|---|---|
| `extension/connectors/sync-store/sftp.mjs` (new) | Fingerprints, config validation, key generation, the pinned `ssh2` connection, and the SFTP `SyncStore` |
| `extension/connectors/sync-store/index.mjs` | `withTimeouts` also wraps `ensureDir` |
| `extension/tests/helpers/fake-sftp.mjs` (new) | ssh2-shaped SFTP fake over a temp dir |
| `extension/tests/helpers/fake-nginx-sync.mjs` (new) | Emulates the vhost's `/sync/` locations over the same temp dir (regexes read from the vhost file) |
| `extension/tests/sync-store-sftp.test.mjs` (new) | Contract + adapter behaviour on the fake; opt-in live run |
| `extension/tests/sync-store-sftp-ssh.test.mjs` (new) | Real `ssh2` client against an in-process `ssh2` server on loopback: pinning and key auth |
| `extension/tests/sync-sftp-lazy.test.mjs` (new) | ssh2 not loaded by importing the sync modules |
| `extension/tests/sync-own-server.test.mjs` (new) | Enrollment → publish → queued prompt → reply over SFTP + nginx emulator; static checks of the deploy files |
| `extension/routes/sync/scheduler.mjs` | `storeFor` picks MEGA or SFTP; `SYNC_HOST_KEY_CHANGED` is a setup error |
| `extension/routes/sync/http-routes.mjs` | `POST /kb/sync/sftp`, sftp status, storage-kind switch, `SYNC_BUSY` → 409 |
| `extension/routes/sync/enroll.mjs`, `producer.mjs` | `ensureDir` for the slot and `in/` |
| `extension/core/sync-enroll.mjs`, `schema/sync/v1/README.md` | `st` accepts `sftp:<webHost>` |
| `extension/server/vault.mjs` | `sync.sshKey` allowed + internal |
| `extension/server.mjs`, `schema/http/sync.schema.json`, `schema/http/fixtures/sync/post-kb-sync-sftp-200.json` + generated files | API v114 |
| `desktop/scripts/stage-core.mjs`, `desktop/scripts/check-core-deps.mjs` | Strip ssh2 native code; check ssh2 resolves in the stage |
| `deploy/vps/llm-ide.com.nginx` | Rate zone, CORS map, `/sync/` locations, CSP |
| `deploy/vps/50-llmidesync.conf` (new) | sshd `Match User llmidesync` |
| `deploy/vps/sync-sftp.md` (new, named by spec §8.1) | One-time server setup, verify, known limits |
| `deploy/vps/check-sync.sh` (new) | Live checks: `remote` (curl + ssh from outside) and `server` (as root on the VPS) |
| `deploy/vps/README.md` | Link to the sync setup |
| `ui/screens/settings/sync-model.ts`, `sections/SyncSection.tsx`, `sections/SyncOwnServer.tsx` (new) | Storage choice, own-server form, public key + install command |
| `web/src/sync/https-store.ts` (new), `controller.ts`, `enroll.ts`, `web/src/screens/SyncTier.tsx` | Browser store for `sftp:` pairings; no login form for it |
| `web/vite.config.ts`, `web/scripts/serve.mjs`, `web/tests/scaffold.test.mjs`, `web/DEPLOY.md` | CSP `connect-src` |
| `ios_app/SharedProtocol/Sources/SharedProtocol/SyncHttpsClient.swift` (new), `SyncEnroll.swift` | iPhone store for `sftp:` pairings |
| `ios_app/MyApp/Services/SyncStore.swift`, `ios_app/MyApp/Views/Control/SyncEnrollSheet.swift` | App uses either store |
| `extension/CLAUDE.md` | Sync section |

---

### Task 1: `ssh2` dependency, pinned connection, fingerprints and key generation

**Files:**
- Create: `extension/connectors/sync-store/sftp.mjs`
- Create: `extension/tests/sync-store-sftp-ssh.test.mjs`
- Create: `extension/tests/sync-sftp-lazy.test.mjs`
- Modify: `extension/package.json` (dependencies + `//` note), `extension/package-lock.json`
- Modify: `extension/tests/lazy-engine.test.mjs` (one more boot-path assertion)
- Modify: `desktop/scripts/stage-core.mjs` (strip native), `desktop/scripts/check-core-deps.mjs` (ssh2 resolves)

**Interfaces:**
- Produces (all exported from `sftp.mjs`):
  - `DEFAULT_SFTP_ROOT = '/data'`, `DEFAULT_SFTP_USER = 'llmidesync'`, `DEFAULT_WEB_HOST = 'llm-ide.com'`, `WEB_HOST_RE`
  - `hostKeyFingerprint(blob: Buffer): string` → `'SHA256:<43>'`
  - `parseHostFingerprint(text: unknown): string | null`
  - `validateSftpConfig(c): null | 'host' | 'port' | 'username' | 'hostFingerprint' | 'webHost' | 'root'`
  - `classifySftpError(e): 'SYNC_…'`
  - `coded(code): Error & { code }`
  - `generateSyncSshKey(comment: string): Promise<{ privateKey: string, publicKey: string }>`
  - `connectSftp({ host, port, username, hostFingerprint, privateKey }, { onLost? }): Promise<{ sftp, close(): void }>`

- [ ] **Step 1: Add the dependency**

```bash
cd extension && npm install --save-exact ssh2@1.17.0
```

Check `package.json` reads `"ssh2": "1.17.0"` (no caret). Replace the `"//"` value with:

```json
  "//": "megajs 1.3.10 (exact): MEGA client for the first encrypted-sync adapter (connectors/sync-store/mega.mjs), user decision 2026-11-05. MEGA ships no Node SDK and no OAuth; megajs is MIT, unofficial, fetch-based, no native code. ssh2 1.17.0 (exact): SFTP client for the own-server sync adapter (connectors/sync-store/sftp.mjs, SP5), MIT, pure JavaScript; its optional native speed-ups are stripped from the desktop stage. Both are lazy: never on the boot path. Exact pins because they handle the sync logins."
```

- [ ] **Step 2: Write the failing tests**

`extension/tests/sync-sftp-lazy.test.mjs`:

```js
// ssh2 stays off the sync modules' import path: it loads on the first SFTP connection or SSH key generation only
// (extension/CLAUDE.md "Lazy engine"). Module-load hook as in tests/lazy-engine.test.mjs; one process per test file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeModule from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
process.env.LLMIDE_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-sftp-lazy-')), 'kb.db');

const hooks = typeof nodeModule.registerHooks === 'function';
const loaded = [];
if (hooks) nodeModule.registerHooks({ load(url, ctx, next) { loaded.push(url); return next(url, ctx); } });
const ssh2Loaded = () => loaded.some((u) => u.includes('/node_modules/ssh2/'));

await import('../connectors/sync-store/sftp.mjs');
await import('../routes/sync/scheduler.mjs');
await import('../routes/sync/http-routes.mjs');
const afterImports = ssh2Loaded();

test('importing the SFTP adapter and the sync routes loads no ssh2', { skip: !hooks && 'needs module.registerHooks (Node >= 22.15)' }, () => {
  assert.equal(afterImports, false);
});

test('generating the sync SSH key loads ssh2 and makes an ed25519 OpenSSH key', { skip: !hooks && 'needs module.registerHooks' }, async () => {
  const { generateSyncSshKey } = await import('../connectors/sync-store/sftp.mjs');
  const k = await generateSyncSshKey('llmide-sync-test');
  assert.match(k.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ llmide-sync-test$/);
  assert.match(k.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.equal(ssh2Loaded(), true);
});
```

(This test needs `routes/sync/scheduler.mjs` and `http-routes.mjs` to import `sftp.mjs`, which Tasks 3 and 4 add. Until then it already passes for `sftp.mjs` alone. Run it again in Tasks 3 and 4.)

`extension/tests/sync-store-sftp-ssh.test.mjs`:

```js
// The real ssh2 client against an in-process ssh2 server on 127.0.0.1 (no outside network): it connects only when the
// presented ed25519 host key matches the pinned fingerprint (never trust-on-first-use, and no auth attempt before the
// check), authenticates with the public key only, and reports refusals as SYNC_* codes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { connectSftp, hostKeyFingerprint, generateSyncSshKey } from '../connectors/sync-store/sftp.mjs';

const { Server, utils } = (await import('ssh2')).default;
const hostKey = utils.generateKeyPairSync('ed25519');
const pinned = hostKeyFingerprint(Buffer.from(hostKey.public.split(' ')[1], 'base64'));
const clientKey = await generateSyncSshKey('llmide-sync-test');
const allowed = utils.parseKey(clientKey.publicKey);
let auths = 0;

const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    auths += 1;
    const ok = ctx.method === 'publickey' && ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0
      && (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true);
    return ok ? ctx.accept() : ctx.reject(['publickey']);
  });
  client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acceptSftp) => { acceptSftp(); })));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
after(() => server.close());
const target = { host: '127.0.0.1', port, username: 'llmidesync', hostFingerprint: pinned, privateKey: clientKey.privateKey };
const code = (c) => (e) => { assert.equal(e.code, c); return true; };

test('the pinned host key and the generated key connect and open SFTP', async () => {
  const s = await connectSftp(target);
  assert.equal(typeof s.sftp.readdir, 'function');
  s.close();
});

test('a different host key is refused before any authentication', async () => {
  const before = auths;
  await assert.rejects(connectSftp({ ...target, hostFingerprint: `SHA256:${'A'.repeat(43)}` }), code('SYNC_HOST_KEY_CHANGED'));
  assert.equal(auths, before, 'the client never offered its key to an unpinned server');
});

test('a key the server does not know is SYNC_AUTH_FAILED', async () => {
  const other = await generateSyncSshKey('other');
  await assert.rejects(connectSftp({ ...target, privateKey: other.privateKey }), code('SYNC_AUTH_FAILED'));
});

test('a closed port is SYNC_UNREACHABLE', async () => {
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  await assert.rejects(connectSftp({ ...target, port: free }), code('SYNC_UNREACHABLE'));
});
```

Append to `extension/tests/lazy-engine.test.mjs`, after `megaLoaded`:

```js
const ssh2Loaded = () => loadedUrls.some((u) => u.includes('/node_modules/ssh2/'));
```

and at the end of the file:

```js
test('ssh2 is not loaded by the boot path', () => { assert.equal(ssh2Loaded(), false); });
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd extension && node --test tests/sync-sftp-lazy.test.mjs tests/sync-store-sftp-ssh.test.mjs`
Expected: FAIL with `Cannot find module '../connectors/sync-store/sftp.mjs'`.

- [ ] **Step 4: Write `sftp.mjs` (connection part)**

```js
// SyncStore over SFTP to the user's own server (design 8.1, SP5). The desktop logs in as the chrooted sftp-only user
// with an ed25519 key it generated (OpenSSH private key in the vault only, sync.sshKey). It connects only when the
// server presents exactly the ed25519 host key whose SHA256 fingerprint the user pasted: never trust-on-first-use. A
// different key is SYNC_HOST_KEY_CHANGED, which turns sync off until the setup is redone. ssh2 is imported on the first
// connection or key generation, never on the boot path. The key never appears in a log line or an error.
import { createHash } from 'node:crypto';

export const DEFAULT_SFTP_ROOT = '/data';
export const DEFAULT_SFTP_USER = 'llmidesync';
export const DEFAULT_WEB_HOST = 'llm-ide.com';
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/; // DNS name or IPv4
export const WEB_HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/; // same in web enroll.ts and SyncEnroll.swift
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ROOT_RE = /^(\/[A-Za-z0-9_.-]{1,64}){1,8}$/;
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE']);
const MESSAGES = {
  SYNC_HOST_KEY_CHANGED: "The server's identity changed",
  SYNC_AUTH_FAILED: 'The server refused the sync key',
  SYNC_UNREACHABLE: 'Sync server not reachable',
  SYNC_TOO_LARGE: 'Sync file too large',
  SYNC_IO: 'Sync server operation failed',
};

export const coded = (code) => Object.assign(new Error(MESSAGES[code] ?? MESSAGES.SYNC_IO), { code });

/** OpenSSH's SHA256 fingerprint of a public key blob (what `ssh-keygen -lf` prints). */
export const hostKeyFingerprint = (blob) => `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

/** The SHA256:… token from a pasted `ssh-keygen -lf` line or a bare fingerprint (a trailing "=" is dropped), else null. */
export function parseHostFingerprint(text) {
  const m = /SHA256:([A-Za-z0-9+/]{43})=?(?![A-Za-z0-9+/=])/.exec(String(text ?? ''));
  return m ? `SHA256:${m[1]}` : null;
}

export function validateSftpConfig(c) {
  if (!c || typeof c.host !== 'string' || !HOST_RE.test(c.host)) return 'host';
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return 'port';
  if (typeof c.username !== 'string' || !USER_RE.test(c.username)) return 'username';
  if (typeof c.hostFingerprint !== 'string' || !FP_RE.test(c.hostFingerprint)) return 'hostFingerprint';
  if (typeof c.webHost !== 'string' || !WEB_HOST_RE.test(c.webHost)) return 'webHost';
  if (typeof c.root !== 'string' || !ROOT_RE.test(c.root) || c.root.split('/').some((s) => s === '.' || s === '..')) return 'root';
  return null;
}

export function classifySftpError(e) {
  if (String(e?.code ?? '').startsWith('SYNC_')) return e.code;
  if (e?.level === 'client-authentication') return 'SYNC_AUTH_FAILED';
  if (e?.level === 'client-timeout' || NETWORK.has(e?.code)) return 'SYNC_UNREACHABLE';
  if (/Timed out while waiting for handshake|No response from server|Not connected|connection lost/i.test(String(e?.message ?? ''))) return 'SYNC_UNREACHABLE';
  return 'SYNC_IO';
}

export async function generateSyncSshKey(comment) {
  const { utils } = (await import('ssh2')).default;
  const k = utils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: k.private, publicKey: k.public };
}

/** One pinned, key-authenticated SSH connection with its SFTP channel. onLost fires once the live connection dies. */
export async function connectSftp({ host, port, username, hostFingerprint, privateKey }, { onLost = () => {} } = {}) {
  const { Client } = (await import('ssh2')).default;
  return new Promise((resolve, reject) => {
    const client = new Client();
    let hostRejected = false;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* already closed */ }
      reject(hostRejected ? coded('SYNC_HOST_KEY_CHANGED') : coded(classifySftpError(e)));
    };
    client.on('error', (e) => (settled ? onLost(e) : fail(e)));
    client.on('close', () => (settled ? onLost() : fail(new Error('connection lost'))));
    client.on('ready', () => client.sftp((e, sftp) => {
      if (e) return fail(e);
      settled = true;
      resolve({ sftp, close: () => client.end() });
    }));
    try {
      client.connect({
        host, port, username, privateKey,
        authHandler: ['publickey'],
        algorithms: { serverHostKey: ['ssh-ed25519'] },
        hostVerifier: (key) => { const ok = hostKeyFingerprint(key) === hostFingerprint; if (!ok) hostRejected = true; return ok; },
        readyTimeout: 20_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
      });
    } catch (e) { fail(e); }
  });
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd extension && node --test tests/sync-sftp-lazy.test.mjs tests/sync-store-sftp-ssh.test.mjs tests/lazy-engine.test.mjs`
Expected: PASS. If the ssh test fails with `EPERM` on listen, local binding is blocked by the sandbox. Rerun outside the sandbox and note it.

- [ ] **Step 6: Keep native code out of the desktop stage**

In `desktop/scripts/stage-core.mjs`, right after `rmSync(join(nm, '@rollup'), { recursive: true, force: true }); // vite-only optional dep`, add:

```js
// ssh2 (own-server sync) runs pure JavaScript: drop its optional compiled binding and cpu-features, which the install
// step may have built against the build machine's node rather than the bundled one.
rmSync(join(nm, 'ssh2', 'lib', 'protocol', 'crypto', 'build'), { recursive: true, force: true });
rmSync(join(nm, 'cpu-features'), { recursive: true, force: true });
```

In `desktop/scripts/check-core-deps.mjs`, add to the list after the `zod` entry:

```js
  {
    name: 'ssh2 (own-server sync)',
    spec: 'ssh2',
    expect: 'typeof m.default?.Client === "function"',
  },
```

Run: `cd desktop && node --test scripts/*.test.mjs && node --check scripts/stage-core.mjs && node --check scripts/check-core-deps.mjs`
Expected: PASS, with no new failure. `check-core-deps.mjs` has no unit test and needs a staged core to run; do not stage in this task. The next release stage (`desktop/PACKAGING.md`) runs it.

- [ ] **Step 7: Commit**

```bash
git add extension/package.json extension/package-lock.json extension/connectors/sync-store/sftp.mjs extension/tests/sync-store-sftp-ssh.test.mjs extension/tests/sync-sftp-lazy.test.mjs extension/tests/lazy-engine.test.mjs desktop/scripts/stage-core.mjs desktop/scripts/check-core-deps.mjs
git commit -m "feat(sync): pinned SFTP connection over ssh2 for the own-server adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The SFTP `SyncStore`

**Files:**
- Modify: `extension/connectors/sync-store/sftp.mjs` (append the store)
- Modify: `extension/connectors/sync-store/index.mjs` (`withTimeouts` wraps `ensureDir`; contract comment)
- Create: `extension/tests/helpers/fake-sftp.mjs`
- Create: `extension/tests/sync-store-sftp.test.mjs`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `createSftpStore(config, secrets: { privateKey }, { connect = connectSftp } = {}): SyncStore` with `put/get/list/remove/removeTree/ensureDir(dir)/describe()/close()`. `describe()` returns `{ kind: 'sftp', root: config.webHost, account: '<user>@<host>:<port>' }`. Enrollment builds `st = '<kind>:<root>'`, so `st = 'sftp:<webHost>'`. `createFakeSftp()` returns `{ root, connect, lose(), failNext(op, err?), calls, connects, closes }`.

- [ ] **Step 1: Write the fake**

`extension/tests/helpers/fake-sftp.mjs`:

```js
// A fake ssh2 SFTP session over a temp directory, for connectors/sync-store/sftp.mjs: only the calls the adapter makes,
// with ssh2's callback shape and error shape (err.code = SFTP status: 2 no such file, 3 permission denied, 4 failure).
// The adapter's '/data' root is <root>/data. connect() counts connections; lose() fires onLost on the live one;
// failNext(op) makes the next call of op fail (default: a lost-connection error). No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATUS = { ENOENT: 2, ENOTDIR: 2, EACCES: 3, EPERM: 3 };
const sftpError = (e) => Object.assign(new Error(e.message), { code: STATUS[e.code] ?? 4 });
const stats = (s) => ({ mode: s.mode, size: s.size, mtime: Math.floor(s.mtimeMs / 1000), isFile: () => s.isFile(), isDirectory: () => s.isDirectory() });

export function createFakeSftp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-fake-sftp-'));
  fs.mkdirSync(path.join(root, 'data'));
  const f = { root, connects: 0, closes: 0, calls: [], failing: new Map(), onLost: null };
  const real = (p) => {
    if (typeof p !== 'string' || !p.startsWith('/') || p.split('/').includes('..')) throw new Error(`fake sftp: bad path ${p}`);
    return path.join(root, p);
  };
  const op = (name, fn) => (...args) => {
    const cb = args.pop();
    f.calls.push(name);
    const failure = f.failing.get(name);
    if (failure) { f.failing.delete(name); cb(failure); return; }
    let out;
    try { out = fn(...args); } catch (e) { cb(sftpError(e)); return; }
    cb(null, out);
  };
  const sftp = {
    stat: op('stat', (p) => stats(fs.statSync(real(p)))),
    readFile: op('readFile', (p) => fs.readFileSync(real(p))),
    writeFile: op('writeFile', (p, data, opts) => { fs.writeFileSync(real(p), data, { mode: opts?.mode ?? 0o644 }); }),
    readdir: op('readdir', (p) => ['.', '..', ...fs.readdirSync(real(p))]
      .map((name) => ({ filename: name, longname: name, attrs: stats(fs.lstatSync(path.join(real(p), name))) }))),
    mkdir: op('mkdir', (p) => { fs.mkdirSync(real(p)); }),
    rmdir: op('rmdir', (p) => { fs.rmdirSync(real(p)); }),
    unlink: op('unlink', (p) => { fs.unlinkSync(real(p)); }),
    ext_openssh_rename: op('ext_openssh_rename', (a, b) => { fs.renameSync(real(a), real(b)); }),
  };
  f.connect = async (cfg, { onLost }) => {
    f.connects += 1;
    f.lastConfig = cfg;
    const failure = f.failing.get('connect');
    if (failure) { f.failing.delete('connect'); throw failure; }
    f.onLost = onLost;
    return { sftp, close: () => { f.closes += 1; } };
  };
  f.lose = () => f.onLost?.(new Error('connection lost'));
  f.failNext = (name, e = new Error('No response from server')) => { f.failing.set(name, e); };
  return f;
}
```

- [ ] **Step 2: Write the failing tests**

`extension/tests/sync-store-sftp.test.mjs`:

```js
// The SFTP adapter runs the SyncStore contract on a fake SFTP session over a temp folder (tests/helpers/fake-sftp.mjs):
// no network in CI. A live run against a real server is opt-in and manual, against a throwaway folder only:
//   LLMIDE_SYNC_SFTP_IT=llmidesync@host:22 LLMIDE_SYNC_SFTP_IT_FP=SHA256:... LLMIDE_SYNC_SFTP_IT_KEY=/path/to/openssh_key \
//   [LLMIDE_SYNC_SFTP_IT_ROOT=/data] node --test tests/sync-store-sftp.test.mjs
// It writes and deletes only under <root>/it-<random>/.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSftpStore, hostKeyFingerprint, parseHostFingerprint, validateSftpConfig } from '../connectors/sync-store/sftp.mjs';
import { MAX_FILE_BYTES } from '../connectors/sync-store/index.mjs';
import { createFakeSftp } from './helpers/fake-sftp.mjs';
import { runSyncStoreContract } from './helpers/sync-store-contract.mjs';

const FP = 'SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM';
const CFG = { host: 'sync.example.com', port: 22, username: 'llmidesync', hostFingerprint: FP, webHost: 'llm-ide.com', root: '/data' };
const SECRETS = { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n' };
const make = (fake = createFakeSftp()) => ({ fake, store: createSftpStore(CFG, SECRETS, { connect: fake.connect }) });
const code = (c) => (e) => { assert.equal(e.code, c); return true; };
const onDisk = (fake, p) => path.join(fake.root, 'data', p);

runSyncStoreContract(test, assert, async () => make().store, 'sftp (fake SFTP)');

test('fingerprints match ssh-keygen; pasted lines parse; config is validated field by field', () => {
  // Vector made with `ssh-keygen -t ed25519` + `ssh-keygen -lf` (OpenSSH), independent of this code.
  const blob = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIGUNOIRsIwfOOUYhJwIlBFBb0cxkQq1Ete227Z9GE+lv', 'base64');
  assert.equal(hostKeyFingerprint(blob), FP);
  assert.equal(parseHostFingerprint(`256 ${FP} root@vps (ED25519)`), FP);
  assert.equal(parseHostFingerprint(`${FP}=`), FP);
  assert.equal(parseHostFingerprint('MD5:12:34'), null);
  assert.equal(parseHostFingerprint('SHA256:short'), null);
  assert.equal(validateSftpConfig(CFG), null);
  assert.equal(validateSftpConfig({ ...CFG, host: '72.62.76.92' }), null);
  for (const [k, v] of [['host', 'bad host'], ['host', ''], ['port', 0], ['port', '22'], ['username', 'Root'], ['hostFingerprint', 'SHA256:x'],
    ['webHost', 'LLM-IDE.com'], ['webHost', 'localhost'], ['webHost', 'llm-ide.com:8443'], ['root', '/data/../etc'], ['root', 'data']]) {
    assert.equal(validateSftpConfig({ ...CFG, [k]: v }), k, `${k}=${v}`);
  }
});

test('describe names the device host and the account, never the key', () => {
  const { store } = make();
  assert.deepEqual(store.describe(), { kind: 'sftp', root: 'llm-ide.com', account: 'llmidesync@sync.example.com:22' });
  assert.ok(!JSON.stringify(store.describe()).includes('PRIVATE'));
});

test('put writes a hidden temp file and renames it over the target; list never shows temp files', async () => {
  const { fake, store } = make();
  await store.put('a/manifest.bin', Buffer.from('old'));
  fake.calls.length = 0;
  await store.put('a/manifest.bin', Buffer.from('new'));
  assert.deepEqual(fake.calls, ['writeFile', 'ext_openssh_rename'], 'an existing folder costs no mkdir');
  assert.equal(fs.readFileSync(onDisk(fake, 'a/manifest.bin'), 'utf8'), 'new');
  fs.writeFileSync(onDisk(fake, 'a/.manifest.bin.0123456789ab.part'), 'half');
  assert.deepEqual((await store.list('a')).map((e) => e.name), ['manifest.bin']);
  assert.equal(fake.lastConfig.privateKey, SECRETS.privateKey);
  assert.equal(fake.lastConfig.hostFingerprint, FP);
});

test('a failed rename removes its temp file and is SYNC_IO', async () => {
  const { fake, store } = make();
  await store.put('a/x.bin', Buffer.from('1'));
  fake.failNext('ext_openssh_rename', Object.assign(new Error('Failure'), { code: 4 }));
  await assert.rejects(store.put('a/x.bin', Buffer.from('2')), code('SYNC_IO'));
  assert.deepEqual(fs.readdirSync(onDisk(fake, 'a')), ['x.bin']);
  assert.equal(fs.readFileSync(onDisk(fake, 'a/x.bin'), 'utf8'), '1');
});

test('a file over the cap is refused on read', async () => {
  const { fake, store } = make();
  fs.mkdirSync(onDisk(fake, 'b'));
  fs.writeFileSync(onDisk(fake, 'b/big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
  await assert.rejects(store.get('b/big.bin'), code('SYNC_TOO_LARGE'));
});

test('removeTree deletes a symlink, never what it points to', async () => {
  const { fake, store } = make();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
  await store.put('t/d/k.bin', Buffer.from('k'));
  fs.symlinkSync(outside, onDisk(fake, 't/d/link'));
  await store.removeTree('t');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  assert.ok(!fs.existsSync(onDisk(fake, 't')));
});

test('ensureDir creates every level once and is idempotent', async () => {
  const { fake, store } = make();
  await store.ensureDir('s/e/slot');
  await store.ensureDir('s/e/slot');
  assert.ok(fs.statSync(onDisk(fake, 's/e/slot')).isDirectory());
  await assert.rejects(store.ensureDir('s/../x'), code('SYNC_BAD_PATH'));
});

test('one connection serves every operation; a lost one is replaced once; close ends it', async () => {
  const { fake, store } = make();
  await store.put('c/x.bin', Buffer.from('1'));
  await store.get('c/x.bin');
  await store.list('c');
  assert.equal(fake.connects, 1);
  fake.failNext('stat');
  assert.equal(Buffer.from(await store.get('c/x.bin')).toString(), '1', 'retried on a fresh connection');
  assert.equal(fake.connects, 2);
  fake.lose();
  await store.list('c');
  assert.equal(fake.connects, 3);
  await store.close();
  assert.ok(fake.closes >= 1);
});

test('connection refusals surface as codes and are not retried', async () => {
  const { fake, store } = make();
  fake.failNext('connect', Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_CHANGED' }));
  await assert.rejects(store.get('a.bin'), code('SYNC_HOST_KEY_CHANGED'));
  assert.equal(fake.connects, 1);
  assert.equal(await store.get('a.bin'), null, 'the next operation connects again');
});

const IT = process.env.LLMIDE_SYNC_SFTP_IT;
if (IT) {
  const m = /^([a-z_][a-z0-9_-]*)@([^:@\s]+):(\d+)$/.exec(IT);
  if (!m) throw new Error('LLMIDE_SYNC_SFTP_IT must be user@host:port');
  const live = createSftpStore({ host: m[2], port: Number(m[3]), username: m[1], hostFingerprint: process.env.LLMIDE_SYNC_SFTP_IT_FP,
    webHost: 'llm-ide.com', root: process.env.LLMIDE_SYNC_SFTP_IT_ROOT || '/data' }, { privateKey: fs.readFileSync(process.env.LLMIDE_SYNC_SFTP_IT_KEY, 'utf8') });
  const sub = `it-${randomBytes(6).toString('hex')}`;
  const prefixed = Object.fromEntries(['put', 'get', 'list', 'remove', 'removeTree', 'ensureDir'].map((k) => [k, (p, ...a) => live[k](`${sub}/${p}`, ...a)]));
  runSyncStoreContract(test, assert, async () => prefixed, 'sftp (live, opt-in)');
  after(async () => { await live.removeTree(sub).catch(() => {}); await live.close(); });
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd extension && node --test tests/sync-store-sftp.test.mjs`
Expected: FAIL with `createSftpStore is not a function` / `does not provide an export named 'createSftpStore'`.

- [ ] **Step 4: Append the store to `sftp.mjs`**

Change the import line at the top to:

```js
import { createHash, randomBytes } from 'node:crypto';
import { checkPath, checkSize, MAX_FILE_BYTES } from './index.mjs';
```

Add to the header comment, after the first paragraph:

```js
// One connection per store, reused; operations run one at a time; a connection lost mid-operation is replaced once.
// put writes a hidden temp file next to the target and renames it over the target with posix-rename@openssh.com, so a
// reader (the desktop or nginx) sees the old bytes or the new, never a mix. removeTree unlinks symlinks, never follows.
```

Append:

```js
const NO_SUCH_FILE = 2; // SFTP status codes, which ssh2 puts on err.code
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const call = (fn) => new Promise((resolve, reject) => { fn((e, v) => (e ? reject(e) : resolve(v))); });
const absent = (e) => e?.code === NO_SUCH_FILE;
const asCoded = (e) => (String(e?.code ?? '').startsWith('SYNC_') ? e : coded(classifySftpError(e)));

export function createSftpStore(config, secrets, { connect = connectSftp } = {}) {
  const root = config?.root || DEFAULT_SFTP_ROOT;
  const target = { host: config.host, port: config.port ?? 22, username: config.username || DEFAULT_SFTP_USER, hostFingerprint: config.hostFingerprint };
  const full = (segs) => [root, ...segs].join('/');
  let session = null; // Promise<{ sftp, close }> for the one live connection
  let chain = Promise.resolve();

  function conn() {
    if (!session) {
      const p = connect({ ...target, privateKey: secrets.privateKey }, { onLost: () => {
        if (session !== p) return;
        session = null;
        p.then((s) => s.close(), () => {});
      } });
      p.catch(() => { if (session === p) session = null; });
      session = p;
    }
    return session;
  }
  function drop() {
    const old = session;
    session = null;
    old?.then((s) => s.close(), () => {}).catch(() => {});
  }
  async function attempt(fn) {
    for (let retried = false; ; retried = true) {
      let s;
      try { s = await conn(); } catch (e) { drop(); throw asCoded(e); }
      try { return await fn(s.sftp); } catch (e) {
        if (!retried && classifySftpError(e) === 'SYNC_UNREACHABLE') { drop(); continue; }
        throw asCoded(e);
      }
    }
  }
  const serial = (fn) => { const run = chain.then(() => attempt(fn)); chain = run.catch(() => {}); return run; };

  async function mkdirp(sftp, segs) {
    let dir = root;
    for (const name of segs) {
      dir = `${dir}/${name}`;
      try { await call((cb) => sftp.mkdir(dir, { mode: 0o770 }, cb)); } catch (e) {
        const st = await call((cb) => sftp.stat(dir, cb)).catch(() => null);
        if (!st?.isDirectory()) throw e;
      }
    }
  }
  async function rmTree(sftp, dir) {
    let entries;
    try { entries = await call((cb) => sftp.readdir(dir, cb)); } catch (e) { if (absent(e)) return; throw e; }
    for (const x of entries) {
      if (x.filename === '.' || x.filename === '..') continue;
      const child = `${dir}/${x.filename}`;
      if ((x.attrs.mode & S_IFMT) === S_IFDIR) await rmTree(sftp, child);
      else await call((cb) => sftp.unlink(child, cb)).catch((e) => { if (!absent(e)) throw e; });
    }
    await call((cb) => sftp.rmdir(dir, cb)).catch((e) => { if (!absent(e)) throw e; });
  }

  return {
    async put(path, bytes) {
      const segs = checkPath(path); checkSize(bytes);
      const data = Buffer.from(bytes);
      await serial(async (sftp) => {
        const dir = full(segs.slice(0, -1));
        const dest = `${dir}/${segs.at(-1)}`;
        const tmp = `${dir}/.${segs.at(-1)}.${randomBytes(6).toString('hex')}.part`;
        const write = () => call((cb) => sftp.writeFile(tmp, data, { mode: 0o660 }, cb));
        try { await write(); } catch (e) { if (!absent(e)) throw e; await mkdirp(sftp, segs.slice(0, -1)); await write(); }
        try { await call((cb) => sftp.ext_openssh_rename(tmp, dest, cb)); } catch (e) {
          await call((cb) => sftp.unlink(tmp, cb)).catch(() => {});
          throw e;
        }
      });
    },
    async get(path) {
      const segs = checkPath(path);
      return serial(async (sftp) => {
        let st;
        try { st = await call((cb) => sftp.stat(full(segs), cb)); } catch (e) { if (absent(e)) return null; throw e; }
        if (!st.isFile()) return null;
        if (st.size > MAX_FILE_BYTES) throw coded('SYNC_TOO_LARGE');
        let buf;
        try { buf = await call((cb) => sftp.readFile(full(segs), cb)); } catch (e) { if (absent(e)) return null; throw e; }
        if (buf.length > MAX_FILE_BYTES) throw coded('SYNC_TOO_LARGE');
        return buf;
      });
    },
    async list(dir) {
      const segs = checkPath(dir);
      return serial(async (sftp) => {
        let entries;
        try { entries = await call((cb) => sftp.readdir(full(segs), cb)); } catch (e) { if (absent(e)) return []; throw e; }
        return entries.filter((x) => !x.filename.startsWith('.') && (x.attrs.mode & S_IFMT) === S_IFREG)
          .map((x) => ({ name: x.filename, size: x.attrs.size ?? 0, mtimeMs: (x.attrs.mtime ?? 0) * 1000 }));
      });
    },
    async remove(path) {
      const segs = checkPath(path);
      await serial((sftp) => call((cb) => sftp.unlink(full(segs), cb)).catch((e) => { if (!absent(e)) throw e; }));
    },
    async removeTree(dir) {
      const segs = checkPath(dir);
      await serial((sftp) => rmTree(sftp, full(segs)));
    },
    /** Own server only: nginx never creates folders, so the desktop makes the ones a device writes into (design 8.1). */
    async ensureDir(dir) {
      const segs = checkPath(dir);
      await serial((sftp) => mkdirp(sftp, segs));
    },
    describe() { return { kind: 'sftp', root: config.webHost, account: `${target.username}@${target.host}:${target.port}` }; },
    async close() {
      const old = session;
      session = null;
      if (old) await old.then((s) => s.close(), () => {}).catch(() => {});
    },
  };
}
```

In `extension/connectors/sync-store/index.mjs`, change the `withTimeouts` method list to:

```js
  for (const k of ['put', 'get', 'list', 'remove', 'removeTree', 'ensureDir']) if (typeof store[k] === 'function') out[k] = wrap(store[k].bind(store));
```

and extend the file's first comment line with: ` Optional ensureDir(dir) (own server only) creates the folders a device will write into.`

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd extension && node --test tests/sync-store-sftp.test.mjs tests/sync-store-memory.test.mjs tests/sync-store-mega.test.mjs tests/sync-registry.test.mjs`
Expected: PASS (the live block is skipped without `LLMIDE_SYNC_SFTP_IT`).

- [ ] **Step 6: Commit**

```bash
git add extension/connectors/sync-store/sftp.mjs extension/connectors/sync-store/index.mjs extension/tests/helpers/fake-sftp.mjs extension/tests/sync-store-sftp.test.mjs
git commit -m "feat(sync): SFTP SyncStore with atomic replace and ensureDir

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the adapter into the scheduler, vault, enrollment and producer

**Files:**
- Modify: `extension/server/vault.mjs` (allowed + internal key `sync.sshKey`)
- Modify: `extension/routes/sync/scheduler.mjs` (`storeFor`, `SETUP_ERRORS`, header comment)
- Modify: `extension/routes/sync/enroll.mjs` (`startOne`: slot folder)
- Modify: `extension/routes/sync/producer.mjs` (`writeDeviceWrap`: `in/` folder)
- Modify: `extension/core/sync-enroll.mjs` (`ST_RE`), `schema/sync/v1/README.md` (`st`)
- Test: `extension/tests/sync-routes.test.mjs`, `extension/tests/sync-enroll.test.mjs`

**Interfaces:**
- Consumes: `createSftpStore`, `WEB_HOST_RE` from Task 2.
- Produces: `storeFor(userId)` returns a `withTimeouts`-wrapped SFTP store when `storeKind === 'sftp'` and `sync.sshKey` is in the vault, and null otherwise. `recordCycleFailure` turns sync off on `SYNC_HOST_KEY_CHANGED`. Pair URLs carry `st=sftp:<webHost>`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/sync-routes.test.mjs`:

```js
test('a changed server host key turns sync off instead of retrying', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'sftp', storeConfig: { host: 'sync.example.com', port: 22, username: 'llmidesync', hostFingerprint: `SHA256:${'A'.repeat(43)}`, webHost: 'llm-ide.com', root: '/data' } });
  st.setSyncEnabled(u, true);
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_CHANGED' }), { now: 1, backoff: new Map() });
  assert.equal(st.getSyncState(u).enabled, false);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_HOST_KEY_CHANGED');
});

test('the SSH key is a server-internal vault secret', () => {
  assert.equal(vault.isUserSettableVaultKey('sync.sshKey'), false);
  assert.ok(!vault.VAULT_KEYS.includes('sync.sshKey'));
});
```

Append to `extension/tests/sync-enroll.test.mjs`:

```js
test('own server: the QR names sftp:<webHost>, and the slot and inbox folders exist before the device writes', async () => {
  const { createSftpStore } = await import('../connectors/sync-store/sftp.mjs');
  const { createFakeSftp } = await import('./helpers/fake-sftp.mjs');
  const u = user();
  const cfg = { host: 'sync.example.com', port: 22, username: 'llmidesync', hostFingerprint: `SHA256:${'A'.repeat(43)}`, webHost: 'llm-ide.com', root: '/data' };
  st.ensureSyncState(u, { storeKind: 'sftp', storeConfig: cfg });
  st.setSyncEnabled(u, true);
  const fake = createFakeSftp();
  const store = createSftpStore(cfg, { privateKey: 'k' }, { connect: fake.connect });
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  assert.equal(pair.st, 'sftp:llm-ide.com');
  assert.ok(fs.statSync(path.join(fake.root, 'data', pair.sid, 'e', pair.slot)).isDirectory(), 'slot folder made by the desktop');
  const dev = createReferenceDevice({ tier: 'ios', name: 'Own server phone' });
  await dev.scanAndClaim(store, qr, { now: T + 600 });
  await pollEnrollment(u, { now: T + 1000 });
  await confirmEnrollment(u, { now: T + 2000 });
  assert.ok(fs.statSync(path.join(fake.root, 'data', pair.sid, 'd', pair.dir, 'in')).isDirectory(), 'inbox made with key.bin');
});

test('st accepts only lower-case DNS names for the own server', () => {
  const base = { sid: 'A'.repeat(22), sfp: 'B'.repeat(43), dir: 'C'.repeat(22), slot: 'D'.repeat(22), es: 'E'.repeat(22) };
  for (const st of ['sftp:llm-ide.com', 'sftp:sync.example.org']) assert.equal(E.parsePair(E.pairUrl({ ...base, st }, 'ios', 'https://llm-ide.com')).st, st);
  for (const st of ['sftp:LLM-IDE.com', 'sftp:localhost', 'sftp:72.62.76.92', 'sftp:llm-ide.com:8443', 'sftp:']) {
    assert.throws(() => E.parsePair(E.pairUrl({ ...base, st }, 'ios', 'https://llm-ide.com')), (e) => e.code === 'bad_pair', st);
  }
});
```

(`E.pairUrl` only formats the fields and does not validate them, so `parsePair` is what refuses.)

- [ ] **Step 2: Run them to see them fail**

Run: `cd extension && node --test tests/sync-routes.test.mjs tests/sync-enroll.test.mjs`
Expected: FAIL. `enabled` stays `true` for `SYNC_HOST_KEY_CHANGED`; `ensureAllowed` throws for `sync.sshKey`; `bad_pair` for `sftp:llm-ide.com`; the slot folder is missing.

- [ ] **Step 3: Implement**

`extension/server/vault.mjs`: after `'sync.megaPassword',` in the allowed list, add `'sync.sshKey',`, and extend the comment above it with `, and the own-server adapter's OpenSSH ed25519 private key (sync.sshKey)`. In `INTERNAL_KEYS` add `'sync.sshKey'`:

```js
const INTERNAL_KEYS = new Set(['email.imapPasswordHost', 'sync.rootKey', 'sync.signingKey', 'sync.megaEmail', 'sync.megaPassword', 'sync.sshKey', 'sync.prevRootKey']);
```

`extension/routes/sync/scheduler.mjs`: replace the header's last two sentences ("One MEGA store … starts nothing.") with:

```js
// SYNC_MFA_REQUIRED) or a changed server host key (SYNC_HOST_KEY_CHANGED) turns sync off instead of retrying, so a changed
// password never locks the MEGA account and a swapped server is never written to. One store (one MEGA session or one
// SSH connection) per user is cached while the core runs. LLMIDE_SYNC=off starts nothing.
```

(adjust the sentence before it so the comment reads as one paragraph), add the import `import { createSftpStore } from '../../connectors/sync-store/sftp.mjs';`, set

```js
const SETUP_ERRORS = new Set(['SYNC_AUTH_FAILED', 'SYNC_MFA_REQUIRED', 'SYNC_HOST_KEY_CHANGED']);
```

and replace `storeFor` with:

```js
export function storeFor(userId) {
  const cached = stores.get(userId);
  if (cached) return cached;
  const state = getSyncState(userId);
  const raw = state && openStore(userId, state);
  if (!raw) return null;
  const store = withTimeouts(raw);
  stores.set(userId, store);
  return store;
}

function openStore(userId, state) {
  const db = getDb();
  if (state.storeKind === 'mega') {
    const email = getSecret(db, userId, 'sync.megaEmail');
    const password = getSecret(db, userId, 'sync.megaPassword');
    return email && password ? createMegaStore(state.storeConfig, { email, password }) : null;
  }
  if (state.storeKind === 'sftp') {
    const privateKey = getSecret(db, userId, 'sync.sshKey');
    return privateKey ? createSftpStore(state.storeConfig, { privateKey }) : null;
  }
  return null;
}
```

`extension/routes/sync/enroll.mjs`, in `startOne`, replace the `key.bin` line with:

```js
  try {
    await store.put(`${pair.sid}/d/${pair.dir}/key.bin`, keys.signingSpki);
    await store.ensureDir?.(slotDir(p)); // own server: nginx never creates the folder the claim goes into
  } catch (e) { await kill(p, 'store'); throw e; }
```

`extension/routes/sync/producer.mjs`, in `writeDeviceWrap`, right after `await store.put(`${base}/key.bin`, keys.signingSpki);`:

```js
  await store.ensureDir?.(`${base}/in`); // own server: the device's inbox must exist before it can PUT a request
```

`extension/core/sync-enroll.mjs`:

```js
const ST_RE = /^(mega:[A-Za-z0-9_.-]{1,64}|sftp:(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|memory:)$/; // sftp: = own server's HTTPS host; memory: is the test adapter only
```

`schema/sync/v1/README.md`, in the QR payload bullet, replace "`st` is `mega:<folder>` (`[A-Za-z0-9_.-]{1,64}`) or `memory:` for tests." with:

"`st` is `mega:<folder>` (`[A-Za-z0-9_.-]{1,64}`), `sftp:<host>` for the user's own server (`<host>` is a lower-case DNS name, `^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`; the device reads and writes `https://<host>/sync/<path>` with plain GET and PUT, no login, and never creates a folder), or `memory:` for tests."

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd extension && node --test tests/sync-routes.test.mjs tests/sync-enroll.test.mjs tests/sync-enroll-crypto.test.mjs tests/sync-producer.test.mjs tests/sync-registry.test.mjs tests/sync-sftp-lazy.test.mjs && node scripts/sync-vectors.mjs`
Expected: PASS (the vectors still use `mega:llmide-sync` and are unchanged; the script must report no difference).

- [ ] **Step 5: Commit**

```bash
git add extension/server/vault.mjs extension/routes/sync/scheduler.mjs extension/routes/sync/enroll.mjs extension/routes/sync/producer.mjs extension/core/sync-enroll.mjs schema/sync/v1/README.md extension/tests/sync-routes.test.mjs extension/tests/sync-enroll.test.mjs
git commit -m "feat(sync): run the scheduler and enrollment on the own-server store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /kb/sync/sftp`, sftp status, and the storage-kind switch

**Files:**
- Modify: `extension/routes/sync/http-routes.mjs`
- Modify: `extension/server.mjs` (version comment + `SERVER_API_VERSION = 114` + `ALL_ENDPOINTS`)
- Modify: `schema/http/sync.schema.json`; Create: `schema/http/fixtures/sync/post-kb-sync-sftp-200.json`
- Regenerate: `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md`
- Modify: `extension/CLAUDE.md` (Sync section)
- Test: `extension/tests/sync-routes.test.mjs`

**Interfaces:**
- Consumes: `generateSyncSshKey`, `parseHostFingerprint`, `validateSftpConfig`, `DEFAULT_SFTP_USER`, `DEFAULT_SFTP_ROOT`, `DEFAULT_WEB_HOST` (Task 1); `withUserLock`, `dropStore` (scheduler); `cancelEnrollment` (enroll); `listSyncDevices`, `deleteSyncDevice`, `resetSyncPublish` (sync-state).
- Produces: `POST /kb/sync/sftp` with body `{ host, port?, username?, hostFingerprint, webHost? }` returns `EncryptedSyncStatus`. For `storeKind === 'sftp'`, `status.store` is `{ host, port, username, hostFingerprint, webHost, publicKey }`. Errors: 400 `VALIDATION_FAILED { field }`, 409 `SYNC_BUSY`. Saving either kind while the other is configured runs the kind switch.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/sync-routes.test.mjs`:

```js
const SFTP = { host: 'sync.example.com', hostFingerprint: '256 SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM root@vps (ED25519)' };

test('own-server setup validates, generates the SSH key once, keeps it in the vault only, and shows the public line', async () => {
  const u = user();
  const bad = await call('POST', '/kb/sync/sftp', { userId: u, body: { ...SFTP, hostFingerprint: 'MD5:aa' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.field, 'hostFingerprint');
  assert.equal((await call('POST', '/kb/sync/sftp', { userId: u, body: { ...SFTP, webHost: 'localhost' } })).body.error.details.field, 'webHost');
  const a = await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
  assert.equal(a.status, 200);
  assert.equal(a.body.storeKind, 'sftp');
  const { publicKey, ...rest } = a.body.store;
  assert.deepEqual(rest, { host: 'sync.example.com', port: 22, username: 'llmidesync', hostFingerprint: 'SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM', webHost: 'llm-ide.com' });
  assert.match(publicKey, new RegExp(`^ssh-ed25519 [A-Za-z0-9+/=]+ llmide-sync-${a.body.syncId}$`));
  const priv = vault.getSecret(kb.getDb(), u, 'sync.sshKey');
  assert.match(priv, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.ok(!JSON.stringify(a.body).includes('PRIVATE KEY'));
  const again = await call('POST', '/kb/sync/sftp', { userId: u, body: { ...SFTP, port: 2222 } });
  assert.equal(again.body.store.publicKey, publicKey, 'saving again keeps the key the server already trusts');
  assert.equal(again.body.store.port, 2222);
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.sshKey'), priv);
});

test('switching storage kind unlinks devices, forgets the old login and resets publish state', async () => {
  const u = user();
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  st.addSyncDevice(u, { deviceId: 'sw-device-1', dir: 'F'.repeat(22), tier: 'web', name: 'Phone', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  st.setPublished(u, 'sw-device-1', 'chats', { file: 's/' + 'b'.repeat(32) + '.bin', seq: 1, fileSha256: 'f', plainSha256: 'p', epoch: 1 });
  const s = await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.devices, []);
  assert.deepEqual(st.getPublished(u, 'sw-device-1'), {});
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.megaPassword'), null);
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.megaEmail'), null);
  const m = await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  assert.equal(m.body.storeKind, 'mega');
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.sshKey'), null, 'the SSH key goes with the own-server setup');
});

test('setup refuses while a sync cycle holds the lock', async () => {
  const u = user();
  await withUserLock(u, async () => {
    const r = await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'SYNC_BUSY');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd extension && node --test tests/sync-routes.test.mjs`
Expected: FAIL with `404 NOT_FOUND` for `/kb/sync/sftp`.

- [ ] **Step 3: Implement the route**

`extension/routes/sync/http-routes.mjs`:

Header: change the first comment line to
`// /kb/sync/* for the desktop Settings card: JWT + bus host proof (desktop UI only), per user. Never returns the MEGA`
`// password, the full MEGA email, the SSH private key, the root key or a folder capability; errors carry codes, never secrets.`

Imports, replace the sync-state import and add the sftp import:

```js
import { getSyncState, ensureSyncState, setSyncEnabled, listSyncDevices, resetSyncPublish, deleteSyncDevice } from '../../kb/sync-state.mjs';
import { DEFAULT_SFTP_ROOT, DEFAULT_SFTP_USER, DEFAULT_WEB_HOST, generateSyncSshKey, parseHostFingerprint, validateSftpConfig } from '../../connectors/sync-store/sftp.mjs';
```

After `fail`, add:

```js
const sftpView = (c) => ({ host: c.host, port: c.port, username: c.username, hostFingerprint: c.hostFingerprint, webHost: c.webHost, publicKey: c.publicKey });

/** Another storage kind is a place linked devices cannot follow (their pairing named the old one): drop a pending
 *  enrollment, unlink every device (they pair again), forget the old storage's login, and reset the publish records
 *  (the SP1 store-change reset). The old storage's files stay; Settings tells the user to delete them. Caller holds the
 *  user lock. */
async function leaveStoreKind(userId) {
  const db = getDb();
  void cancelEnrollment(userId).catch(() => {});
  await dropStore(userId);
  for (const d of listSyncDevices(userId)) deleteSyncDevice(userId, d.deviceId);
  for (const k of ['sync.megaEmail', 'sync.megaPassword', 'sync.sshKey']) setSecret(db, userId, k, '');
  resetSyncPublish(userId);
}
```

In `status()`, replace the `store:` line with:

```js
    store: s.storeKind === 'mega' ? { folder: s.storeConfig.folder ?? DEFAULT_MEGA_FOLDER, account: maskEmail(getSecret(getDb(), userId, 'sync.megaEmail')) }
      : s.storeKind === 'sftp' ? sftpView(s.storeConfig) : null,
```

Replace the body of the `/kb/sync/mega` block from `const db = getDb();` to `await dropStore(userId);` with:

```js
      const db = getDb();
      const before = getSyncState(userId);
      const oldEmail = getSecret(db, userId, 'sync.megaEmail');
      const changed = !!before && (before.storeKind !== 'mega' || before.storeConfig.folder !== cfg.folder || oldEmail !== cfg.email);
      await withUserLock(userId, async () => {
        if (before && before.storeKind !== 'mega') await leaveStoreKind(userId);
        setSecret(db, userId, 'sync.megaEmail', cfg.email);
        setSecret(db, userId, 'sync.megaPassword', cfg.password);
        ensureSyncState(userId, { storeKind: 'mega', storeConfig: { folder: cfg.folder } });
        if (changed) resetSyncPublish(userId);
        await dropStore(userId);
      });
```

After the `/kb/sync/mega` block, add:

```js
    if (req.method === 'POST' && path === '/kb/sync/sftp') {
      const b = await readJson(req, 4096);
      const cfg = {
        host: String(b.host ?? '').trim(), port: b.port ?? 22, username: String(b.username ?? '').trim() || DEFAULT_SFTP_USER,
        hostFingerprint: parseHostFingerprint(b.hostFingerprint) ?? '', webHost: String(b.webHost ?? '').trim().toLowerCase() || DEFAULT_WEB_HOST,
        root: DEFAULT_SFTP_ROOT,
      };
      const field = validateSftpConfig(cfg);
      if (field) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${field}`, { field });
      const db = getDb();
      await withUserLock(userId, async () => {
        const before = getSyncState(userId);
        if (before && before.storeKind !== 'sftp') await leaveStoreKind(userId);
        const keep = before?.storeKind === 'sftp' && before.storeConfig.publicKey && getSecret(db, userId, 'sync.sshKey') ? before.storeConfig.publicKey : null;
        const moved = before?.storeKind === 'sftp' && ['host', 'port', 'username', 'root'].some((k) => before.storeConfig[k] !== cfg[k]);
        const state = ensureSyncState(userId, { storeKind: 'sftp', storeConfig: { ...cfg, publicKey: keep } });
        if (!keep) {
          const key = await generateSyncSshKey(`llmide-sync-${state.syncId}`);
          setSecret(db, userId, 'sync.sshKey', key.privateKey);
          ensureSyncState(userId, { storeKind: 'sftp', storeConfig: { ...cfg, publicKey: key.publicKey } });
        }
        if (moved) resetSyncPublish(userId); // another server: fresh key/wrap files there (SP1 store-change reset)
        await dropStore(userId);
      });
      send(res, 200, status(userId)); return true;
    }
```

In the outer `catch (e)` at the end of `handleSyncRoute`, before the existing `return fail(…)`, add:

```js
    if (e?.code === 'SYNC_BUSY') return fail(res, 409, 'SYNC_BUSY', 'Sync is busy, try again');
```

- [ ] **Step 4: Register the endpoint and the contract**

`extension/server.mjs`: add above the `v113` comment line:

```js
//   v114 — own-server sync (SP5), additive: POST /kb/sync/sftp { host, port?, username?, hostFingerprint, webHost? } -> status; for storeKind 'sftp' status.store = { host, port, username, hostFingerprint, webHost, publicKey } (the desktop's ed25519 public line; the private key never leaves the vault). New 502 code SYNC_HOST_KEY_CHANGED (sync turns off); 409 SYNC_BUSY from either setup route. Saving another storage kind than the configured one unlinks every device. JWT + bus host proof; 'kbWrite' bucket.
```

Set `const SERVER_API_VERSION = 114;` and add `'/kb/sync/sftp',` after `'/kb/sync/mega',` in `ALL_ENDPOINTS`.

`schema/http/sync.schema.json`:
- In the top-level `description`, change "No route returns the MEGA password or full email, a private key" to "No route returns the MEGA password or full email, the SSH private key, any other private key", add `SYNC_HOST_KEY_CHANGED|` after `502 SYNC_AUTH_FAILED|`, and add `409 SYNC_BUSY (setup during a sync cycle)`.
- `storeKind.description` becomes `"mega | sftp | memory (box in a later sub-project)"`.
- In `store.properties`, add `host` (string), `port` (integer), `username` (string), `hostFingerprint` (string, "SHA256:<43 base64>"), `webHost` (string, "HTTPS host devices use"), `publicKey` (string, "ssh-ed25519 public line for authorized_keys"). Set `store.description` to `"mega: { folder, account }, account = masked email; sftp: { host, port, username, hostFingerprint, webHost, publicKey }"`.
- Add the endpoint after `POST /kb/sync/mega`:

```json
    "POST /kb/sync/sftp": {
      "request": {
        "body": {
          "type": "object",
          "required": ["host", "hostFingerprint"],
          "properties": {
            "host": { "type": "string" },
            "port": { "type": "integer" },
            "username": { "type": "string" },
            "hostFingerprint": { "type": "string", "description": "SHA256:<43 base64>, or a pasted ssh-keygen -lf line" },
            "webHost": { "type": "string" }
          }
        }
      },
      "responses": { "200": { "$ref": "#/$defs/EncryptedSyncStatus" } }
    },
```

(Match the file's existing one-key-per-line formatting.)

`schema/http/fixtures/sync/post-kb-sync-sftp-200.json`: copy `post-kb-sync-mega-200.json` and change `endpoint` to `"POST /kb/sync/sftp"`, set `storeKind` to `"sftp"`, `devices` to `[]`, `store` to

```json
    "store": {
      "host": "sync.example.com",
      "port": 22,
      "username": "llmidesync",
      "hostFingerprint": "SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM",
      "webHost": "llm-ide.com",
      "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGUNOIRsIwfOOUYhJwIlBFBb0cxkQq1Ete227Z9GE+lv llmide-sync-AAAAAAAAAAAAAAAAAAAAAA"
    },
```

and `request.body` to `{ "host": "sync.example.com", "hostFingerprint": "SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM" }`.

Regenerate and check:

```bash
node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs
make contract-gates
```

Expected: the three generators rewrite their outputs, and `contract-gates` passes.

`extension/CLAUDE.md`, "Sync (desktop producer)" section:
- In **Where**, replace "(memory for tests; MEGA via `megajs` 1.3.10, the first adapter by user decision; SFTP and Box are later sub-projects)" with "(memory for tests; MEGA via `megajs` 1.3.10, the first adapter by user decision; own server via `ssh2` 1.17.0 over SFTP, SP5; Box is a later sub-project)".
- In **Vault**, add `sync.sshKey` to the list.
- Add a bullet after **MEGA**:

  `- **Own server (SFTP)**: \`connectors/sync-store/sftp.mjs\`; key generated by the desktop (\`POST /kb/sync/sftp\`), host key pinned from the pasted \`SHA256:\` fingerprint (never TOFU; mismatch \`SYNC_HOST_KEY_CHANGED\` turns sync off); \`ssh2\` is imported on first connect or key generation only (\`tests/sync-sftp-lazy.test.mjs\`). Devices use \`https://<webHost>/sync/<path>\` (nginx, \`deploy/vps/sync-sftp.md\`), which never creates folders, so the desktop makes \`e/<slot>/\` and \`d/<dir>/in/\` (\`ensureDir\`). Switching storage kind unlinks every device. Tests: \`tests/helpers/fake-sftp.mjs\`, \`tests/sync-own-server.test.mjs\` (nginx emulator); live run opt-in (\`LLMIDE_SYNC_SFTP_IT=user@host:port\`).`
- In **Never**, add "the SSH private key" to the list.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd extension && node --test tests/sync-routes.test.mjs tests/sync-sftp-lazy.test.mjs tests/lazy-engine.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/routes/sync/http-routes.mjs extension/server.mjs schema/http/sync.schema.json schema/http/fixtures/sync/post-kb-sync-sftp-200.json extension/src/lib/api-types.ts docs/reference/api/openapi.yaml schema/http/INVENTORY.md extension/CLAUDE.md extension/tests/sync-routes.test.mjs
git commit -m "feat(server): own-server sync setup route with storage-kind switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: VPS side: nginx locations, sshd block, setup doc, check script, and the CI interop test

**Files:**
- Modify: `deploy/vps/llm-ide.com.nginx`
- Create: `deploy/vps/50-llmidesync.conf`, `deploy/vps/sync-sftp.md`, `deploy/vps/check-sync.sh` (mode 755)
- Modify: `deploy/vps/README.md`
- Create: `extension/tests/helpers/fake-nginx-sync.mjs`, `extension/tests/sync-own-server.test.mjs`

**Interfaces:**
- Consumes: `createSftpStore` (Task 2), `startEnrollment`/`pollEnrollment`/`confirmEnrollment`, `publishOnce`, `drainOnce`, `revokeDevice`, the reference device.
- Produces: `syncLocations(text?)` → `[{ re: RegExp, method: 'GET'|'PUT', body: string }]` and `createFakeNginx(dataDir)` → `{ get, put, log }` (a DeviceStore).

- [ ] **Step 1: Write the failing test**

`extension/tests/helpers/fake-nginx-sync.mjs`:

```js
// The /sync/ locations of deploy/vps/llm-ide.com.nginx, emulated over the directory the SFTP store writes (nginx alias
// /srv/llmide-sync/data/ = <fake sftp root>/data). The location regexes are read from the vhost file itself, first match
// wins as in nginx. GET serves only allow-listed files (absent → null). PUT writes only allow-listed files into folders
// that already exist (create_full_put_path off → 409) and refuses bodies over 64 KiB (413). A request no location
// allows throws NGINX_DENIED, so a test fails loudly where real nginx would answer a quiet 404.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VHOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/vps/llm-ide.com.nginx');
const PUT_MAX = 65536; // client_max_body_size 64k (asserted against the vhost in sync-own-server.test.mjs)
const denied = (method, p) => Object.assign(new Error(`nginx: no ${method} location for /sync/${p}`), { code: 'NGINX_DENIED' });

export const vhostText = () => fs.readFileSync(VHOST, 'utf8');

export function syncLocations(text = vhostText()) {
  return [...text.matchAll(/location ~ "(\^\/sync\/[^"]+)" \{([\s\S]*?)\n    \}/g)]
    .map((m) => ({ re: new RegExp(m[1]), method: /limit_except (GET|PUT) /.exec(m[2])?.[1] ?? null, body: m[2] }));
}

export function createFakeNginx(dataDir, { locations = syncLocations() } = {}) {
  const log = [];
  const route = (p) => locations.find((l) => l.re.test(`/sync/${p}`)) ?? null;
  return {
    log,
    async get(p) {
      const loc = route(p);
      log.push(['GET', p]);
      if (loc?.method !== 'GET') throw denied('GET', p);
      try { return fs.readFileSync(path.join(dataDir, p)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async put(p, bytes) {
      const loc = route(p);
      log.push(['PUT', p]);
      if (loc?.method !== 'PUT') throw denied('PUT', p);
      if (bytes.length > PUT_MAX) throw Object.assign(new Error('nginx 413'), { code: 'SYNC_TOO_LARGE' });
      const file = path.join(dataDir, p);
      if (!fs.existsSync(path.dirname(file))) throw Object.assign(new Error(`nginx 409 /sync/${p}`), { code: 'SYNC_MISSING' });
      fs.writeFileSync(file, bytes);
    },
  };
}
```

`extension/tests/sync-own-server.test.mjs`:

```js
// The own-server path end to end in CI (design 8.1): the desktop writes through the SFTP adapter (fake SFTP over a temp
// folder); the reference device reads and writes only through the vhost's /sync/ locations (emulated over the same
// folder). Every device request must hit an allowed location, and every folder a device writes into must already exist.
// Plus static checks of the sshd and nginx files under deploy/vps/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_sync-own-server-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const E = await import('../core/sync-enroll.mjs');
const { withTimeouts } = await import('../connectors/sync-store/index.mjs');
const { createSftpStore } = await import('../connectors/sync-store/sftp.mjs');
const { publishOnce } = await import('../routes/sync/producer.mjs');
const { drainOnce } = await import('../routes/sync/consumer.mjs');
const { revokeDevice } = await import('../routes/sync/registry.mjs');
const { startEnrollment, pollEnrollment, confirmEnrollment, _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');
const { createFakeSftp } = await import('./helpers/fake-sftp.mjs');
const { createFakeNginx, syncLocations, vhostText } = await import('./helpers/fake-nginx-sync.mjs');

const T = 1_762_400_000_000;
const CFG = { host: 'sync.example.com', port: 22, username: 'llmidesync', hostFingerprint: `SHA256:${'A'.repeat(43)}`, webHost: 'llm-ide.com', root: '/data' };
const kinds = () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k, Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: 1, truncated: false, items: [] }))]));
const turnDeps = { phoneChatId: async () => 'phone-chat', cancel: () => {}, turn: async (args) => { args.onEvent({ type: 'delta', text: 'hi from the desktop' }); args.onEvent({ type: 'result' }); } };
let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `os-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'o' }).id;

async function linked() {
  _resetEnrollmentsForTest();
  const u = user();
  st.ensureSyncState(u, { storeKind: 'sftp', storeConfig: CFG });
  st.setSyncEnabled(u, true);
  const fake = createFakeSftp();
  const store = withTimeouts(createSftpStore(CFG, { privateKey: 'unused by the fake' }, { connect: fake.connect }));
  const web = createFakeNginx(path.join(fake.root, 'data'));
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  assert.equal(E.parsePair(qr).st, 'sftp:llm-ide.com');
  const dev = createReferenceDevice({ tier: 'ios', name: 'Own-server phone' });
  await dev.scanAndClaim(web, qr, { now: T + 600 });
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'confirm');
  assert.equal(await dev.readAck(web), p.sas, 'the ack is readable through nginx');
  await confirmEnrollment(u, { now: T + 2000 });
  assert.equal(await dev.readWrap(web), true);
  return { u, store, web, dev, fake };
}

test('enroll, publish, queued prompt and reply: the device uses only the nginx allow-list', async () => {
  const { u, store, web, dev } = await linked();
  await publishOnce({ userId: u, store, now: T + 3000, loadKinds: kinds });
  const snap = await dev.readSnapshot(web);
  assert.deepEqual(Object.keys(snap.kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
  const id = await dev.sendRequest(web, 'hello from the phone', { now: T + 4000 });
  await drainOnce({ userId: u, store, now: T + 5000, deps: turnDeps });
  const reply = await dev.readReply(web, id);
  assert.equal(reply.ok, true); assert.equal(reply.text, 'hi from the desktop');
  assert.deepEqual([...new Set(web.log.map(([m]) => m))].sort(), ['GET', 'PUT']);
});

test('a revoked device cannot write: its folder is gone and nginx never recreates it', async () => {
  const { u, store, web, dev } = await linked();
  assert.equal(await revokeDevice(u, dev.deviceId, { store }), true);
  await assert.rejects(dev.sendRequest(web, 'still there?', { now: T + 4000 }), (e) => e.code === 'SYNC_MISSING');
});

test('nginx locations: exact allow-list, no listing, logs off, small PUTs, rate limit, exact CORS, no ^~ shadowing', () => {
  const text = vhostText();
  const locs = syncLocations(text);
  assert.deepEqual(locs.map((l) => l.method), ['GET', 'PUT']);
  const [get, put] = locs;
  const sid = 'A'.repeat(22); const dir = 'B'.repeat(22); const id = 'C'.repeat(22); const blob = 'a'.repeat(32);
  for (const f of ['key.bin', 'wrap.bin', 'manifest.bin', `s/${blob}.bin`, `out/${id}.bin`]) assert.ok(get.re.test(`/sync/${sid}/d/${dir}/${f}`), f);
  assert.ok(get.re.test(`/sync/${sid}/e/${id}/ack.bin`), 'the enrollment ack');
  for (const f of [`d/${dir}/`, `d/${dir}/in/0000000000001-${id}.bin`, `e/${id}/${id}.bin`, `d/${dir}/../key.bin`, `d/${dir}/key.binx`]) assert.ok(!get.re.test(`/sync/${sid}/${f}`), f);
  assert.ok(put.re.test(`/sync/${sid}/d/${dir}/in/0000000000001-${id}.bin`));
  assert.ok(put.re.test(`/sync/${sid}/e/${id}/${id}.bin`));
  for (const f of [`d/${dir}/manifest.bin`, `d/${dir}/key.bin`, `e/${id}/ack.bin`, `d/${dir}/out/${id}.bin`]) assert.ok(!put.re.test(`/sync/${sid}/${f}`), f);
  for (const l of locs) {
    for (const must of ['access_log off;', 'error_log /var/log/nginx/error.log crit;', 'limit_req zone=llmidesync', 'limit_req_status 429;', 'Cache-Control "no-store"', 'Access-Control-Allow-Origin $llmidesync_origin always;']) {
      assert.ok(l.body.includes(must), `${l.method} location has ${must}`);
    }
  }
  for (const must of ['client_max_body_size 64k;', 'create_full_put_path off;', 'dav_methods PUT;', 'dav_access group:rw;', 'client_body_temp_path /srv/llmide-sync-tmp;']) assert.ok(put.body.includes(must), must);
  assert.match(text, /limit_req_zone \$binary_remote_addr zone=llmidesync:1m rate=2r\/s;/);
  assert.match(text, /map \$http_origin \$llmidesync_origin \{\n\s+default "";\n\s+"https:\/\/llm-ide\.com" \$http_origin;/);
  assert.match(text, /location \/sync\/ \{ access_log off; return 404; \}/);
  assert.doesNotMatch(text, /location \^~ \/sync\//, '^~ would stop the regex search and 404 every /sync/ request');
  assert.doesNotMatch(text, /Access-Control-Allow-Origin "?\*/);
});

test('sshd Match block: chrooted internal-sftp, key only, nothing forwarded', () => {
  const conf = fs.readFileSync(path.resolve(HERE, '../../deploy/vps/50-llmidesync.conf'), 'utf8');
  for (const line of ['Match User llmidesync', 'AuthorizedKeysFile /etc/ssh/authorized_keys/%u', 'AuthenticationMethods publickey', 'PubkeyAuthentication yes',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'ChrootDirectory /srv/llmide-sync', 'ForceCommand internal-sftp -d /data -u 0007',
    'AllowTcpForwarding no', 'AllowStreamLocalForwarding no', 'AllowAgentForwarding no', 'PermitTunnel no', 'X11Forwarding no', 'PermitTTY no', 'PermitUserRC no']) {
    assert.match(conf, new RegExp(`^\\s*${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'), line);
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd extension && node --test tests/sync-own-server.test.mjs`
Expected: FAIL. `syncLocations` returns `[]` (so the device GET of `key.bin` throws `NGINX_DENIED`), and `50-llmidesync.conf` is missing (ENOENT).

- [ ] **Step 3: Write the server files**

`deploy/vps/llm-ide.com.nginx`: insert at the very top of the file (http context, outside both `server` blocks):

```nginx
# Own-server sync (docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md 8.1, deploy/vps/sync-sftp.md): one
# request-rate zone per client address, and the exact app origins that may call /sync/ from another origin. The PWA on
# this host is same-origin and needs none. Never "*".
limit_req_zone $binary_remote_addr zone=llmidesync:1m rate=2r/s;
map $http_origin $llmidesync_origin {
    default "";
    "https://llm-ide.com" $http_origin;
    # "http://127.0.0.1:5180" $http_origin;   # the web app's dev server; only while testing against this VPS
}

```

In the 443 `server` block, insert before `location = /manifest.webmanifest {`:

```nginx
    # Own-server sync. A device's folder names (22 random base64url characters each) are its capability: GET serves only
    # the files a device reads, PUT accepts only new request files and enrollment claims, into folders the desktop
    # created. No listing, no logs of these paths, small bodies, rate-limited.
    location ~ "^/sync/(?<sid>[A-Za-z0-9_-]{22})/(?<f>d/[A-Za-z0-9_-]{22}/(?:key\.bin|wrap\.bin|manifest\.bin|s/[0-9a-f]{32}\.bin|out/[A-Za-z0-9_-]{22}\.bin)|e/[A-Za-z0-9_-]{22}/ack\.bin)$" {
        limit_except GET { deny all; }
        alias /srv/llmide-sync/data/$sid/$f;
        default_type application/octet-stream;
        access_log off;
        error_log /var/log/nginx/error.log crit;
        limit_req zone=llmidesync burst=40 nodelay;
        limit_req_status 429;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
        add_header Access-Control-Allow-Origin $llmidesync_origin always;
        add_header Vary Origin always;
    }
    location ~ "^/sync/(?<sid>[A-Za-z0-9_-]{22})/(?<f>d/[A-Za-z0-9_-]{22}/in/[0-9]{13}-[A-Za-z0-9_-]{22}\.bin|e/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}\.bin)$" {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin $llmidesync_origin always;
            add_header Access-Control-Allow-Methods "PUT" always;
            add_header Access-Control-Max-Age 600 always;
            add_header Vary Origin always;
            return 204;
        }
        limit_except PUT { deny all; }
        alias /srv/llmide-sync/data/$sid/$f;
        dav_methods PUT;
        create_full_put_path off;
        dav_access group:rw;
        client_body_temp_path /srv/llmide-sync-tmp;
        client_max_body_size 64k;
        access_log off;
        error_log /var/log/nginx/error.log crit;
        limit_req zone=llmidesync burst=10 nodelay;
        limit_req_status 429;
        add_header Cache-Control "no-store" always;
        add_header Access-Control-Allow-Origin $llmidesync_origin always;
        add_header Vary Origin always;
    }
    location /sync/ { access_log off; return 404; }

```

`deploy/vps/50-llmidesync.conf`:

```text
# /etc/ssh/sshd_config.d/50-llmidesync.conf — the own-server sync account (deploy/vps/sync-sftp.md, design 8.1).
# Chrooted, SFTP only, one root-owned key file, no shell, no TTY, nothing forwarded. Check with: sshd -t
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

`deploy/vps/check-sync.sh` (`chmod 755`):

```bash
#!/usr/bin/env bash
# Checks the own-server sync setup (deploy/vps/sync-sftp.md; design 8.1 and 13). Read-only: the probe PUTs below must
# all be refused, and they target random folder names that do not exist.
#   deploy/vps/check-sync.sh remote <web-host> <ssh-host> [ssh-port]   from any machine, e.g. remote llm-ide.com 72.62.76.92
#   deploy/vps/check-sync.sh server                                    on the VPS, as root
set -u
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
want() { local allowed=$1 got=$2 what=$3; if [[ " $allowed " == *" $got "* ]]; then ok "$what ($got)"; else bad "$what: got $got, want one of: $allowed"; fi; }

remote() {
  local web=${1:?web host} ssh_host=${2:?ssh host} port=${3:-22}
  local id; id=$(head -c 16 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | cut -c1-22)
  local base="https://$web/sync/$id/d/$id"
  code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
  want "404" "$(code "https://$web/sync/")" "no listing at /sync/"
  want "404" "$(code "$base/")" "no folder listing"
  want "404" "$(code "$base/other.bin")" "GET outside the allow-list"
  want "404" "$(code "$base/manifest.bin")" "GET of an absent allowed file"
  want "403 405" "$(code -X PUT --data-binary x "$base/manifest.bin")" "PUT over a desktop file"
  want "403 405" "$(code -X DELETE "$base/in/0000000000000-$id.bin")" "DELETE"
  want "413" "$(head -c 70000 /dev/zero | code -X PUT --data-binary @- "$base/in/0000000000000-$id.bin")" "PUT over 64 KiB"
  want "409" "$(code -X PUT --data-binary x "$base/in/0000000000000-$id.bin")" "PUT into a folder the desktop did not create"
  if curl -s -o /dev/null -D - -H 'Origin: https://evil.example' "$base/key.bin" | grep -qi '^access-control-allow-origin'; then bad "CORS answered a foreign origin"; else ok "no CORS for a foreign origin"; fi
  local codes=""; for _ in $(seq 1 60); do codes+="$(code "$base/key.bin") "; done
  if [[ "$codes" == *429* ]]; then ok "rate limit answers 429"; else bad "no 429 after 60 quick GETs"; fi
  local out; out=$(ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o ConnectTimeout=10 -p "$port" "llmidesync@$ssh_host" true 2>&1)
  if [[ "$out" == *"Permission denied (publickey)"* ]]; then ok "sshd offers only publickey to llmidesync"; else bad "sshd answer for password login: $out"; fi
}

server() {
  [[ $EUID -eq 0 ]] || { echo "run as root"; exit 2; }
  sshd -t || bad "sshd -t"
  local t; t=$(sshd -T -C user=llmidesync,host=check,addr=127.0.0.1)
  for kv in "chrootdirectory /srv/llmide-sync" "forcecommand internal-sftp -d /data -u 0007" "allowtcpforwarding no" "allowstreamlocalforwarding no" \
            "allowagentforwarding no" "permittunnel no" "x11forwarding no" "permittty no" "permituserrc no" "passwordauthentication no" \
            "kbdinteractiveauthentication no" "authenticationmethods publickey" "authorizedkeysfile /etc/ssh/authorized_keys/%u"; do
    if grep -qx "$kv" <<<"$t"; then ok "sshd: $kv"; else bad "sshd: want '$kv'"; fi
  done
  want "root:root 755" "$(stat -c '%U:%G %a' /srv/llmide-sync)" "chroot owned by root, not writable"
  want "llmidesync:llmidesync 2770" "$(stat -c '%U:%G %a' /srv/llmide-sync/data)" "data folder"
  want "www-data:llmidesync 2770" "$(stat -c '%U:%G %a' /srv/llmide-sync-tmp)" "nginx PUT temp folder"
  want "root:root 644" "$(stat -c '%U:%G %a' /etc/ssh/authorized_keys/llmidesync)" "authorized key file is root-owned"
  [[ "$(stat -c %d /srv/llmide-sync-tmp)" == "$(stat -c %d /srv/llmide-sync/data)" ]] && ok "temp and data on one filesystem (atomic rename)" || bad "temp and data on different filesystems"
  id -nG www-data | tr ' ' '\n' | grep -qx llmidesync && ok "www-data in group llmidesync" || bad "www-data not in group llmidesync"
  nginx -t 2>/dev/null && ok "nginx -t" || bad "nginx -t"
  nginx -V 2>&1 | grep -q http_dav_module && ok "nginx has the DAV module" || bad "nginx lacks http_dav_module"
  if grep -qs ' /sync/' /var/log/nginx/access.log; then bad "/sync/ paths in the access log"; else ok "no /sync/ paths in the access log"; fi
}

case "${1:-}" in
  remote) shift; remote "$@" ;;
  server) server ;;
  *) echo "usage: $0 remote <web-host> <ssh-host> [ssh-port] | server"; exit 2 ;;
esac
exit $fail
```

`deploy/vps/sync-sftp.md`:

````markdown
# Own-server sync: one-time setup (SFTP + HTTPS)

The desktop writes encrypted sync files to this VPS over SFTP. Phones and browsers read and write only their own
folder over `https://llm-ide.com/sync/`. The server only ever holds ciphertext. Design:
`docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` §8.1, ADR 0020.

## 1. Account and folders (as root)

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin llmidesync
install -d -m 755 -o root -g root /srv/llmide-sync                    # chroot: root-owned, not writable
install -d -m 2770 -o llmidesync -g llmidesync /srv/llmide-sync/data
install -d -m 2770 -o www-data -g llmidesync /srv/llmide-sync-tmp      # nginx PUT temp: same filesystem, group llmidesync
usermod -aG llmidesync www-data                                       # nginx reads data/ and writes inboxes
install -d -m 755 /etc/ssh/authorized_keys
```

`/srv/llmide-sync-tmp` must be on the same filesystem as `/srv/llmide-sync/data`. nginx renames each uploaded request
from there into place, so a reader never sees half a file. The setgid group makes those files readable by the sync user.

## 2. sshd

```bash
cp deploy/vps/50-llmidesync.conf /etc/ssh/sshd_config.d/50-llmidesync.conf
sshd -t && systemctl reload ssh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub     # paste this line into Settings → Phone and web sync → Own server
```

Read the fingerprint over a session you already trust (your own SSH login, the provider's console). The desktop
connects only to a server with exactly this key. If the server is reinstalled, its key changes and the desktop stops
with "The server's identity changed". Then read the new fingerprint the same way and Save again.

## 3. The desktop's key

In Settings → Phone and web sync → Own server, press Save. The card shows the desktop's public key and a command:

```bash
printf 'restrict %s\n' 'ssh-ed25519 AAAA… llmide-sync-…' > /etc/ssh/authorized_keys/llmidesync
chmod 644 /etc/ssh/authorized_keys/llmidesync        # root-owned: the sync user cannot change its own keys
```

Then press Test connection in Settings.

## 4. nginx

The `/sync/` locations, the rate zone and the CORS map are in [llm-ide.com.nginx](llm-ide.com.nginx). Install it as
usual, then:

```bash
nginx -V 2>&1 | grep -o http_dav_module     # must print http_dav_module (Ubuntu's nginx package has it)
nginx -t && systemctl restart nginx         # restart, not reload: the workers must pick up www-data's new group
```

To test the web app's dev server (`http://127.0.0.1:5180`) against this VPS, uncomment its line in the
`$llmidesync_origin` map. Comment it out again afterwards.

## 5. Verify

```bash
deploy/vps/check-sync.sh server                                   # on the VPS, as root
deploy/vps/check-sync.sh remote llm-ide.com 72.62.76.92           # from your computer
```

Both must end without a `FAIL` line.

## Known limits (stated plainly)

- **The folder name is a bearer secret in a URL.** Access logs for `/sync/` are off and the error log is at `crit`, but
  a crashing request can still log a path. Revoke a device by removing it in Settings (its folder is deleted).
- **No per-device token.** A token would travel in the same QR and live next to the folder name on the device, so it
  would add no secret. Everything behind the folder is end-to-end sealed and signed.
- **Overwrite.** A folder holder can PUT over its own earlier request name. Every request is signed by the device key,
  so this changes nothing the device could not send anyway.
- **Space.** A folder holder can upload 64 KiB files at 2 per second. The desktop deletes every inbox file it cannot
  verify on each 30 s drain, so a flood stays around 60 files. No fixed per-device cap is enforced. A full disk would
  also hit the other sites on this VPS.
- **Same host as the PWA.** The web app is only as trustworthy as the server that serves it (relay design §7.2).
- **Switching storage** (MEGA ↔ own server) in Settings unlinks every device. The old storage's files stay. Delete
  them by hand (`rm -rf /srv/llmide-sync/data/*` here, or the MEGA folder).
````

`deploy/vps/README.md`: add a row to the "What runs where" table:

`| Own-server sync | SFTP user `llmidesync` (chroot `/srv/llmide-sync`), nginx `https://llm-ide.com/sync/`; setup [sync-sftp.md](sync-sftp.md) |`

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd extension && node --test tests/sync-own-server.test.mjs && bash -n ../deploy/vps/check-sync.sh`
Expected: PASS, and `bash -n` prints nothing.

- [ ] **Step 5: Commit**

```bash
chmod 755 deploy/vps/check-sync.sh
git add deploy/vps/llm-ide.com.nginx deploy/vps/50-llmidesync.conf deploy/vps/sync-sftp.md deploy/vps/check-sync.sh deploy/vps/README.md extension/tests/helpers/fake-nginx-sync.mjs extension/tests/sync-own-server.test.mjs
git commit -m "feat(deploy): sshd and nginx setup for own-server sync with checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Settings card: choose storage, own-server form, public key

**Files:**
- Modify: `ui/screens/settings/sync-model.ts`
- Modify: `ui/screens/settings/sections/SyncSection.tsx`
- Create: `ui/screens/settings/sections/SyncOwnServer.tsx`
- Test: `ui/screens/settings/tests/sync-section.test.mjs`

**Interfaces:**
- Consumes: `POST /kb/sync/sftp` and the status shape from Task 4.
- Produces (from `sync-model.ts`): `type StoreKind = "mega" | "sftp"`, `SftpSetup`, `SftpStore`, `isSftpStore(s)`, `saveSftp(client, cfg)`, `authorizedKeysCommand(publicKey, user)`, `storeSummary(status)`. `syncErrorText(code, kind?)` and `describeSyncError(e, kind?)` take the kind (default `"mega"`).

- [ ] **Step 1: Write the failing tests**

Append to `ui/screens/settings/tests/sync-section.test.mjs`:

```js
const SFTP_STORE = { host: "sync.example.com", port: 22, username: "llmidesync", hostFingerprint: "SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM", webHost: "llm-ide.com",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGUNOIRsIwfOOUYhJwIlBFBb0cxkQq1Ete227Z9GE+lv llmide-sync-BBBBBBBBBBBBBBBBBBBBBB" };

test("own server: status decodes the sftp store strictly; a bad public key never renders", () => {
  const s = m.decodeSyncStatus({ ...STATUS, storeKind: "sftp", store: SFTP_STORE });
  assert.deepEqual(s.store, SFTP_STORE);
  assert.ok(m.isSftpStore(s.store));
  assert.equal(m.decodeSyncStatus({ ...STATUS, storeKind: "sftp", store: { ...SFTP_STORE, publicKey: "ssh-ed25519 AAAA'; rm -rf / #" } }).store, null);
  assert.equal(m.decodeSyncStatus({ ...STATUS, storeKind: "sftp", store: { ...SFTP_STORE, port: "22" } }).store, null);
  assert.equal(m.decodeSyncStatus(STATUS).store.folder, "llmide-sync", "MEGA status still decodes");
});

test("own server: the save call, the key install command and the summary", async () => {
  const c = fake({ "POST /kb/sync/sftp": { status: 200, body: { ...STATUS, storeKind: "sftp", store: SFTP_STORE } } });
  const cfg = { host: "sync.example.com", port: 22, username: "llmidesync", hostFingerprint: SFTP_STORE.hostFingerprint, webHost: "llm-ide.com" };
  assert.equal((await m.saveSftp(c, cfg)).storeKind, "sftp");
  assert.equal(c.calls[0], `POST /kb/sync/sftp ${JSON.stringify(cfg)}`);
  assert.equal(m.authorizedKeysCommand(SFTP_STORE.publicKey, "llmidesync"),
    `printf 'restrict %s\\n' '${SFTP_STORE.publicKey}' > /etc/ssh/authorized_keys/llmidesync`);
  assert.match(m.storeSummary(m.decodeSyncStatus({ ...STATUS, storeKind: "sftp", store: SFTP_STORE })), /llmidesync@sync\.example\.com:22.*https:\/\/llm-ide\.com\/sync\//);
  assert.match(m.storeSummary(m.decodeSyncStatus(STATUS)), /l\*\*\*@example\.com.*llmide-sync/);
});

test("own-server error texts are about the server, MEGA texts stay", () => {
  assert.match(m.syncErrorText("SYNC_HOST_KEY_CHANGED", "sftp"), /identity changed/);
  assert.match(m.syncErrorText("SYNC_AUTH_FAILED", "sftp"), /authorized_keys/);
  assert.match(m.syncErrorText("SYNC_AUTH_FAILED"), /email or password/);
  assert.doesNotMatch(m.syncErrorText("SYNC_UNREACHABLE", "sftp"), /MEGA/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs`
Expected: FAIL with `m.isSftpStore is not a function`.

- [ ] **Step 3: Implement the model**

In `ui/screens/settings/sync-model.ts`, change the header's last sentence to: "The MEGA password is sent once, on Save, and is never read back; the own server's SSH private key never leaves the core (the status carries only its public line)." Replace the `MegaStore`/`SyncStatus` declarations and `decodeSyncStatus`'s `store` lines:

```ts
export type StoreKind = "mega" | "sftp";
export interface MegaStore { folder: string; account: string }
export interface SftpSetup { host: string; port: number; username: string; hostFingerprint: string; webHost: string }
export interface SftpStore extends SftpSetup { publicKey: string }
export const isSftpStore = (s: MegaStore | SftpStore | null): s is SftpStore => !!s && "publicKey" in s;
```

and in `SyncStatus` set `store: MegaStore | SftpStore | null;`. In `decodeSyncStatus`, replace the `const store = …` line with:

```ts
  const store = v.storeKind === "sftp" ? decodeSftpStore(s)
    : isRecord(s) && typeof s.folder === "string" && typeof s.account === "string" ? { folder: s.folder, account: s.account } : null;
```

and add above `decodeSyncStatus`:

```ts
const PUBLIC_KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9_.@-]{1,80})?$/; // shown in a shell command: no quotes or spaces inside
function decodeSftpStore(s: unknown): SftpStore | null {
  if (!isRecord(s) || typeof s.host !== "string" || !Number.isInteger(s.port) || typeof s.username !== "string" || typeof s.hostFingerprint !== "string"
    || typeof s.webHost !== "string" || typeof s.publicKey !== "string" || !PUBLIC_KEY_RE.test(s.publicKey)) return null;
  return { host: s.host, port: s.port as number, username: s.username, hostFingerprint: s.hostFingerprint, webHost: s.webHost, publicKey: s.publicKey };
}
```

Replace `SYNC_ERROR_TEXT`/`syncErrorText`/`describeSyncError` with:

```ts
const SYNC_ERROR_TEXT: Record<string, string> = {
  SYNC_AUTH_FAILED: "MEGA refused the email or password. Check them, then Save again. Sync was turned off so MEGA does not lock the account.",
  SYNC_MFA_REQUIRED: "This MEGA account has two-factor login on. The desktop logs in by itself, so use a separate MEGA account with two-factor off (keep it on for your personal account).",
  SYNC_RATE_LIMITED: "MEGA asked LLM-IDE to slow down. Sync retries by itself in a few minutes.",
  SYNC_QUOTA: "The MEGA account is over its storage or transfer quota.",
  SYNC_UNREACHABLE: "MEGA could not be reached. Check the network; sync retries by itself.",
  SYNC_IO: "A MEGA operation failed. Sync retries by itself.",
  SYNC_BUSY: "Sync is finishing a cycle. Try again in a moment.",
};
const SFTP_ERROR_TEXT: Record<string, string> = {
  SYNC_HOST_KEY_CHANGED: "The server's identity changed: it showed a different host key than the fingerprint you pasted, so the desktop did not connect and sync was turned off. If you reinstalled the server, read its new fingerprint on it and Save again. Otherwise, do not connect: someone may be in between.",
  SYNC_AUTH_FAILED: "The server refused this desktop's key. Run the command below on the server as root (it writes /etc/ssh/authorized_keys/llmidesync), then Test connection. Sync was turned off until then.",
  SYNC_UNREACHABLE: "Your server could not be reached. Check the address, the SSH port and the network; sync retries by itself.",
  SYNC_IO: "A file operation on your server failed. Check the folders with deploy/vps/check-sync.sh server; sync retries by itself.",
  SYNC_TIMEOUT: "Your server did not answer in time. Sync retries by itself.",
};
export const syncErrorText = (code: string, kind: string | null = "mega"): string | null =>
  (kind === "sftp" ? SFTP_ERROR_TEXT[code] : undefined) ?? SYNC_ERROR_TEXT[code] ?? null;
export const describeSyncError = (e: unknown, kind: string | null = "mega"): string | null => (e instanceof ApiError ? syncErrorText(e.code, kind) : null);
```

Add after `saveMega`:

```ts
export const saveSftp = async (client: CoreClient, cfg: SftpSetup) => decodeSyncStatus(await call(client, "POST", "/kb/sync/sftp", cfg));
/** The root command that installs the desktop's key; the key and user are validated, so single quotes are safe. */
export const authorizedKeysCommand = (publicKey: string, user: string) => `printf 'restrict %s\\n' '${publicKey}' > /etc/ssh/authorized_keys/${user}`;
export function storeSummary(s: SyncStatus): string {
  if (isSftpStore(s.store)) return `Server ${s.store.username}@${s.store.host}:${s.store.port}. Phones and browsers use https://${s.store.webHost}/sync/.`;
  return s.store ? `Connected account ${s.store.account}, folder ${s.store.folder} in its Cloud Drive.` : "";
}
```

- [ ] **Step 4: Implement the card**

`ui/screens/settings/sections/SyncOwnServer.tsx`:

```tsx
// Settings → Phone and web sync → Own server: SFTP address, port and user; the pasted host-key fingerprint; the HTTPS
// host phones and browsers use. After Save it shows this desktop's public key and the root command that installs it.
// Nothing secret is shown or sent: the private key stays in the core's vault.
import { useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { Button } from "../ui.tsx";
import { authorizedKeysCommand, isSftpStore, type SftpSetup, type SyncStatus } from "../sync-model.ts";

export default function SyncOwnServer({ status, onSave }: { status: SyncStatus | null | undefined; onSave: (cfg: SftpSetup) => void }): ReactNode {
  const { host } = useEnv();
  const cur = status && isSftpStore(status.store) ? status.store : null;
  const [form, setForm] = useState({ host: cur?.host ?? "", port: String(cur?.port ?? 22), username: cur?.username ?? "llmidesync",
    hostFingerprint: cur?.hostFingerprint ?? "", webHost: cur?.webHost ?? "llm-ide.com" });
  const [copied, setCopied] = useState(false);
  const input = (k: keyof typeof form, label: string) => (
    <label className="st-field">{label}
      <input className="st-input" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} aria-label={label} spellCheck={false} autoComplete="off" />
    </label>
  );
  const command = cur ? authorizedKeysCommand(cur.publicKey, cur.username) : null;
  const save = () => onSave({ host: form.host.trim(), port: Number(form.port), username: form.username.trim(), hostFingerprint: form.hostFingerprint.trim(), webHost: form.webHost.trim() });
  return (
    <div className="st-stack">
      <p className="st-hint">Your own server keeps the encrypted files. The desktop writes them over SFTP, and each phone or browser reaches only its own folder over HTTPS. Set the server up once with <code>deploy/vps/sync-sftp.md</code>.</p>
      {input("host", "Server address")}
      {input("port", "SSH port")}
      {input("username", "SFTP user")}
      {input("hostFingerprint", "Server host key fingerprint")}
      <p className="st-hint">On the server, run <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> over a connection you already trust, and paste what it prints. The desktop connects only to a server with exactly this key.</p>
      {input("webHost", "HTTPS host for phones and browsers")}
      <div className="st-row"><Button onClick={save} disabled={!form.host.trim() || !form.hostFingerprint.trim()}>Save</Button></div>
      {cur && command && (
        <div className="st-stack">
          <p className="st-hint">This desktop's SSH public key. The private key stays in this computer's encrypted vault.</p>
          <pre className="st-pre" aria-label="SSH public key">{cur.publicKey}</pre>
          <p className="st-hint">Install it on the server as root (this replaces any earlier key for the sync user), then press Test connection:</p>
          <pre className="st-pre" aria-label="Command that installs the key">{command}</pre>
          <div className="st-row"><Button onClick={() => void host.copyText(command).then(() => setCopied(true), () => setCopied(false))}>{copied ? "Copied" : "Copy command"}</Button></div>
        </div>
      )}
    </div>
  );
}
```

Replace `ui/screens/settings/sections/SyncSection.tsx` with:

```tsx
// Settings → Phone and web sync (desktop off): choose the storage (a dedicated MEGA account, or your own server over
// SFTP), connection test, on/off and "Publish now". Secrets are write-only: the MEGA password field is cleared after
// Save and never filled from the core, and the SSH private key never leaves the core. Saving the other storage kind
// unlinks every device, so the card asks first.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { loadSyncStatus, saveMega, saveSftp, testSync, setSyncEnabled, publishNow, syncErrorText, describeSyncError, storeSummary, isSftpStore,
  type SyncStatus, type StoreKind, type SftpSetup } from "../sync-model.ts";
import SyncDevices from "./SyncDevices.tsx";
import SyncOwnServer from "./SyncOwnServer.tsx";

export default function SyncSection(): ReactNode {
  const { client } = useEnv();
  const [status, setStatus] = useState<SyncStatus | null | undefined>(undefined);
  const [kind, setKind] = useState<StoreKind>("mega");
  const [form, setForm] = useState({ email: "", password: "", folder: "llmide-sync" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null); setNote(null);
    try { await fn(); if (ok) setNote(ok); } catch (e) { setError(describeSyncError(e, kind) ?? describeError(e)); }
    try { setStatus(await loadSyncStatus(client)); } catch { /* keep the last status */ }
  }, [client, kind]);
  useEffect(() => { void loadSyncStatus(client).then((s) => {
    setStatus(s);
    if (s?.storeKind === "sftp") setKind("sftp");
    else if (s?.store && !isSftpStore(s.store)) { const folder = s.store.folder; setForm((f) => ({ ...f, folder })); }
  }, (e) => setError(describeError(e))); }, [client]);
  if (status === null) return null;
  const configured = status?.storeKind === "mega" || status?.storeKind === "sftp" ? status.storeKind : null;
  /** Saving another kind than the configured one unlinks every device: ask first. */
  const guarded = (fn: () => Promise<void>) => { if (configured && configured !== kind) setPending(() => fn); else void fn(); };
  const saveMegaNow = () => run(async () => {
    await saveMega(client, { email: form.email.trim(), password: form.password, folder: form.folder.trim() || "llmide-sync" });
    setForm((f) => ({ ...f, password: "" }));
    await testSync(client);
  }, "Saved. MEGA connection works.");
  const saveSftpNow = (cfg: SftpSetup) => run(() => saveSftp(client, cfg), "Saved. Install the key below on the server, then press Test connection.");
  const working = kind === "sftp" ? "Your server answers." : "MEGA connection works.";
  return (
    <section className="st-stack" aria-labelledby="sync-title">
      <span className="st-label" id="sync-title">Phone and web sync</span>
      <p className="st-hint">With the desktop off, the phone and web app read an encrypted copy of your chats, meetings, plans and usage from your sync storage, and queue chat prompts that run when the desktop is back. The storage only ever holds ciphertext.</p>
      <div className="st-row" role="radiogroup" aria-label="Sync storage">
        <label className="st-row"><input type="radio" name="sync-kind" checked={kind === "mega"} onChange={() => setKind("mega")} /> MEGA</label>
        <label className="st-row"><input type="radio" name="sync-kind" checked={kind === "sftp"} onChange={() => setKind("sftp")} /> Own server</label>
      </div>
      {kind === "mega" ? (
        <>
          <div className="st-stack" role="note">
            <p className="st-hint"><strong>Use a separate MEGA account made only for LLM-IDE</strong>, never your personal one. It will hold nothing but encrypted sync files, so a leak of its password exposes nothing readable.</p>
            <p className="st-hint">Turn off two-factor login on that account: the desktop logs in by itself in the background. Keep two-factor on for your personal account.</p>
            <p className="st-hint">The email and password are kept in this computer's encrypted vault and are never shown again.</p>
          </div>
          <label className="st-field">MEGA email
            <input className="st-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="MEGA email" autoComplete="off" spellCheck={false} />
          </label>
          <label className="st-field">MEGA password
            <input className="st-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-label="MEGA password" autoComplete="new-password" />
          </label>
          <label className="st-field">Folder name
            <input className="st-input" value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} aria-label="Folder name" spellCheck={false} />
          </label>
          <div className="st-row"><Button onClick={() => guarded(saveMegaNow)} disabled={!form.email.trim() || !form.password}>Save and test</Button></div>
        </>
      ) : (
        <SyncOwnServer status={status} onSave={(cfg) => guarded(() => saveSftpNow(cfg))} />
      )}
      {pending && (
        <div className="st-dialog" role="alertdialog" aria-label="Switch sync storage">
          <strong>Switch sync storage?</strong>
          <p className="st-hint">Every phone and browser is unlinked and must be added again. The files in the old storage stay there; delete them yourself.</p>
          <div className="st-row">
            <button type="button" className="st-btn" onClick={() => setPending(null)}>Cancel</button>
            <Button tone="danger" onClick={() => { const fn = pending; setPending(null); void fn(); }}>Switch</Button>
          </div>
        </div>
      )}
      {status?.store && configured === kind && (
        <div className="st-stack">
          <p className="st-hint">{storeSummary(status)}</p>
          <p className="st-hint">Desktop signing key fingerprint: <code>{status.signingFingerprint}</code></p>
          <div className="st-row"><Button onClick={() => run(() => testSync(client), working)}>Test connection</Button></div>
          <label className="st-row"><input type="checkbox" checked={status.enabled} onChange={(e) => run(() => setSyncEnabled(client, e.target.checked))} /> Sync on</label>
          <div className="st-row"><Button onClick={() => run(() => publishNow(client), "Published.")} disabled={!status.enabled}>Publish now</Button></div>
          {status.enabled ? <SyncDevices status={status} onStatus={(s) => setStatus(s)} /> : <p className="st-hint">Turn sync on to add a phone or browser.</p>}
          <p className="st-hint" aria-live="polite">{status.lastError ? `Last error: ${syncErrorText(status.lastError, status.storeKind) ?? status.lastError}` : status.lastPublishAt ? `Last published ${new Date(status.lastPublishAt).toLocaleString()}` : "Not published yet."} · {status.devices.length} device(s)</p>
        </div>
      )}
      {note && <p className="st-hint" aria-live="polite">{note}</p>}
      <ErrorText text={error} />
    </section>
  );
}
```

`SyncOwnServer` must remount when the status changes after Save, so it shows the new key. It reads `cur` on every render. The form state keeps what the user typed, which is the intended behaviour.

- [ ] **Step 5: Run the tests and the type/build gate**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/*.test.* && npm run build`
Expected: PASS. `npm run build` runs `tsc --noEmit` over the new TSX, then `vite build`.

- [ ] **Step 6: Commit**

```bash
git add ui/screens/settings/sync-model.ts ui/screens/settings/sections/SyncSection.tsx ui/screens/settings/sections/SyncOwnServer.tsx ui/screens/settings/tests/sync-section.test.mjs
git commit -m "feat(ui): choose MEGA or own server in the sync settings card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web app: HTTPS device store, pairing without login, CSP

**Files:**
- Create: `web/src/sync/https-store.ts`
- Modify: `web/src/sync/enroll.ts` (`ST_RE`), `web/src/sync/controller.ts`, `web/src/screens/SyncTier.tsx`
- Modify: `web/vite.config.ts`, `web/scripts/serve.mjs`, `deploy/vps/llm-ide.com.nginx` (CSP line), `web/DEPLOY.md`
- Create: `web/tests/sync-https-store.test.mjs`
- Modify: `web/tests/sync-controller.test.mjs`, `web/tests/scaffold.test.mjs`

**Interfaces:**
- Consumes: `OpenedStore`, `checkPath`, `MAX_FILE_BYTES`, `SyncStoreError` from `mega-store.ts`.
- Produces: `openHttpsStore(host, { fetchFn? }): OpenedStore`; `WEB_HOST_RE`. The controller exports `needsLogin(st)` and `hostOf(st)`. `SyncDeps.openStore` becomes `(c: { st: string; email: string; password: string }) => Promise<OpenedStore>`. `SyncState.login: boolean` is true when the pairing or the linked device needs a MEGA login.

- [ ] **Step 1: Write the failing tests**

`web/tests/sync-https-store.test.mjs`:

```js
// The browser's own-server store on a fake fetch: exact URLs, no credentials/referrer/cache/redirects, status codes
// mapped to SYNC_* codes, paths and sizes checked before any request. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHttpsStore } from '../src/sync/https-store.ts';

const ID = 'A'.repeat(22);
function fakeFetch(replies = []) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    const r = replies.shift() ?? { status: 404 };
    if (r.throw) throw new TypeError('Failed to fetch');
    return new Response(r.status === 204 || r.status === 404 ? null : (r.body ?? new Uint8Array()), { status: r.status, headers: r.headers });
  };
  return { fn, calls };
}
const code = (c) => (e) => { assert.equal(e.code, c); return true; };

test('GET maps 200 to bytes and 404 to null, with a private, uncached, redirect-free request', async () => {
  const f = fakeFetch([{ status: 200, body: new Uint8Array([1, 2]) }, { status: 404 }]);
  const s = openHttpsStore('llm-ide.com', { fetchFn: f.fn });
  assert.deepEqual([...await s.get(`${ID}/d/${ID}/key.bin`)], [1, 2]);
  assert.equal(await s.get(`${ID}/d/${ID}/wrap.bin`), null);
  assert.equal(f.calls[0].url, `https://llm-ide.com/sync/${ID}/d/${ID}/key.bin`);
  assert.equal(f.calls[0].method, 'GET');
  for (const [k, v] of Object.entries({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })) assert.equal(f.calls[0][k], v, k);
});

test('PUT accepts 201 and 204; 409, 413, 429 and others are coded; a failed fetch is SYNC_UNREACHABLE', async () => {
  const f = fakeFetch([{ status: 201 }, { status: 204 }, { status: 409 }, { status: 413 }, { status: 429 }, { status: 500 }, { throw: true }]);
  const s = openHttpsStore('llm-ide.com', { fetchFn: f.fn });
  const p = `${ID}/d/${ID}/in/0000000000001-${ID}.bin`;
  await s.put(p, new Uint8Array([1]));
  await s.put(p, new Uint8Array([1]));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_MISSING'));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_TOO_LARGE'));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_RATE_LIMITED'));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_IO'));
  await assert.rejects(s.get(p), code('SYNC_UNREACHABLE'));
  assert.equal(f.calls[0].method, 'PUT');
});

test('bad hosts, bad paths and oversized bodies never reach fetch; a closed store refuses', async () => {
  const f = fakeFetch();
  for (const h of ['LLM-IDE.com', 'localhost', 'llm-ide.com:8443', 'evil.com/x']) assert.throws(() => openHttpsStore(h, { fetchFn: f.fn }), code('SYNC_BAD_PATH'), h);
  const s = openHttpsStore('llm-ide.com', { fetchFn: f.fn });
  await assert.rejects(s.get('../x'), code('SYNC_BAD_PATH'));
  await assert.rejects(s.put(`${ID}/x.bin`, new Uint8Array(65537)), code('SYNC_TOO_LARGE'));
  await s.close();
  await assert.rejects(s.get(`${ID}/x.bin`), code('SYNC_IO'));
  assert.equal(f.calls.length, 0);
});
```

In `web/tests/sync-controller.test.mjs`, change the rig's `openStore` to the new signature:

```js
    openStore: async ({ st, email, password }) => {
      assert.equal(st, r.st);
      if (r.failOpen) throw r.failOpen;
      if (st.startsWith('mega:') && (email !== EMAIL || password !== PW)) throw new SyncStoreError('SYNC_AUTH_FAILED');
      return { get: (p) => { r.gets++; return store.get(p); }, put: (p, b, m) => store.put(p, b, m), close: async () => { r.closed++; } };
    },
```

and change `function rig() {` to `function rig(st = 'mega:llmide-sync') {`, `createFakeDesktop({ store, st: 'mega:llmide-sync' })` to `createFakeDesktop({ store, st })`, and add `st,` to the `r` object. Any other `openStore` stub in the file that destructures `folder` changes the same way. Append:

```js
test('own server: an sftp: link pairs with no login, and a reload opens the store by itself', async () => {
  const r = rig('sftp:llm-ide.com');
  r.link = await r.desk.open(T);
  await r.c.start();
  assert.equal(r.c.getState().phase, 'pairing');
  assert.equal(r.c.getState().login, false);
  await r.c.pair({ email: '', password: '', name: 'Laptop browser' });
  assert.equal(r.c.getState().phase, 'ready', r.c.getState().error ?? '');
  r.c.dispose();
  const again = createSyncController({ keystore: r.keystore, takePairLink: () => null, onNetwork: () => () => {}, online: () => true,
    setTimer: () => null, clearTimer: () => {}, now: () => r.clock,
    openStore: async ({ st }) => { assert.equal(st, 'sftp:llm-ide.com'); return { get: (p) => r.store.get(p), put: (p, b) => r.store.put(p, b), close: async () => {} }; } });
  await again.start();
  assert.equal(again.getState().phase, 'ready', 'no unlock step for the own server');
});
```

In `web/tests/scaffold.test.mjs`, replace `const MEGA_CONNECT = [...]` with

```js
const REMOTE_CONNECT = ["https://g.api.mega.co.nz", "https://*.userstorage.mega.co.nz", "https://llm-ide.com"];
```

and every later `MEGA_CONNECT` with `REMOTE_CONNECT`. Rename the first test to `"the CSP allows no inline or remote script; remote connects go only to MEGA's API and transfer hosts and the own sync server"`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && node --test --experimental-strip-types tests/sync-https-store.test.mjs tests/sync-controller.test.mjs tests/scaffold.test.mjs`
Expected: FAIL. `https-store.ts` is missing, the controller still passes `folder`, and the CSP lacks `https://llm-ide.com`.

- [ ] **Step 3: Implement**

`web/src/sync/https-store.ts`:

```ts
// The browser's view of the user's own sync server (design 8.1): plain HTTPS GET/PUT to https://<host>/sync/<path>,
// which nginx serves only inside this device's folder. No login: the random folder names in the path are the
// capability. Requests send no credentials and no referrer, skip the cache and refuse redirects. Writes create only
// new, uniquely named files in folders the desktop made; nginx refuses anything else.
import { checkPath, MAX_FILE_BYTES, SyncStoreError, type OpenedStore } from "./mega-store.ts";

export const WEB_HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/; // same as extension sftp.mjs
const PUT_MAX = 65536; // nginx client_max_body_size 64k
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const statusError = (s: number) =>
  new SyncStoreError(s === 429 || s === 503 ? "SYNC_RATE_LIMITED" : s === 413 ? "SYNC_TOO_LARGE" : s === 409 ? "SYNC_MISSING" : "SYNC_IO");

export function openHttpsStore(host: string, { fetchFn = (u, i) => globalThis.fetch(u, i) }: { fetchFn?: Fetch } = {}): OpenedStore {
  if (!WEB_HOST_RE.test(host)) throw new SyncStoreError("SYNC_BAD_PATH");
  let closed = false;
  const request = async (path: string, init: RequestInit) => {
    const url = `https://${host}/sync/${checkPath(path).join("/")}`;
    if (closed) throw new SyncStoreError("SYNC_IO");
    try { return await fetchFn(url, { ...init, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" }); }
    catch { throw new SyncStoreError("SYNC_UNREACHABLE"); }
  };
  return {
    async get(path) {
      const r = await request(path, { method: "GET" });
      if (r.status === 404) return null;
      if (r.status !== 200) throw statusError(r.status);
      if (Number(r.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      return bytes;
    },
    async put(path, bytes) {
      checkPath(path);
      if (bytes.length > PUT_MAX) throw new SyncStoreError("SYNC_TOO_LARGE");
      const r = await request(path, { method: "PUT", body: bytes });
      if (r.status !== 201 && r.status !== 204) throw statusError(r.status);
    },
    async close() { closed = true; },
  };
}
```

`web/src/sync/enroll.ts`:

```ts
const ST_RE = /^(mega:[A-Za-z0-9_.-]{1,64}|sftp:(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|memory:)$/; // memory: is the test adapter only; the controller refuses it
```

`web/src/sync/controller.ts`:
- Header first sentence: "pair this browser, open the sync storage for this session (MEGA with a password typed each session, or the user's own server with no login)".
- Import: `import { openHttpsStore, WEB_HOST_RE } from "./https-store.ts";`.
- `SyncState` gains `login: boolean;` (after `email: string;`). The initial state in `createSyncController` adds `login: true`.
- `SyncDeps.openStore: (c: { st: string; email: string; password: string }) => Promise<OpenedStore>;`.
- Change `TEXT.SYNC_UNREACHABLE` to `"The sync storage is not reachable. Check the network."`, `TEXT.SYNC_RATE_LIMITED` to `"The sync storage asked us to slow down. Trying again later."`, `TEXT.SYNC_MISSING` to `"The sync folder for this browser was not found."`. In `textOf`, change `` `MEGA operation failed (${code}).` `` to `` `Sync storage operation failed (${code}).` ``.
- After `folderOf`, add:

```ts
export const needsLogin = (st: string) => !st.startsWith("sftp:");
export function hostOf(st: string): string {
  const host = st.startsWith("sftp:") ? st.slice(5) : "";
  if (!WEB_HOST_RE.test(host)) throw new SyncCryptoError("unsupported_store");
  return host;
}
const checkStore = (st: string) => (needsLogin(st) ? folderOf(st) : hostOf(st));
```

- `defaultDeps().openStore`:

```ts
    openStore: async (c) => (needsLogin(c.st) ? openMegaStore({ email: c.email, password: c.password, folder: folderOf(c.st) }) : openHttpsStore(hostOf(c.st))),
```

- `acceptLink`: replace `folderOf(p.st);` with `checkStore(p.st);` and add `login: needsLogin(p.st),` to its `set({ … })`.
- `pairNow`: `s = await d.openStore({ st: p.st, email: i.email, password: i.password });` and `readFirstWrap(open, e, { megaEmail: needsLogin(p.st) ? i.email : "" })`. In the final `set`, keep `email: i.email`.
- `unlock`: `const s = await d.openStore({ st: device.st, email: i.email, password: i.password });`, and replace the email-update line with `if (needsLogin(device.st) && device.megaEmail !== i.email) { device.megaEmail = i.email; await save(); }`.
- `cancelPairing` and `lock` and `forget`: add `login: device ? needsLogin(device.st) : true` to their `set` calls (`forget`: `login: true`).
- `start()`: replace its `set({ phase: … })` and `if (link) acceptLink(link);` with:

```ts
      set({ phase: device ? "locked" : "none", email: device?.megaEmail ?? "", pending: pendingView(), login: device ? needsLogin(device.st) : true });
      if (link) acceptLink(link);
      else if (device && !needsLogin(device.st)) await unlock({ email: "", password: "" }); // own server: nothing to type
```

`web/src/screens/SyncTier.tsx`:
- `STEP.login`: keep the key, and compute the text in `PairView`: `const stepText = state.pairStep === "claiming" ? STEP.claiming : state.login !== false ? STEP.login : "Connecting to your server…";`. Use `{state.busy ? stepText : ""}` in place of the current `STEP[…]` expression.
- `PairView`: wrap the two MEGA `<label>` + `<input>` pairs in `{state.login !== false && (<>…</>)}`. Change the description paragraph to `{state.login !== false ? "Use the dedicated MEGA account the desktop syncs to. The password is used for this session only and is never stored." : "This browser reaches its own folder on your server. Nothing to sign in to."}`.
- `UnlockView`: when `state.login === false`, render instead of the form:

```tsx
  if (state.login === false) return (
    <section className="web-form">
      <h2>Offline sync</h2>
      {state.error && <StatusBanner severity="error" message={state.error} />}
      <div className="web-actions">
        <button type="button" disabled={state.busy} onClick={() => void sync.unlock({ email: "", password: "" })}>{state.busy ? "Connecting…" : "Connect"}</button>
        <button type="button" onClick={() => void sync.forget()}>Forget this browser</button>
      </div>
    </section>
  );
```

(placed after the hooks at the top of `UnlockView`, so the hook order never changes).
- The "removed" text: change "or its folder was deleted in MEGA" to "or its folder was deleted from the sync storage".

CSP: in `web/vite.config.ts` and `web/scripts/serve.mjs` change the `connect-src` entry to

```ts
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:* wss: https://g.api.mega.co.nz https://*.userstorage.mega.co.nz https://llm-ide.com",
```

In `web/vite.config.ts`, extend the comment above `CSP` with `; https://llm-ide.com for the own sync server (design 8.1; 'self' covers it on the deployed site, the dev server needs it named)`. In `deploy/vps/llm-ide.com.nginx`, change the server-level CSP's `connect-src … https://*.userstorage.mega.co.nz;` to `connect-src … https://*.userstorage.mega.co.nz https://llm-ide.com;`. In `web/DEPLOY.md`, add `https://llm-ide.com` to the CSP example and one sentence: "`https://llm-ide.com` is the own sync server (`/sync/`, deploy/vps/sync-sftp.md); if you run your sync server on another host, put that host here instead, in all three places."

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd web && npm test && npm run build`
Expected: PASS (all web tests, including `sync-screens`, `sync-mega-store` and `sync-device`), and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/https-store.ts web/src/sync/enroll.ts web/src/sync/controller.ts web/src/screens/SyncTier.tsx web/vite.config.ts web/scripts/serve.mjs web/DEPLOY.md deploy/vps/llm-ide.com.nginx web/tests/sync-https-store.test.mjs web/tests/sync-controller.test.mjs web/tests/scaffold.test.mjs
git commit -m "feat(web): own-server sync store over HTTPS, no login for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: iPhone: `SyncHttpsClient` and the app using either store

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/SyncHttpsClient.swift`
- Modify: `ios_app/SharedProtocol/Sources/SharedProtocol/SyncEnroll.swift` (`isStore`, `isOwnServerHost`)
- Create: `ios_app/SharedProtocol/Tests/SharedProtocolTests/SyncHttpsClientTests.swift`
- Modify: `ios_app/MyApp/Services/SyncStore.swift`, `ios_app/MyApp/Views/Control/SyncEnrollSheet.swift`

**Interfaces:**
- Consumes: `SyncRemoteStore` (`@MainActor`, `get`, `put(_:_:createFolders:)`), `SyncPath.check`, `SyncPath.maxFileBytes`.
- Produces: `@MainActor public final class SyncHttpsClient: SyncRemoteStore` with `init(host:transport:) throws`, `Failure { rateLimited, tooLarge, missing, badHost, http(Int) }`, `Transport`, `urlSessionTransport`. Also `SyncEnroll.isOwnServerHost(_:) -> Bool`. `SyncStore.needsLogin: Bool`.

- [ ] **Step 1: Write the failing tests**

`ios_app/SharedProtocol/Tests/SharedProtocolTests/SyncHttpsClientTests.swift`:

```swift
import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("SyncHttpsClient against a fake nginx /sync/ endpoint")
struct SyncHttpsClientTests {
    @MainActor final class Fake {
        var requests: [URLRequest] = []
        var replies: [(Int, Data)] = []
        var transport: SyncHttpsClient.Transport { { [unowned self] req in
            self.requests.append(req)
            let (status, body) = self.replies.isEmpty ? (404, Data()) : self.replies.removeFirst()
            return (body, HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        } }
    }
    static let id = String(repeating: "A", count: 22)

    @Test("GET: 200 is the bytes, 404 is nil; the URL is https://<host>/sync/<path>")
    func get() async throws {
        let f = Fake(); f.replies = [(200, Data([1, 2])), (404, Data())]
        let c = try SyncHttpsClient(host: "llm-ide.com", transport: f.transport)
        #expect(try await c.get("\(Self.id)/d/\(Self.id)/key.bin") == Data([1, 2]))
        #expect(try await c.get("\(Self.id)/d/\(Self.id)/wrap.bin") == nil)
        #expect(f.requests[0].url?.absoluteString == "https://llm-ide.com/sync/\(Self.id)/d/\(Self.id)/key.bin")
        #expect(f.requests[0].httpMethod == "GET")
    }

    @Test("PUT: 201 and 204 succeed; 409, 413, 429, 500 map to failures; big bodies never leave")
    func put() async throws {
        let f = Fake(); f.replies = [(201, Data()), (204, Data()), (409, Data()), (413, Data()), (429, Data()), (500, Data())]
        let c = try SyncHttpsClient(host: "llm-ide.com", transport: f.transport)
        let p = "\(Self.id)/d/\(Self.id)/in/0000000000001-\(Self.id).bin"
        try await c.put(p, Data([1]), createFolders: 1)
        try await c.put(p, Data([1]), createFolders: 1)
        await #expect(throws: SyncHttpsClient.Failure.missing) { try await c.put(p, Data([1]), createFolders: 1) }
        await #expect(throws: SyncHttpsClient.Failure.tooLarge) { try await c.put(p, Data([1]), createFolders: 1) }
        await #expect(throws: SyncHttpsClient.Failure.rateLimited) { try await c.put(p, Data([1]), createFolders: 1) }
        await #expect(throws: SyncHttpsClient.Failure.http(500)) { try await c.put(p, Data([1]), createFolders: 1) }
        #expect(f.requests[0].httpMethod == "PUT" && f.requests[0].httpBody == Data([1]))
        let sent = f.requests.count
        await #expect(throws: SyncHttpsClient.Failure.tooLarge) { try await c.put(p, Data(count: 65_537), createFolders: 1) }
        #expect(f.requests.count == sent)
    }

    @Test("hosts and paths are checked before any request")
    func refusals() async throws {
        let f = Fake()
        for h in ["LLM-IDE.com", "localhost", "llm-ide.com:8443", "72.62.76.92", "evil.com/x"] {
            #expect(throws: SyncHttpsClient.Failure.badHost) { _ = try SyncHttpsClient(host: h, transport: f.transport) }
        }
        let c = try SyncHttpsClient(host: "llm-ide.com", transport: f.transport)
        await #expect(throws: (any Error).self) { _ = try await c.get("../x") }
        #expect(f.requests.isEmpty)
    }

    @Test("pairing accepts sftp:<lower-case DNS host> only")
    func storeDescriptor() {
        #expect(SyncEnroll.isStore("sftp:llm-ide.com"))
        #expect(SyncEnroll.isStore("mega:llmide-sync"))
        for st in ["sftp:", "sftp:LLM-IDE.com", "sftp:localhost", "sftp:llm-ide.com:8443", "sftp:72.62.76.92"] { #expect(!SyncEnroll.isStore(st)) }
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `make test-shared-protocol`
Expected: FAIL to compile (`cannot find 'SyncHttpsClient' in scope`). Without full Xcode it only builds; report that.

- [ ] **Step 3: Implement**

`ios_app/SharedProtocol/Sources/SharedProtocol/SyncHttpsClient.swift`:

```swift
import Foundation

/// The user's own sync server (design §8.1): plain HTTPS GET/PUT to `https://<host>/sync/<path>`. nginx serves only this
/// device's folder, and the random folder names in the path are the capability, so there is no login. No cookies, no
/// cache, redirects refused. `createFolders` is ignored: the desktop creates every folder a device writes into.
@MainActor
public final class SyncHttpsClient: SyncRemoteStore {
    public enum Failure: Error, Equatable, Sendable { case rateLimited, tooLarge, missing, badHost, http(Int) }
    public typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)
    static let putMax = 65_536  // nginx client_max_body_size 64k

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private static let urlSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        return URLSession(configuration: c, delegate: NoRedirect(), delegateQueue: nil)
    }()
    public static let urlSessionTransport: Transport = { request in
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.http(0) }
        return (data, http)
    }

    public let host: String
    private let transport: Transport

    public init(host: String, transport: @escaping Transport = SyncHttpsClient.urlSessionTransport) throws {
        guard SyncEnroll.isOwnServerHost(host) else { throw Failure.badHost }
        self.host = host; self.transport = transport
    }

    static func failure(_ status: Int) -> Failure {
        switch status {
        case 429, 503: return .rateLimited
        case 413: return .tooLarge
        case 409: return .missing
        default: return .http(status)
        }
    }
    private func request(_ segs: [String], _ method: String) -> URLRequest {
        var r = URLRequest(url: URL(string: "https://\(host)/sync/\(segs.joined(separator: "/"))")!)
        r.httpMethod = method
        return r
    }

    public func get(_ path: String) async throws -> Data? {
        let segs = try SyncPath.check(path)
        let (data, resp) = try await transport(request(segs, "GET"))
        if resp.statusCode == 404 { return nil }
        guard resp.statusCode == 200 else { throw Self.failure(resp.statusCode) }
        guard data.count <= SyncPath.maxFileBytes else { throw Failure.tooLarge }
        return data
    }

    public func put(_ path: String, _ bytes: Data, createFolders: Int) async throws {
        let segs = try SyncPath.check(path)
        guard bytes.count <= Self.putMax else { throw Failure.tooLarge }
        var r = request(segs, "PUT")
        r.httpBody = bytes
        let (_, resp) = try await transport(r)
        guard resp.statusCode == 201 || resp.statusCode == 204 else { throw Self.failure(resp.statusCode) }
    }
}
```

`SyncEnroll.swift`, replace `isStore` and its comment with:

```swift
    /// `mega:<folder>` (folder `[A-Za-z0-9_.-]{1,64}`), `sftp:<host>` (the own server's lower-case DNS name, reached over
    /// HTTPS), or `memory:` (the test adapter).
    public static func isStore(_ st: String) -> Bool {
        if st == "memory:" { return true }
        if st.hasPrefix("sftp:") { return isOwnServerHost(String(st.dropFirst(5))) }
        guard st.hasPrefix("mega:") else { return false }
        let f = st.utf8.dropFirst(5)
        return (1...64).contains(f.count) && f.allSatisfy { SyncB64.isB64uByte($0) || $0 == 0x2e }
    }

    /// Same pattern as extension/connectors/sync-store/sftp.mjs WEB_HOST_RE and web/src/sync/https-store.ts.
    public static func isOwnServerHost(_ h: String) -> Bool {
        h.range(of: #"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"#, options: .regularExpression) != nil
    }
```

`ios_app/MyApp/Services/SyncStore.swift`:
- Doc comment: "The iPhone's sync tier: with the desktop off, read the last encrypted snapshot and queue chat prompts, from MEGA or from the user's own server."
- After `private var mega: MegaClient?` add:

```swift
    private var server: SyncHttpsClient?
    private var remote: SyncRemoteStore? { mega ?? server }
    /// The pending pairing signs in to MEGA; the own server needs no login.
    var needsLogin: Bool { !(pendingPair?.st.hasPrefix("sftp:") ?? false) }
```

- In `restore()`, replace the `if let m = Keychain.load(StoredMega.self, .mega) { … } else { phase = .needsPassword }` block with:

```swift
        if st.pair.st.hasPrefix("sftp:") {
            server = try? SyncHttpsClient(host: String(st.pair.st.dropFirst("sftp:".count)))
            phase = server == nil ? .off : .ready
        } else if let m = Keychain.load(StoredMega.self, .mega) {
            megaEmail = m.email
            mega = MegaClient(folder: m.folder, session: m.session)
            phase = .ready
        } else { phase = .needsPassword }
```

- `startEnrollment`: `guard pair.st.hasPrefix("mega:") || pair.st.hasPrefix("sftp:") else { lastError = "This code is for a sync storage this app cannot open."; return }`.
- Replace `runEnrollment` with:

```swift
    private func runEnrollment(pair: SyncPair, email: String, password: String, name: String) async {
        var client: MegaClient?
        var session: MegaClient.Session?
        do {
            let store: SyncRemoteStore
            if pair.st.hasPrefix("sftp:") {
                enrollStep = .working("Connecting to your server…")
                store = try SyncHttpsClient(host: String(pair.st.dropFirst("sftp:".count)))
            } else {
                enrollStep = .working("Signing in to MEGA…")
                let s = try await MegaClient.login(email: email, password: password)
                let c = MegaClient(folder: String(pair.st.dropFirst("mega:".count)), session: s)
                session = s; client = c; store = c
            }
            enrollStep = .working("Checking the desktop's key…")
            let (d, stored): (SyncDevice, StoredKeys)
            if let p = prepared { (d, stored) = p } else {
                let (keys, s) = try Self.makeKeys()
                let nd = try await SyncDevice.prepare(pair: pair, name: name, keys: keys, store: store, nowMs: nowMs)
                (d, stored) = (nd, s)
                prepared = (nd, s)
            }
            if d.state.userId == nil {  // not acked yet: (re)write the same claim; after the ack the slot may be gone
                _ = try await poll(SyncDevice.ackWindowMs) { try await d.writeClaim(store); return true }
            }
            enrollStep = .working("Waiting for the desktop…")
            // A retry after the ack: the slot is gone once the desktop confirmed, so go straight to the wrap.
            let sas: String?
            if d.state.userId != nil { sas = try await d.readAck(store) }
            else { sas = try await poll(SyncDevice.ackWindowMs) { try await d.readAck(store) } }
            if let sas {
                enrollStep = .sas(sas)
                UIAccessibility.post(notification: .announcement, argument: "Code ready. Compare it with the desktop.")
            }
            _ = try await poll(SyncDevice.wrapWindowMs) { try await d.readWrap(store, nowMs: self.nowMs) ? true : nil }
            prepared = nil; pendingPair = nil
            await mega?.logout()
            _ = Keychain.save(stored, .keys)
            _ = Keychain.save(d.state, .state)
            if let session, let client {
                _ = Keychain.save(StoredMega(email: email, folder: client.folder, session: session), .mega)
                mega = client; server = nil; megaEmail = email
            } else {
                Keychain.delete(.mega)
                mega = nil; server = store as? SyncHttpsClient; megaEmail = ""
            }
            attach(d)
            queued = []; Self.write(queued, "queue.json")
            phase = .ready; enrollStep = .done
            await refresh()
        } catch is CancellationError {
            if let client { Task { await client.logout() } }  // a new task: this one is cancelled
        } catch {
            await client?.logout()
            enrollStep = .failed(Self.message(for: error))
        }
    }
```

- `refresh()`: change the guard to `guard phase == .ready || phase == .removed, let device, let remote, !refreshing else { return }`, then `SyncRecordingStore(remote: remote)` and `device.readReplies(remote, …)`.
- `send(_:)`: `guard phase == .ready, let device, let remote else { return }` and `device.sendRequest(remote, …)`.
- `removeFromPhone()`: add `server = nil` next to `mega = nil`.
- `fail(_:)`: add `if (error as? SyncHttpsClient.Failure) == .missing { phase = .removed }`.
- `message(for:)`: before `if error is URLError`, add

```swift
        if let f = error as? SyncHttpsClient.Failure {
            switch f {
            case .rateLimited: return "Your server is busy. Try again in a minute."
            case .missing: return "This iPhone's sync folder is gone from your server. Set it up again from the desktop."
            case .tooLarge, .badHost, .http: return "Couldn't reach your sync server (\(f))."
            }
        }
```

  and change `"No connection to MEGA."` to `"No connection to the sync storage."`.

`ios_app/MyApp/Views/Control/SyncEnrollSheet.swift`, in the `default:` form: wrap `Section("MEGA account") { … }` in `if syncStore.needsLogin { … }`, and change the Continue button's `.disabled(...)` to

```swift
                                .disabled((syncStore.needsLogin && (email.isEmpty || password.isEmpty)) || name.isEmpty)
```

- [ ] **Step 4: Run the tests and the build gates**

Run:

```bash
make test-shared-protocol
cd mac && swift build && cd ..
cd ios_app && xcodebuild -project MyApp.xcodeproj -target MyApp -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO SYMROOT="$TMPDIR/ios-build" build
```

Expected: tests PASS (or build-only without full Xcode: say so), the Mac build passes, and the iOS build ends with `** BUILD SUCCEEDED **`. `SwiftPM` may need to run outside the sandbox ("Invalid manifest" / "Operation not permitted" are sandbox artifacts).

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/SyncHttpsClient.swift ios_app/SharedProtocol/Sources/SharedProtocol/SyncEnroll.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/SyncHttpsClientTests.swift ios_app/MyApp/Services/SyncStore.swift ios_app/MyApp/Views/Control/SyncEnrollSheet.swift
git commit -m "feat(ios): own-server sync over HTTPS next to MEGA

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Spec status and full regression

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` (§8.1 corrections, §14 SP5 row)

- [ ] **Step 1: Record the corrections and the status**

In §8.1, change the nginx block's `location ^~ /sync/ { return 404; }` to `location /sync/ { access_log off; return 404; }`. Add `e/<Id22>/ack.bin` to the GET regex, as in `deploy/vps/llm-ide.com.nginx`. After the block, add one line: "As built (SP5): the vhost file is normative; see `docs/superpowers/plans/2026-11-06-sync-sp5-sftp.md` 'Spec corrections' for the `^~` shadowing, the ack GET, the PUT temp folder group, desktop-made folders, CORS and the inbox cap." In §14, set the SP5 row's "Delivers" cell to "users with their own server — **plan written** (docs/superpowers/plans/2026-11-06-sync-sp5-sftp.md)".

- [ ] **Step 2: Run the whole gate**

```bash
make test
make regression
cd desktop && npm test && cd ..
cd web && npm test && cd ..
```

Expected: all pass. A failure in a file this plan did not touch is reported with its output, not fixed here.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md
git commit -m "docs(sync): record SP5 own-server corrections in the design

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Decisions for the user (secure, free defaults; the plan builds the default)

| # | Decision | Default |
|---|---|---|
| D1 | HTTPS endpoint auth: folder-name capability only, or a per-device bearer token | Folder name only (128-bit random path segments; see Global Constraints for why a token adds nothing here) |
| D2 | Host devices use for `/sync/` (and the web CSP) | `llm-ide.com`, same origin as the PWA; another host means editing CSP in three places |
| D3 | CORS allow-list on `/sync/` | `https://llm-ide.com` only; the dev origin `http://127.0.0.1:5180` stays a commented line |
| D4 | Switching MEGA ↔ own server | Unlink every device, delete the old kind's vault secrets, reset publish records; old files left for the user to delete |
| D5 | SSH key lifetime | One ed25519 key per desktop user, made on the first own-server Save, kept until the storage kind is switched; no rotate button |
| D6 | SSH defaults | Port 22, user `llmidesync`, root `/data` (fixed); only `ssh-ed25519` host keys accepted |
| D7 | Per-device 200-file inbox cap (spec §8.1 risk 3) | Not built: the 30 s drain already deletes every unverifiable file; stated as a known limit |
| D8 | ssh2's optional native speed-ups in the desktop bundle | Stripped: pure JavaScript only |
