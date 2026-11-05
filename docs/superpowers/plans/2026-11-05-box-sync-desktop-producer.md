# Encrypted Sync, Desktop Producer (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop core publishes end-to-end-encrypted snapshots of chats, meetings, plans and usage into a
user-owned folder, and runs queued phone and web chat prompts from that folder's inbox at the fixed read-only
ceiling. The storage sits behind a `SyncStore` interface, and the first real adapter is SFTP to the user's own
server.

**Architecture:** The envelope library is `extension/core/sync-envelope.mjs`, a byte-for-byte port of relay v1
plus the purposes `snapshot`, `manifest` and `syncwrap`. Storage adapters live in
`extension/connectors/sync-store/` (memory for tests, SFTP over `ssh2`). Durable state is in the new tables of
migration 0064 (`extension/kb/sync-state.mjs`). Keys live in the core vault. The producer, the consumer, the
scheduler and the HTTP routes live under `extension/routes/sync/`. The consumer calls `startHostTurn`, which is
in the routes layer. Settings gets one card in the shared UI. **No Rust change:** another agent is editing
`desktop/src-tauri`, and the vault master key is already in the OS keychain (`secrets.rs`).

**Tech Stack:** Node 22 core (pure `node:http`, `node:crypto`, better-sqlite3), `ssh2` 1.17.0 (new, exact pin),
React 19 + TypeScript Settings card, Node test runner.

**Spec:** [docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md](../specs/2026-11-05-box-encrypted-sync-design.md)
(ADR: [docs/decisions/0020-box-encrypted-sync.md](../../decisions/0020-box-encrypted-sync.md)).

> **Ruling, recorded:** the plan's filename keeps the approved "box" name. The first adapter is the user's own
> server over SFTP, per the ruling in ADR 0020 (narrower device scope, no OAuth client secret in the PWA, no
> 60-day token expiry, $0 on the VPS the user already runs). The Box adapter is sub-project SP5 and has its own
> plan. The MEGA adapter is SP6 and has its own plan: it adds an unofficial dependency (`megajs`) and a
> credential-custody decision (spec §8.3, Q8), so it is not small enough to be this plan's last task.

## Global Constraints

- Envelope bytes are relay v1: canonical `enc`, buckets `[1024, 4096, 16384, 65536, 262144, 1048576]`, AES-256-GCM
  with a 96-bit random nonce and a 128-bit tag, ECDSA P-256 P1363 over `"llmide/<purpose>/v1\0" || enc(header ++ [extra, nonce, ct])`,
  and verify before decrypt. The relay v1 vectors (`schema/relay/v1/vectors/v1.json`) must keep passing in the new module.
- New purposes: `snapshot`, `manifest`, `syncwrap`. The syncwrap HKDF info label is `"llmide/syncwrap/v1"`.
- Folder layout: `<syncId>/d/<dir>/{key.bin, wrap.bin, manifest.bin, s/<32 hex>.bin, in/<13 digits>-<22 b64u>.bin, out/<22 b64u>.bin}`.
- A path segment matches `^[A-Za-z0-9_.-]{1,64}$` and is never `.` or `..`. A path has 1 to 6 segments. A file is at most 1,052,672 bytes.
- A snapshot frame is at most 1,048,572 bytes. Items are trimmed from the oldest end and `truncated: true` is set.
- Heartbeat: every 15 min, `validUntil = generatedAt + 45 min`. Producer every 60 s ± 15 s. Consumer every 30 s.
- Counter: `seq = max(seq + 1, Date.now())`, durable per user.
- Queued class `chat.send` only. Text 1 to 4000 chars. Request file at most 65,536 bytes. Age at most 24 h,
  and at most 10 min in the future. 5 per device per drain, 50 per device per day. Turn cap 10 min.
- Remote turns go only through `startHostTurn` (mode `auto_read_only`, phone chat). An approval request is never
  answered remotely: cancel, then reply `needs_approval`.
- Reply codes: `expired`, `quota`, `needs_approval`, `turn_failed`, `refused`, `stale_epoch`.
- Every kb helper takes `userId` first. Every multi-step write uses `db.transaction()`. Migrations are append-only (`0064`).
- ESLint layers (`extension/eslint.config.mjs`): `core` imports nothing internal; `kb` imports only `core`;
  `connectors` import L0 to L2; routes may import any Node layer; nothing imports a route except `server.mjs`. No exemptions.
- Never log keys, `es`, folder names (`dir`), decrypted content or the SSH private key. Logs carry counts and codes only.
- Bump `SERVER_API_VERSION` to 112 and add the new paths to `ALL_ENDPOINTS`.
- New dependency: `ssh2` exactly `1.17.0`, with a justification comment. No other new dependency.
- Tests: `cd extension && node --test tests/<file>`. Each test file sets `LLMIDE_DB_PATH` to its own `_…-test.db`,
  as `tests/host-api-devices.test.mjs` does.
- Commit on `main` (user rule), Conventional Commits, one concern per commit, with this trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File Structure

| File | New/Modify | Responsibility |
|---|---|---|
| `extension/core/sync-envelope.mjs` | create | sync v1 seal/open/subkeys/syncwrap (Node crypto only) |
| `schema/sync/v1/README.md` | create | the sync v1 wire delta over relay v1 |
| `scripts/sync-vectors.mjs` | create | builds and checks `schema/sync/v1/vectors/v1.json` with the independent `scripts/relay-reference.mjs` |
| `schema/sync/v1/vectors/v1.json` | create (generated) | shared vectors for Node now and WebCrypto/Swift later |
| `extension/tests/sync-envelope.test.mjs` | create | relay v1 + sync v1 vectors, negatives |
| `extension/kb/migrations/0064_sync.sql` | create | `sync_state`, `sync_devices`, `sync_published`, `sync_requests` |
| `extension/kb/sync-state.mjs` | create | the durable sync state helpers |
| `extension/tests/sync-state.test.mjs` | create | |
| `extension/server/vault.mjs` | **modify (shared)** | allow internal keys `sync.rootKey`, `sync.signingKey`, `sync.sshKey` |
| `extension/connectors/sync-store/index.mjs` | create | `checkPath`, `MAX_FILE_BYTES`, `createMemoryStore` |
| `extension/tests/helpers/sync-store-contract.mjs` | create | the contract suite every adapter runs |
| `extension/tests/sync-store-memory.test.mjs` | create | |
| `extension/connectors/sync-store/sftp.mjs` | create | the SFTP adapter, host-key pinning, key generation |
| `extension/tests/sync-store-sftp.test.mjs` | create | contract suite on a fake SFTP over a temp dir, plus an opt-in live run |
| `extension/package.json`, `extension/package-lock.json` | **modify (shared)** | `ssh2` 1.17.0 |
| `extension/routes/sync/kinds.mjs` | create | snapshot kinds: load, redact, clamp, fit |
| `extension/tests/sync-kinds.test.mjs` | create | |
| `extension/routes/sync/keys.mjs` | create | root/signing keys in the vault, ids |
| `extension/routes/sync/producer.mjs` | create | `publishOnce` |
| `extension/tests/sync-producer.test.mjs` | create | test device decrypts everything; blindness |
| `extension/routes/sync/consumer.mjs` | create | `drainOnce` at the read-only ceiling |
| `extension/tests/sync-consumer.test.mjs` | create | the permission/replay/age/quota matrix |
| `extension/routes/sync/scheduler.mjs` | create | the timers, store factory |
| `extension/routes/sync/http-routes.mjs` | create | `/kb/sync/*` for Settings |
| `extension/tests/sync-routes.test.mjs` | create | |
| `extension/server.mjs` | **modify (shared)** | dispatch, `ALL_ENDPOINTS`, version 112, rate bucket, scheduler start |
| `schema/http/sync.schema.json` + generated inventory/types/openapi | create / regenerate | contract gates |
| `ui/screens/settings/sync-model.ts` | create | decoders + calls |
| `ui/screens/settings/sections/SyncSection.tsx` | create | the Settings card |
| `ui/screens/settings/sections/MobileBridge.tsx` | **modify (shared)** | render `<SyncSection />` |
| `ui/screens/settings/tests/sync-section.test.mjs` | create | |
| `deploy/vps/sync-sftp.md`, `deploy/vps/sshd-llmidesync.conf`, `deploy/vps/llm-ide-sync.nginx.inc`, `deploy/vps/sync-check.sh` | create | server setup the user runs once |
| `deploy/vps/llm-ide.com.nginx` | **modify (shared)** | one `include` line + `limit_req_zone` |
| `extension/CLAUDE.md` | **modify (shared)** | a "Sync (desktop producer)" section |

**Shared-file edits (coordinate with other agents):** `extension/server.mjs`, `extension/server/vault.mjs`,
`extension/package.json`/`package-lock.json`, `ui/screens/settings/sections/MobileBridge.tsx`,
`deploy/vps/llm-ide.com.nginx`, `extension/CLAUDE.md`, the generated `schema/http/INVENTORY.md`, types and openapi.
**No file under `desktop/src-tauri/` is touched.**

---

### Task 1: Sync v1 envelope library and shared vectors

**Files:**
- Create: `extension/core/sync-envelope.mjs`
- Create: `scripts/sync-vectors.mjs`, `schema/sync/v1/README.md`, `schema/sync/v1/vectors/v1.json` (generated)
- Test: `extension/tests/sync-envelope.test.mjs`

**Interfaces:**
- Consumes: nothing internal.
- Produces (all `Buffer` in, `Buffer` or plain objects out):
  - `enc(fields: (number|string|Uint8Array)[]): Buffer`, `decodeEnc(buf, count): Buffer[]`
  - `pad(bytes): Buffer`, `unpad(buf): Buffer`, `sha256(...parts): Buffer`
  - `subkey(root, { userId, desktopId, purpose, epoch, sender, recipient }): Buffer` (32 bytes)
  - `deviceKeys(root, { userId, desktopId, deviceId }, epoch): { request, reply, snapshot, manifest }`
  - `seal({ header, key, plaintext, signingKey, nonce?, extra? }): Envelope` where `header = { purpose, userId, desktopId, from, to, epoch, session, seq, issuedAt, tier }`
  - `open({ env, key, verifyKey, expect? }): Buffer` (throws `SyncCryptoError` with `.code`)
  - `makeSyncWrap({ ids: { userId, desktopId, deviceId }, epoch, tier, deviceEcdhSpki, desktopSigningSpki, keys, signingKey, eph?, nonce?, seq, issuedAt }): Envelope`
  - `unwrapSync({ env, ecdhPrivate, deviceEcdhSpki, desktopSigningSpki, verifyKey, currentEpoch, deviceId }): { request, reply, snapshot, manifest }`
  - `spkiFingerprint(spki): string` (base64url SHA-256), `newSigningKey(): { privateKey: KeyObject, publicKey: KeyObject, spki: Buffer, pkcs8: Buffer }`
  - `PURPOSES`, `BUCKETS`, `MAX_FRAME`, `SyncCryptoError`

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/sync-envelope.test.mjs
// Sync v1 = relay v1 bytes + snapshot/manifest/syncwrap. The relay v1 vectors prove the shared primitives are the same
// bytes; the sync v1 vectors (built by scripts/sync-vectors.mjs on the independent reference) prove the new purposes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as S from '../core/sync-envelope.mjs';

const relay = JSON.parse(readFileSync(new URL('../../schema/relay/v1/vectors/v1.json', import.meta.url)));
const sync = JSON.parse(readFileSync(new URL('../../schema/sync/v1/vectors/v1.json', import.meta.url)));
const hex = (s) => Buffer.from(s, 'hex');
const b = (s) => Buffer.from(s, 'base64url');
const priv = (s) => createPrivateKey({ key: b(s), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: b(s), format: 'der', type: 'spki' });

test('relay v1 vectors: canonical encoding, subkeys, padding and the request envelope are byte-identical', () => {
  assert.equal(S.enc([1, 'ab', '']).toString('hex'), relay.canonical.hex);
  const k = S.deviceKeys(hex(relay.subkeys.rootHex), relay.subkeys.ids, relay.subkeys.epoch);
  assert.equal(k.request.toString('hex'), relay.subkeys.requestHex);
  assert.equal(k.reply.toString('hex'), relay.subkeys.replyHex);
  assert.equal(S.pad(Buffer.from(relay.envelope.frame)).length, relay.padding.bucket);
  const env = relay.envelope.env;
  assert.equal(S.open({ env, key: k.request, verifyKey: pub(relay.keys.deviceSigningSpki) }).toString(), relay.envelope.frame);
  const again = S.seal({ header: relay.envelope.header, key: k.request, plaintext: Buffer.from(relay.envelope.frame), signingKey: priv(relay.keys.deviceSigningPkcs8), nonce: hex(relay.envelope.nonceHex) });
  assert.equal(again.ct, env.ct);
});

test('relay v1 negatives fail closed in the sync port', () => {
  const k = S.deviceKeys(hex(relay.subkeys.rootHex), relay.subkeys.ids, relay.subkeys.epoch);
  for (const n of relay.negatives) {
    const env = structuredClone(relay.envelope.env);
    const [op, rest] = n.split(/:(.*)/s);
    if (op === 'flip') { const x = b(env[rest]); x[0] ^= 1; env[rest] = x.toString('base64url'); }
    else if (op === 'truncate') { env[rest] = b(env[rest]).subarray(0, -1).toString('base64url'); }
    else { const [key, val] = rest.split('='); env[key] = /^[0-9]+$/.test(val) ? Number(val) : val; }
    assert.throws(() => S.open({ env, key: k.request, verifyKey: pub(relay.keys.deviceSigningSpki) }), S.SyncCryptoError, n);
  }
});

test('sync v1 vectors: snapshot and manifest open with the derived per-device keys', () => {
  const k = S.deviceKeys(hex(sync.rootHex), sync.ids, sync.epoch);
  assert.equal(k.snapshot.toString('hex'), sync.snapshotKeyHex);
  assert.equal(k.manifest.toString('hex'), sync.manifestKeyHex);
  const vk = pub(sync.keys.desktopSigningSpki);
  assert.equal(S.open({ env: sync.snapshot.env, key: k.snapshot, verifyKey: vk, expect: { purpose: 'snapshot' } }).toString(), sync.snapshot.plaintext);
  assert.equal(S.open({ env: sync.manifest.env, key: k.manifest, verifyKey: vk, expect: { purpose: 'manifest' } }).toString(), sync.manifest.plaintext);
  assert.throws(() => S.open({ env: sync.snapshot.env, key: k.manifest, verifyKey: vk }), /bad_ciphertext/, 'one key per purpose');
  assert.throws(() => S.open({ env: sync.snapshot.env, key: k.snapshot, verifyKey: vk, expect: { purpose: 'manifest' } }), /bad_purpose/);
});

test('syncwrap: our wrap equals the vector ciphertext, unwraps to the four keys, and a forged signer is refused', () => {
  const k = S.deviceKeys(hex(sync.rootHex), sync.ids, sync.epoch);
  const w = S.makeSyncWrap({ ids: sync.ids, epoch: sync.epoch, tier: 'web', deviceEcdhSpki: b(sync.keys.deviceEcdhSpki), desktopSigningSpki: b(sync.keys.desktopSigningSpki),
    keys: k, signingKey: priv(sync.keys.desktopSigningPkcs8), eph: { privateKey: priv(sync.keys.ephPkcs8), publicKey: pub(sync.keys.ephSpki) }, nonce: Buffer.alloc(12, 0x55), seq: 11, issuedAt: 1762300000002 });
  assert.equal(w.ct, sync.syncwrap.env.ct);
  const opts = { ecdhPrivate: priv(sync.keys.deviceEcdhPkcs8), deviceEcdhSpki: b(sync.keys.deviceEcdhSpki), desktopSigningSpki: b(sync.keys.desktopSigningSpki), verifyKey: pub(sync.keys.desktopSigningSpki), currentEpoch: sync.epoch - 1, deviceId: sync.ids.deviceId };
  const got = S.unwrapSync({ env: sync.syncwrap.env, ...opts });
  for (const name of ['request', 'reply', 'snapshot', 'manifest']) assert.equal(got[name].toString('hex'), k[name].toString('hex'));
  assert.throws(() => S.unwrapSync({ env: sync.syncwrap.env, ...opts, currentEpoch: sync.epoch }), /stale_epoch/);
  const rogue = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => S.unwrapSync({ env: sync.syncwrap.env, ...opts, verifyKey: rogue.publicKey }), /bad_signature/);
});

test('open refuses unknown envelope fields, unknown purposes and an over-cap frame', () => {
  const k = S.deviceKeys(hex(sync.rootHex), sync.ids, sync.epoch);
  const vk = pub(sync.keys.desktopSigningSpki);
  assert.throws(() => S.open({ env: { ...sync.snapshot.env, extra: 1 }, key: k.snapshot, verifyKey: vk }), /bad_envelope/);
  assert.throws(() => S.open({ env: { ...sync.snapshot.env, purpose: 'wrap' }, key: k.snapshot, verifyKey: vk }), /bad_purpose/);
  assert.throws(() => S.pad(Buffer.alloc(S.MAX_FRAME + 1)), /frame_too_large/);
  assert.equal(S.spkiFingerprint(b(sync.keys.desktopSigningSpki)), sync.desktopSigningFingerprint);
});
```

- [ ] **Step 2: Write the vectors generator and produce the vectors**

```js
// scripts/sync-vectors.mjs
// node scripts/sync-vectors.mjs          check schema/sync/v1/vectors/v1.json (exit 1 on mismatch)
// node scripts/sync-vectors.mjs --write  regenerate it
// Built on the independent reference (scripts/relay-reference.mjs), never on extension/core/sync-envelope.mjs, so the
// shipped module is checked against a second implementation. Keys are reused from the relay v1 vectors.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, verify } from 'node:crypto';
import * as R from './relay-reference.mjs';

const RELAY = JSON.parse(readFileSync(new URL('../schema/relay/v1/vectors/v1.json', import.meta.url)));
const FILE = new URL('../schema/sync/v1/vectors/v1.json', import.meta.url);
const hex = (x) => Buffer.from(x).toString('hex');
const b = (s) => Buffer.from(s, 'base64url');
const priv = (s) => createPrivateKey({ key: b(s), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: b(s), format: 'der', type: 'spki' });
const sha = (...p) => createHash('sha256').update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest();

function build(previous) {
  const keys = RELAY.keys;
  const ids = { userId: 'user-AAAAAAAAAAAAAAAAAAAAAA', desktopId: 'BBBBBBBBBBBBBBBBBBBBBB', deviceId: 'h1-00000000-0000-4000-8000-000000000001' };
  const epoch = 3;
  const root = Buffer.alloc(32, 0x66);
  const sk = (purpose, sender, recipient) => R.subkey(root, { userId: ids.userId, desktopId: ids.desktopId, purpose, epoch, sender, recipient });
  const k = { request: sk('request', ids.deviceId, ids.desktopId), reply: sk('reply', ids.desktopId, ids.deviceId),
    snapshot: sk('snapshot', ids.desktopId, ids.deviceId), manifest: sk('manifest', ids.desktopId, ids.deviceId) };
  const hdr = (purpose, seq, tier = '') => ({ purpose, userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq, issuedAt: 1762300000000 + seq, tier });
  const snapPlain = '{"v":1,"kind":"chats","generatedAt":1762300000000,"truncated":false,"items":[]}';
  const manPlain = '{"v":1,"manifestSeq":10,"epoch":3,"generatedAt":1762300000000,"validUntil":1762302700000,"kinds":{}}';
  const signingKey = priv(keys.desktopSigningPkcs8);
  const snapshot = previous?.snapshot.env ?? R.seal({ header: hdr('snapshot', 9), key: k.snapshot, plaintext: Buffer.from(snapPlain), signingKey, nonce: Buffer.alloc(12, 0x44) });
  const manifest = previous?.manifest.env ?? R.seal({ header: hdr('manifest', 10), key: k.manifest, plaintext: Buffer.from(manPlain), signingKey, nonce: Buffer.alloc(12, 0x45) });
  // syncwrap: the relay wrap construction with the label "llmide/syncwrap/v1" and four keys.
  const ephSpki = b(keys.ephSpki); const devSpki = b(keys.deviceEcdhSpki); const deskSpki = b(keys.desktopSigningSpki);
  const z = diffieHellman({ privateKey: priv(keys.ephPkcs8), publicKey: pub(keys.deviceEcdhSpki) });
  const wrapKey = Buffer.from(hkdfSync('sha256', z, sha(R.enc([ephSpki, devSpki])), R.enc(['llmide/syncwrap/v1', epoch, ids.deviceId, sha(devSpki), sha(deskSpki), 'web']), 32));
  const wrapHeader = { purpose: 'syncwrap', userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq: 11, issuedAt: 1762300000002, tier: 'web' };
  const syncwrap = previous?.syncwrap.env ?? R.seal({ header: wrapHeader, key: wrapKey, plaintext: R.enc([k.request, k.reply, k.snapshot, k.manifest]), signingKey, nonce: Buffer.alloc(12, 0x55), extra: ephSpki });
  return {
    v: 1, ids, epoch, rootHex: hex(root),
    keys: { desktopSigningPkcs8: keys.desktopSigningPkcs8, desktopSigningSpki: keys.desktopSigningSpki, deviceEcdhPkcs8: keys.deviceEcdhPkcs8, deviceEcdhSpki: keys.deviceEcdhSpki, ephPkcs8: keys.ephPkcs8, ephSpki: keys.ephSpki },
    desktopSigningFingerprint: sha(deskSpki).toString('base64url'),
    requestKeyHex: hex(k.request), replyKeyHex: hex(k.reply), snapshotKeyHex: hex(k.snapshot), manifestKeyHex: hex(k.manifest),
    snapshot: { plaintext: snapPlain, env: snapshot }, manifest: { plaintext: manPlain, env: manifest }, syncwrap: { env: syncwrap },
  };
}

const write = process.argv.includes('--write');
let current = null;
try { current = JSON.parse(readFileSync(FILE)); } catch { /* first run */ }
const next = build(write ? null : current);
if (write) {
  mkdirSync(new URL('.', FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  console.log('wrote', FILE.pathname);
} else {
  // ECDSA is randomized: deterministic fields are recomputed, signatures are verify-only.
  const same = JSON.stringify(next) === JSON.stringify(current);
  const sigOk = ['snapshot', 'manifest', 'syncwrap'].every((n) => {
    const e = current[n].env;
    const extra = e.eph ? b(e.eph) : Buffer.alloc(0);
    return verify('sha256', Buffer.concat([Buffer.from(`llmide/${e.purpose}/v1\0`), R.enc([...R.headerFields(e), extra, b(e.nonce), b(e.ct)])]), { key: pub(current.keys.desktopSigningSpki), dsaEncoding: 'ieee-p1363' }, b(e.sig));
  });
  if (!same || !sigOk) { console.error('sync v1 vectors out of date: run node scripts/sync-vectors.mjs --write'); process.exit(1); }
  console.log('sync v1 vectors ok');
}
```

Run: `node scripts/sync-vectors.mjs --write && node scripts/sync-vectors.mjs`
Expected: `wrote …/schema/sync/v1/vectors/v1.json`, then `sync v1 vectors ok`.

- [ ] **Step 3: Write `schema/sync/v1/README.md`**

```markdown
# Sync v1 wire and crypto

Design: docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md. Sync v1 is relay v1 (schema/relay/v1/README.md)
byte for byte, plus the purposes below. Any change bumps `v` and the vectors (`node scripts/sync-vectors.mjs --write`).

| Purpose | From → to | Key |
|---|---|---|
| request | device → desktop | subkey("request", deviceId → desktopId) (relay v1) |
| reply | desktop → device | subkey("reply", desktopId → deviceId) (relay v1) |
| snapshot | desktop → device | subkey("snapshot", desktopId → deviceId) |
| manifest | desktop → device | subkey("manifest", desktopId → deviceId) |
| syncwrap | desktop → device | relay wrap with info label "llmide/syncwrap/v1"; plaintext enc([request, reply, snapshot, manifest]) |

`desktopId` is the syncId (22 base64url chars). `session` is "" and `tier` is "web" or "ios" on a syncwrap, "" otherwise.
Snapshot, manifest, request and reply plaintexts are UTF-8 JSON with closed schemas (design sections 4.2 to 4.4).
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-envelope.test.mjs`
Expected: FAIL with `Cannot find module '…/core/sync-envelope.mjs'`.

- [ ] **Step 5: Write the implementation**

```js
// extension/core/sync-envelope.mjs
// Sync v1 envelope (schema/sync/v1): relay v1 bytes (schema/relay/v1) plus the purposes snapshot, manifest and
// syncwrap. A shipped port of scripts/relay-reference.mjs; checked against both vector files. Node crypto only.
// Verify before decrypt; unknown fields, purposes and versions fail closed.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';

export const VERSION = 1;
export const BUCKETS = Object.freeze([1024, 4096, 16384, 65536, 262144, 1048576]);
export const MAX_FRAME = BUCKETS.at(-1) - 4;
export const PURPOSES = Object.freeze(['request', 'reply', 'snapshot', 'manifest', 'syncwrap']);
const ID_KEYS = ['purpose', 'userId', 'desktopId', 'from', 'to', 'epoch', 'session', 'seq', 'issuedAt', 'tier'];
const ENV_KEYS = new Set(['v', ...ID_KEYS, 'nonce', 'ct', 'sig', 'eph']);
const B64U = /^[A-Za-z0-9_-]*$/;

export class SyncCryptoError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'SyncCryptoError'; }
}
const fail = (code) => { throw new SyncCryptoError(code); };
const context = (purpose) => Buffer.from(`llmide/${purpose}/v1\0`);
const b64 = (s) => (typeof s === 'string' && B64U.test(s) ? Buffer.from(s, 'base64url') : fail('bad_base64'));
export const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

export function enc(fields) {
  return Buffer.concat(fields.flatMap((f) => {
    let v;
    if (typeof f === 'number' || typeof f === 'bigint') {
      if (typeof f === 'number' && (!Number.isSafeInteger(f) || f < 0)) fail('bad_integer');
      v = Buffer.alloc(8); v.writeBigUInt64BE(BigInt(f));
    } else if (typeof f === 'string') v = Buffer.from(f, 'utf8');
    else v = Buffer.from(f);
    const len = Buffer.alloc(4); len.writeUInt32BE(v.length);
    return [len, v];
  }));
}

export function decodeEnc(buf, count) {
  const out = []; let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) fail('bad_encoding');
    const n = buf.readUInt32BE(off); off += 4;
    if (off + n > buf.length) fail('bad_encoding');
    out.push(buf.subarray(off, off + n)); off += n;
  }
  if (out.length !== count) fail('bad_encoding');
  return out;
}

export const headerFields = (h) => [VERSION, h.purpose, h.userId, h.desktopId, h.from, h.to, h.epoch, h.session, h.seq, h.issuedAt, h.tier];
const headerOf = (env) => Object.fromEntries(ID_KEYS.map((k) => [k, env[k]]));

export function pad(bytes) {
  const body = Buffer.from(bytes);
  if (body.length > MAX_FRAME) fail('frame_too_large');
  const out = Buffer.alloc(BUCKETS.find((s) => s >= body.length + 4));
  out.writeUInt32BE(body.length); body.copy(out, 4);
  return out;
}

export function unpad(buf) {
  if (!BUCKETS.includes(buf.length)) fail('bad_padding');
  const n = buf.readUInt32BE(0);
  if (n > buf.length - 4) fail('bad_padding');
  for (let i = 4 + n; i < buf.length; i++) if (buf[i] !== 0) fail('bad_padding');
  return buf.subarray(4, 4 + n);
}

const salt = (userId, desktopId) => sha256(Buffer.from('llmide-relay-v1'), enc([userId, desktopId]));

export function subkey(root, { userId, desktopId, purpose, epoch, sender, recipient }) {
  return Buffer.from(hkdfSync('sha256', root, salt(userId, desktopId), enc([purpose, epoch, '', sender, recipient]), 32));
}

export function deviceKeys(root, { userId, desktopId, deviceId }, epoch) {
  const k = (purpose, sender, recipient) => subkey(root, { userId, desktopId, purpose, epoch, sender, recipient });
  return { request: k('request', deviceId, desktopId), reply: k('reply', desktopId, deviceId),
    snapshot: k('snapshot', desktopId, deviceId), manifest: k('manifest', desktopId, deviceId) };
}

export function seal({ header, key, plaintext, signingKey, nonce = randomBytes(12), extra = Buffer.alloc(0) }) {
  if (!PURPOSES.includes(header.purpose)) fail('bad_purpose');
  const fields = headerFields(header);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(enc([...fields, extra]));
  const ct = Buffer.concat([c.update(pad(plaintext)), c.final(), c.getAuthTag()]);
  const sig = sign('sha256', Buffer.concat([context(header.purpose), enc([...fields, extra, nonce, ct])]), { key: signingKey, dsaEncoding: 'ieee-p1363' });
  return { v: VERSION, ...headerOf(header), nonce: nonce.toString('base64url'), ct: ct.toString('base64url'), sig: sig.toString('base64url'), ...(extra.length ? { eph: extra.toString('base64url') } : {}) };
}

export function open({ env, key, verifyKey, expect = {} }) {
  if (!env || typeof env !== 'object' || Object.keys(env).some((k) => !ENV_KEYS.has(k))) fail('bad_envelope');
  if (env.v !== VERSION) fail('bad_version');
  if (!PURPOSES.includes(env.purpose)) fail('bad_purpose');
  const header = headerOf(env);
  for (const [k, v] of Object.entries(expect)) if (header[k] !== v) fail(`bad_${k}`);
  const extra = env.eph ? b64(env.eph) : Buffer.alloc(0);
  const nonce = b64(env.nonce); const ct = b64(env.ct);
  if (nonce.length !== 12 || ct.length < 16 + BUCKETS[0]) fail('bad_ciphertext');
  const fields = headerFields(header);
  let ok = false;
  try { ok = verify('sha256', Buffer.concat([context(env.purpose), enc([...fields, extra, nonce, ct])]), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, b64(env.sig)); } catch { ok = false; }
  if (!ok) fail('bad_signature');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(enc([...fields, extra])); d.setAuthTag(ct.subarray(-16));
  let pt;
  try { pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]); } catch { fail('bad_ciphertext'); }
  return unpad(pt);
}

function syncWrapKey({ z, ephSpki, deviceEcdhSpki, epoch, deviceId, desktopSigningSpki, tier }) {
  return Buffer.from(hkdfSync('sha256', z, sha256(enc([ephSpki, deviceEcdhSpki])),
    enc(['llmide/syncwrap/v1', epoch, deviceId, sha256(deviceEcdhSpki), sha256(desktopSigningSpki), tier]), 32));
}

export function makeSyncWrap({ ids, epoch, tier, deviceEcdhSpki, desktopSigningSpki, keys, signingKey, eph = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), nonce, seq, issuedAt }) {
  if (tier !== 'web' && tier !== 'ios') fail('bad_tier');
  const ephSpki = eph.publicKey.export({ type: 'spki', format: 'der' });
  const z = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: deviceEcdhSpki, format: 'der', type: 'spki' }) });
  const key = syncWrapKey({ z, ephSpki, deviceEcdhSpki, epoch, deviceId: ids.deviceId, desktopSigningSpki, tier });
  z.fill(0);
  const header = { purpose: 'syncwrap', userId: ids.userId, desktopId: ids.desktopId, from: ids.desktopId, to: ids.deviceId, epoch, session: '', seq, issuedAt, tier };
  return seal({ header, key, plaintext: enc([keys.request, keys.reply, keys.snapshot, keys.manifest]), signingKey, extra: ephSpki, ...(nonce ? { nonce } : {}) });
}

/** Device side; shipped for tests and for a future Node device. Verifies the desktop signature first. */
export function unwrapSync({ env, ecdhPrivate, deviceEcdhSpki, desktopSigningSpki, verifyKey, currentEpoch, deviceId }) {
  if (env?.purpose !== 'syncwrap' || !env.eph) fail('bad_purpose');
  if (env.to !== deviceId) fail('bad_to');
  if (!(env.epoch > currentEpoch)) fail('stale_epoch');
  const ephSpki = b64(env.eph);
  const z = diffieHellman({ privateKey: ecdhPrivate, publicKey: createPublicKey({ key: ephSpki, format: 'der', type: 'spki' }) });
  const key = syncWrapKey({ z, ephSpki, deviceEcdhSpki, epoch: env.epoch, deviceId, desktopSigningSpki, tier: env.tier });
  const parts = decodeEnc(open({ env, key, verifyKey, expect: { purpose: 'syncwrap' } }), 4);
  if (parts.some((p) => p.length !== 32)) fail('bad_wrap');
  const [request, reply, snapshot, manifest] = parts.map((p) => Buffer.from(p));
  return { request, reply, snapshot, manifest };
}

export const spkiFingerprint = (spki) => sha256(spki).toString('base64url');

export function newSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicKey, spki: publicKey.export({ type: 'spki', format: 'der' }), pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }) };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-envelope.test.mjs && node ../scripts/sync-vectors.mjs`
Expected: 5 tests PASS; `sync v1 vectors ok`.

- [ ] **Step 7: Commit**

```bash
git add extension/core/sync-envelope.mjs extension/tests/sync-envelope.test.mjs scripts/sync-vectors.mjs schema/sync/v1
git commit -m "feat(sync): sync v1 envelope on relay v1 bytes with shared vectors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Durable sync state (migration 0064) and vault keys

**Files:**
- Create: `extension/kb/migrations/0064_sync.sql`, `extension/kb/sync-state.mjs`
- Modify: `extension/server/vault.mjs` (the `ALLOWED_KEYS` set near line 110 and `INTERNAL_KEYS` at line 202)
- Test: `extension/tests/sync-state.test.mjs`

**Interfaces:**
- Consumes: `getDb`, `requireUser` from `kb/db.mjs`.
- Produces:
  - `getSyncState(userId): null | { syncId, enabled, storeKind, storeConfig, epoch, seq, lastPublishAt, lastError }`
  - `ensureSyncState(userId, { storeKind, storeConfig }): state` (creates the syncId on first call; later calls replace the store fields)
  - `setSyncEnabled(userId, enabled: boolean): void`, `setEpoch(userId, epoch: number): void`
  - `nextSeq(userId, now = Date.now()): number`
  - `recordPublish(userId, { at, error = null }): void`
  - `listEnabledSyncUsers(): string[]`
  - `addSyncDevice(userId, { deviceId, dir, tier, name, ecdhSpki: Buffer, signingSpki: Buffer, now }): void`
  - `listSyncDevices(userId): { deviceId, dir, tier, name, ecdhSpki: Buffer, signingSpki: Buffer, addedAt, wrapEpoch }[]`
  - `setDeviceWrapEpoch(userId, deviceId, epoch): void`
  - `getPublished(userId, deviceId): Record<kind, { file, seq, fileSha256, plainSha256, epoch }>`
  - `setPublished(userId, deviceId, kind, { file, seq, fileSha256, plainSha256, epoch }): void`
  - `recordRequest(userId, deviceId, requestId, now): boolean` (true = first time)
  - `finishRequest(userId, deviceId, requestId, state: 'done'|'failed'): void`
  - `countRequestsSince(userId, deviceId, sinceMs): number`
  - Vault internal keys `sync.rootKey`, `sync.signingKey`, `sync.sshKey` (readable through `getSecret`/`setSecret`, never client-settable or listed)

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/sync-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-state-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const vault = await import('../server/vault.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sync-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 's' }).id;

test('ensureSyncState mints one syncId and keeps it across store changes', () => {
  const u = user();
  assert.equal(st.getSyncState(u), null);
  const a = st.ensureSyncState(u, { storeKind: 'sftp', storeConfig: { host: 'h.example', port: 22 } });
  assert.match(a.syncId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(a.enabled, false);
  assert.equal(a.epoch, 1);
  const b = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  assert.equal(b.syncId, a.syncId);
  assert.equal(b.storeKind, 'memory');
  st.setSyncEnabled(u, true);
  assert.ok(st.listEnabledSyncUsers().includes(u));
});

test('nextSeq is monotonic and at least the clock', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  const a = st.nextSeq(u, 1000);
  const b = st.nextSeq(u, 500);
  const c = st.nextSeq(u, 5000);
  assert.deepEqual([a, b, c], [1000, 1001, 5000]);
});

test('devices, published entries and requests are per user', () => {
  const u = user(); const v = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.addSyncDevice(u, { deviceId: 'h1-a', dir: 'D'.repeat(22), tier: 'web', name: 'Phone', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  assert.equal(st.listSyncDevices(u).length, 1);
  assert.equal(st.listSyncDevices(v).length, 0);
  st.setPublished(u, 'h1-a', 'chats', { file: 's/' + 'a'.repeat(32) + '.bin', seq: 5, fileSha256: 'f', plainSha256: 'p', epoch: 1 });
  assert.equal(st.getPublished(u, 'h1-a').chats.seq, 5);
  assert.deepEqual(st.getPublished(v, 'h1-a'), {});
  assert.equal(st.recordRequest(u, 'h1-a', 'R'.repeat(22), 10), true);
  assert.equal(st.recordRequest(u, 'h1-a', 'R'.repeat(22), 11), false, 'second record is a replay');
  assert.equal(st.countRequestsSince(u, 'h1-a', 0), 1);
  st.finishRequest(u, 'h1-a', 'R'.repeat(22), 'done');
});

test('sync vault keys are internal: storable by the server, not client-settable', () => {
  const u = user();
  vault.setSecret(kb.getDb(), u, 'sync.rootKey', 'x'.repeat(43));
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.rootKey'), 'x'.repeat(43));
  for (const k of ['sync.rootKey', 'sync.signingKey', 'sync.sshKey']) {
    assert.equal(vault.isUserSettableVaultKey(k), false);
    assert.ok(!vault.VAULT_KEYS.includes(k));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-state.test.mjs`
Expected: FAIL with `Cannot find module '…/kb/sync-state.mjs'`.

- [ ] **Step 3: Write the migration**

```sql
-- extension/kb/migrations/0064_sync.sql
-- Encrypted sync through user-owned storage (docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md).
-- Additive, N-1 safe. No key or secret is stored here: keys live in the vault (sync.rootKey, sync.signingKey,
-- sync.sshKey). store_config is non-secret (host, port, username, host-key fingerprint).
CREATE TABLE IF NOT EXISTS sync_state (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sync_id         TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0,
  store_kind      TEXT NOT NULL CHECK (store_kind IN ('memory','sftp','box','mega')),
  store_config    TEXT NOT NULL DEFAULT '{}',
  epoch           INTEGER NOT NULL DEFAULT 1,
  seq             INTEGER NOT NULL DEFAULT 0,
  last_publish_at INTEGER,
  last_error      TEXT
);
CREATE TABLE IF NOT EXISTS sync_devices (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  dir          TEXT NOT NULL,
  tier         TEXT NOT NULL CHECK (tier IN ('web','ios')),
  name         TEXT NOT NULL,
  ecdh_spki    BLOB NOT NULL,
  signing_spki BLOB NOT NULL,
  added_at     INTEGER NOT NULL,
  wrap_epoch   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, device_id),
  UNIQUE (user_id, dir)
);
CREATE TABLE IF NOT EXISTS sync_published (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  file         TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  file_sha256  TEXT NOT NULL,
  plain_sha256 TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, kind)
);
CREATE TABLE IF NOT EXISTS sync_requests (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('running','done','failed')),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_requests_age ON sync_requests(user_id, device_id, received_at);
```

- [ ] **Step 4: Write `extension/kb/sync-state.mjs`**

```js
// extension/kb/sync-state.mjs
// Durable state for encrypted sync (migration 0064). Every helper takes userId first. No key material here: the
// vault holds it. store_config is non-secret JSON.
import { randomBytes } from 'node:crypto';
import { getDb, requireUser } from './db.mjs';

const parse = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const rowToState = (r) => r && ({
  syncId: r.sync_id, enabled: r.enabled === 1, storeKind: r.store_kind, storeConfig: parse(r.store_config),
  epoch: r.epoch, seq: r.seq, lastPublishAt: r.last_publish_at ?? null, lastError: r.last_error ?? null,
});

export function getSyncState(userId) {
  requireUser(userId);
  return rowToState(getDb().prepare('SELECT * FROM sync_state WHERE user_id = ?').get(userId)) ?? null;
}

export function ensureSyncState(userId, { storeKind, storeConfig }) {
  requireUser(userId);
  const db = getDb();
  db.prepare(`INSERT INTO sync_state (user_id, sync_id, store_kind, store_config) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET store_kind = excluded.store_kind, store_config = excluded.store_config`)
    .run(userId, randomBytes(16).toString('base64url'), storeKind, JSON.stringify(storeConfig ?? {}));
  return getSyncState(userId);
}

export function setSyncEnabled(userId, enabled) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_state SET enabled = ? WHERE user_id = ?').run(enabled ? 1 : 0, userId);
}

export function setEpoch(userId, epoch) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_state SET epoch = ? WHERE user_id = ?').run(epoch, userId);
}

/** Hybrid counter (relay design 4.3): monotonic, and never behind the clock, so a restored DB cannot replay a seq. */
export function nextSeq(userId, now = Date.now()) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const { seq } = db.prepare('SELECT seq FROM sync_state WHERE user_id = ?').get(userId);
    const next = Math.max(seq + 1, Math.floor(now));
    db.prepare('UPDATE sync_state SET seq = ? WHERE user_id = ?').run(next, userId);
    return next;
  })();
}

export function recordPublish(userId, { at, error = null }) {
  requireUser(userId);
  if (error) getDb().prepare('UPDATE sync_state SET last_error = ? WHERE user_id = ?').run(String(error).slice(0, 200), userId);
  else getDb().prepare('UPDATE sync_state SET last_publish_at = ?, last_error = NULL WHERE user_id = ?').run(at, userId);
}

export function listEnabledSyncUsers() {
  return getDb().prepare('SELECT user_id FROM sync_state WHERE enabled = 1').all().map((r) => r.user_id);
}

export function addSyncDevice(userId, { deviceId, dir, tier, name, ecdhSpki, signingSpki, now = Date.now() }) {
  requireUser(userId);
  getDb().prepare('INSERT INTO sync_devices (user_id, device_id, dir, tier, name, ecdh_spki, signing_spki, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, deviceId, dir, tier, String(name).slice(0, 120), Buffer.from(ecdhSpki), Buffer.from(signingSpki), now);
}

export function listSyncDevices(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT * FROM sync_devices WHERE user_id = ? ORDER BY added_at').all(userId).map((r) => ({
    deviceId: r.device_id, dir: r.dir, tier: r.tier, name: r.name, ecdhSpki: Buffer.from(r.ecdh_spki),
    signingSpki: Buffer.from(r.signing_spki), addedAt: r.added_at, wrapEpoch: r.wrap_epoch,
  }));
}

export function setDeviceWrapEpoch(userId, deviceId, epoch) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_devices SET wrap_epoch = ? WHERE user_id = ? AND device_id = ?').run(epoch, userId, deviceId);
}

export function getPublished(userId, deviceId) {
  requireUser(userId);
  const out = {};
  for (const r of getDb().prepare('SELECT * FROM sync_published WHERE user_id = ? AND device_id = ?').all(userId, deviceId)) {
    out[r.kind] = { file: r.file, seq: r.seq, fileSha256: r.file_sha256, plainSha256: r.plain_sha256, epoch: r.epoch };
  }
  return out;
}

export function setPublished(userId, deviceId, kind, { file, seq, fileSha256, plainSha256, epoch }) {
  requireUser(userId);
  getDb().prepare(`INSERT INTO sync_published (user_id, device_id, kind, file, seq, file_sha256, plain_sha256, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(user_id, device_id, kind) DO UPDATE SET file = excluded.file, seq = excluded.seq,
                   file_sha256 = excluded.file_sha256, plain_sha256 = excluded.plain_sha256, epoch = excluded.epoch`)
    .run(userId, deviceId, kind, file, seq, fileSha256, plainSha256, epoch);
}

/** Record-before-execute (relay design 5.2 step 5): true only the first time this request id is seen. */
export function recordRequest(userId, deviceId, requestId, now = Date.now()) {
  requireUser(userId);
  return getDb().prepare("INSERT OR IGNORE INTO sync_requests (user_id, device_id, request_id, state, received_at) VALUES (?, ?, ?, 'running', ?)")
    .run(userId, deviceId, requestId, now).changes === 1;
}

export function finishRequest(userId, deviceId, requestId, state) {
  requireUser(userId);
  getDb().prepare('UPDATE sync_requests SET state = ? WHERE user_id = ? AND device_id = ? AND request_id = ?').run(state, userId, deviceId, requestId);
}

export function countRequestsSince(userId, deviceId, sinceMs) {
  requireUser(userId);
  return getDb().prepare('SELECT COUNT(*) n FROM sync_requests WHERE user_id = ? AND device_id = ? AND received_at >= ?').get(userId, deviceId, sinceMs).n;
}
```

- [ ] **Step 5: Add the vault keys**

In `extension/server/vault.mjs`, add three entries at the end of the `ALLOWED_KEYS` set (after `'email.imapPasswordHost'`), and extend `INTERNAL_KEYS`:

```js
  // Encrypted sync (routes/sync/keys.mjs): the per-epoch root key, the desktop ECDSA P-256 signing key (PKCS8) and
  // the ed25519 SSH key for the own-server adapter, and its public authorized_keys line (not secret, but no client may
  // overwrite it). Server-internal: never client-settable, never listed.
  'sync.rootKey',
  'sync.signingKey',
  'sync.sshKey',
  'sync.sshPublic',
```

```js
const INTERNAL_KEYS = new Set(['email.imapPasswordHost', 'sync.rootKey', 'sync.signingKey', 'sync.sshKey', 'sync.sshPublic']);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-state.test.mjs tests/vault.test.mjs`
Expected: PASS (4 new tests; vault tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add extension/kb/migrations/0064_sync.sql extension/kb/sync-state.mjs extension/tests/sync-state.test.mjs extension/server/vault.mjs
git commit -m "feat(sync): durable sync state and internal vault keys" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `SyncStore` interface, path rules, memory adapter, contract suite

**Files:**
- Create: `extension/connectors/sync-store/index.mjs`
- Create: `extension/tests/helpers/sync-store-contract.mjs`
- Test: `extension/tests/sync-store-memory.test.mjs`

**Interfaces:**
- Produces:
  - `MAX_FILE_BYTES = 1052672`
  - `checkPath(path: string): string[]` (returns the segments; throws `Error` with `code: 'SYNC_BAD_PATH'`)
  - `createMemoryStore(): SyncStore`, where `SyncStore = { put(path, bytes): Promise<void>, get(path): Promise<Uint8Array|null>, list(dir): Promise<{name,size,mtimeMs}[]>, remove(path): Promise<void>, removeTree(dir): Promise<void>, describe(): { kind, root } }`. The memory store also exposes `dump(): Map<string, Buffer>` for blindness tests.
  - `runSyncStoreContract(test, assert, makeStore: () => Promise<SyncStore>)`

- [ ] **Step 1: Write the contract suite and the failing test**

```js
// extension/tests/helpers/sync-store-contract.mjs
// The SyncStore contract (design 2.1). Every adapter's test file calls this with its own factory.
export function runSyncStoreContract(test, assert, makeStore, label) {
  test(`${label}: put/get round trip, absent file is null, replace is whole`, async () => {
    const s = await makeStore();
    assert.equal(await s.get('a/b/c.bin'), null);
    await s.put('a/b/c.bin', Buffer.from('one'));
    assert.equal(Buffer.from(await s.get('a/b/c.bin')).toString(), 'one');
    await s.put('a/b/c.bin', Buffer.from('second'));
    assert.equal(Buffer.from(await s.get('a/b/c.bin')).toString(), 'second');
  });
  test(`${label}: list is flat and sized; absent dir lists empty`, async () => {
    const s = await makeStore();
    await s.put('x/in/1.bin', Buffer.alloc(3));
    await s.put('x/in/2.bin', Buffer.alloc(5));
    await s.put('x/in/sub/3.bin', Buffer.alloc(1));
    const names = (await s.list('x/in')).filter((e) => e.name.endsWith('.bin')).map((e) => `${e.name}:${e.size}`).sort();
    assert.deepEqual(names, ['1.bin:3', '2.bin:5']);
    assert.deepEqual(await s.list('nope'), []);
  });
  test(`${label}: remove is idempotent; removeTree deletes everything below`, async () => {
    const s = await makeStore();
    await s.put('t/d/k.bin', Buffer.from('k'));
    await s.put('t/d/s/1.bin', Buffer.from('1'));
    await s.remove('t/d/k.bin');
    await s.remove('t/d/k.bin');
    assert.equal(await s.get('t/d/k.bin'), null);
    await s.removeTree('t/d');
    assert.equal(await s.get('t/d/s/1.bin'), null);
    assert.deepEqual(await s.list('t/d/s'), []);
  });
  test(`${label}: bad paths are refused before any I/O`, async () => {
    const s = await makeStore();
    for (const p of ['', '/a', 'a/../b', 'a/./b', 'a//b', 'a/b c', 'x'.repeat(65), '1/2/3/4/5/6/7']) {
      await assert.rejects(() => s.put(p, Buffer.from('x')), (e) => e.code === 'SYNC_BAD_PATH', p);
    }
    await assert.rejects(() => s.put('big.bin', Buffer.alloc(1052673)), (e) => e.code === 'SYNC_TOO_LARGE');
  });
}
```

```js
// extension/tests/sync-store-memory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, checkPath } from '../connectors/sync-store/index.mjs';
import { runSyncStoreContract } from './helpers/sync-store-contract.mjs';

runSyncStoreContract(test, assert, async () => createMemoryStore(), 'memory');

test('checkPath returns segments', () => {
  assert.deepEqual(checkPath('a/b.bin'), ['a', 'b.bin']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-store-memory.test.mjs`
Expected: FAIL with `Cannot find module '…/connectors/sync-store/index.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// extension/connectors/sync-store/index.mjs
// SyncStore: opaque encrypted files under validated relative paths (design 2.1). Adapters know nothing about keys or
// formats. Every adapter calls checkPath before any I/O.
export const MAX_FILE_BYTES = 1048576 + 4096;
const SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;

const err = (code, message) => Object.assign(new Error(message), { code });

export function checkPath(path) {
  const segs = typeof path === 'string' ? path.split('/') : [];
  if (segs.length < 1 || segs.length > 6 || segs.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) {
    throw err('SYNC_BAD_PATH', 'Invalid sync path');
  }
  return segs;
}

export function checkSize(bytes) {
  if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw err('SYNC_TOO_LARGE', 'Sync file too large');
}

/** In-memory adapter for tests. */
export function createMemoryStore() {
  const files = new Map(); // path -> { bytes, mtimeMs }
  return {
    async put(path, bytes) { checkPath(path); checkSize(bytes); files.set(path, { bytes: Buffer.from(bytes), mtimeMs: Date.now() }); },
    async get(path) { checkPath(path); const f = files.get(path); return f ? Buffer.from(f.bytes) : null; },
    async list(dir) {
      const prefix = `${checkPath(dir).join('/')}/`;
      const out = [];
      for (const [p, f] of files) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ name: p.slice(prefix.length), size: f.bytes.length, mtimeMs: f.mtimeMs });
      }
      return out;
    },
    async remove(path) { checkPath(path); files.delete(path); },
    async removeTree(dir) { const prefix = `${checkPath(dir).join('/')}/`; for (const p of [...files.keys()]) if (p.startsWith(prefix)) files.delete(p); },
    describe() { return { kind: 'memory', root: '' }; },
    dump() { return new Map([...files].map(([p, f]) => [p, f.bytes])); },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && node --test tests/sync-store-memory.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/connectors/sync-store/index.mjs extension/tests/helpers/sync-store-contract.mjs extension/tests/sync-store-memory.test.mjs
git commit -m "feat(sync): SyncStore contract with path rules and memory adapter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: SFTP adapter (own server) with host-key pinning

**Files:**
- Create: `extension/connectors/sync-store/sftp.mjs`
- Modify: `extension/package.json` (dependency), `extension/package-lock.json`
- Test: `extension/tests/sync-store-sftp.test.mjs`

**Interfaces:**
- Consumes: `checkPath`, `checkSize` (Task 3).
- Produces:
  - `hostKeyFingerprint(keyBlob: Buffer): string`, which gives `SHA256:<unpadded base64>`, the same as `ssh-keygen -lf`
  - `generateSshKey(comment: string): { privateKey: string, publicLine: string }`
  - `validateSftpConfig(cfg): string|null` (null = valid; otherwise the field name)
  - `createSftpStore({ host, port, username, hostKeySha256 }, { privateKey }, { connect? }): SyncStore`, with errors that carry `code` in `SYNC_HOST_KEY_MISMATCH | SYNC_AUTH_FAILED | SYNC_UNREACHABLE | SYNC_IO`

- [ ] **Step 1: Add the dependency**

```bash
cd extension && npm install --save-exact ssh2@1.17.0
```

In `extension/package.json`, add the justification next to the dependency list, under a `"//"` key, as the comment the
Global Constraints require (JSON has no comments):

```json
  "//": "ssh2 1.17.0: SFTP for the own-server sync adapter (connectors/sync-store/sftp.mjs); pure JS, MIT; optional native cpu-features only speeds it up. No other SSH code in the repo.",
```

Run: `cd extension && node -e "import('ssh2').then(m => console.log(typeof m.default.Client))"`
Expected: `function`. Confirm the license with `npm view ssh2@1.17.0 license` (expected `MIT`). If it prints nothing,
read `node_modules/ssh2/LICENSE`.

- [ ] **Step 2: Write the failing test**

```js
// extension/tests/sync-store-sftp.test.mjs
// The adapter runs the SyncStore contract on a fake SFTP session backed by a temp dir (same method surface ssh2's
// SFTPWrapper exposes). A live run against a real server is opt-in: LLMIDE_SYNC_SFTP_IT=user@host:port plus
// LLMIDE_SYNC_SFTP_IT_KEY=<path to OpenSSH private key> and LLMIDE_SYNC_SFTP_IT_HOSTKEY=SHA256:...
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSftpStore, hostKeyFingerprint, generateSshKey, validateSftpConfig } from '../connectors/sync-store/sftp.mjs';
import { runSyncStoreContract } from './helpers/sync-store-contract.mjs';

function fakeSftp(root) {
  const p = (x) => path.join(root, x);
  const wrap = (fn) => (...args) => { const cb = args.pop(); fn(...args).then((v) => cb(null, v), (e) => cb(Object.assign(e, { code: e.code === 'ENOENT' ? 2 : 4 }))); };
  return {
    readFile: wrap(async (f) => fs.promises.readFile(p(f))),
    writeFile: wrap(async (f, data) => fs.promises.writeFile(p(f), data)),
    readdir: wrap(async (d) => (await fs.promises.readdir(p(d), { withFileTypes: true })).map((e) => {
      const st = fs.statSync(path.join(p(d), e.name));
      return { filename: e.name, attrs: { size: st.size, mtime: Math.floor(st.mtimeMs / 1000), isDirectory: () => e.isDirectory() } };
    })),
    stat: wrap(async (f) => { const st = await fs.promises.stat(p(f)); return { size: st.size, isDirectory: () => st.isDirectory() }; }),
    mkdir: wrap(async (d) => fs.promises.mkdir(p(d))),
    unlink: wrap(async (f) => fs.promises.unlink(p(f))),
    rmdir: wrap(async (d) => fs.promises.rmdir(p(d))),
    ext_openssh_rename: wrap(async (a, b) => fs.promises.rename(p(a), p(b))),
  };
}

const CFG = { host: 'sync.example.com', port: 22, username: 'llmidesync', hostKeySha256: 'SHA256:' + 'A'.repeat(43) };

runSyncStoreContract(test, assert, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-store-'));
  return createSftpStore(CFG, { privateKey: 'unused' }, { connect: async () => ({ sftp: fakeSftp(root), end() {} }) });
}, 'sftp (fake session)');

test('hostKeyFingerprint matches the ssh-keygen SHA256 form', () => {
  const blob = Buffer.from('fake-host-key-blob');
  assert.equal(hostKeyFingerprint(blob), 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''));
});

test('generateSshKey makes an ed25519 key and an authorized_keys line', () => {
  const k = generateSshKey('llmide-sync-test');
  assert.match(k.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
  assert.match(k.publicLine, /^ssh-ed25519 [A-Za-z0-9+/=]+ llmide-sync-test$/);
});

test('validateSftpConfig names the bad field', () => {
  assert.equal(validateSftpConfig(CFG), null);
  assert.equal(validateSftpConfig({ ...CFG, host: 'bad host' }), 'host');
  assert.equal(validateSftpConfig({ ...CFG, port: 70000 }), 'port');
  assert.equal(validateSftpConfig({ ...CFG, username: 'Root;' }), 'username');
  assert.equal(validateSftpConfig({ ...CFG, hostKeySha256: 'MD5:aa' }), 'hostKeySha256');
});

test('a connect failure surfaces a coded error and never a key', async () => {
  const s = createSftpStore(CFG, { privateKey: 'SECRET-KEY' }, { connect: async () => { throw Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_MISMATCH' }); } });
  await assert.rejects(() => s.get('a.bin'), (e) => e.code === 'SYNC_HOST_KEY_MISMATCH' && !String(e.message).includes('SECRET-KEY'));
});

const IT = process.env.LLMIDE_SYNC_SFTP_IT;
test('live SFTP server (opt-in)', { skip: !IT }, async () => {
  const [username, hostPort] = IT.split('@');
  const [host, port] = hostPort.split(':');
  const s = createSftpStore({ host, port: Number(port || 22), username, hostKeySha256: process.env.LLMIDE_SYNC_SFTP_IT_HOSTKEY },
    { privateKey: fs.readFileSync(process.env.LLMIDE_SYNC_SFTP_IT_KEY, 'utf8') });
  await s.put('it-probe/x.bin', Buffer.from('ok'));
  assert.equal(Buffer.from(await s.get('it-probe/x.bin')).toString(), 'ok');
  await s.removeTree('it-probe');
  await s.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-store-sftp.test.mjs`
Expected: FAIL with `Cannot find module '…/connectors/sync-store/sftp.mjs'`.

- [ ] **Step 4: Write the implementation**

```js
// extension/connectors/sync-store/sftp.mjs
// SyncStore over SFTP to the user's own server (design 8.1). The host key is pinned to the fingerprint the user pasted
// from `ssh-keygen -lf` on the server: never trust-on-first-use. One connection is reused while busy and closed after
// IDLE_MS. Writes are atomic: temp file, then posix-rename. The private key is never logged or put in an error.
import { createHash, randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';
import { checkPath, checkSize, MAX_FILE_BYTES } from './index.mjs';

const { Client, utils } = ssh2;
const IDLE_MS = 20_000;
const READY_TIMEOUT_MS = 15_000;
const NO_SUCH_FILE = 2;
const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

const coded = (code, message) => Object.assign(new Error(message), { code });

export function hostKeyFingerprint(keyBlob) {
  return 'SHA256:' + createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
}

export function generateSshKey(comment) {
  const k = utils.generateKeyPairSync('ed25519', { comment });
  return { privateKey: k.private, publicLine: k.public.trim() };
}

export function validateSftpConfig(c) {
  if (!c || typeof c.host !== 'string' || !HOST_RE.test(c.host)) return 'host';
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return 'port';
  if (typeof c.username !== 'string' || !USER_RE.test(c.username)) return 'username';
  if (typeof c.hostKeySha256 !== 'string' || !FP_RE.test(c.hostKeySha256)) return 'hostKeySha256';
  return null;
}

function realConnect({ host, port, username, hostKeySha256 }, { privateKey }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let mismatch = false;
    conn.on('ready', () => conn.sftp((err, sftp) => (err ? (conn.end(), reject(coded('SYNC_IO', 'SFTP subsystem refused'))) : resolve({ sftp, end: () => conn.end() }))));
    conn.on('error', (e) => reject(mismatch ? coded('SYNC_HOST_KEY_MISMATCH', 'The server identity changed')
      : e?.level === 'client-authentication' ? coded('SYNC_AUTH_FAILED', 'The server refused the key')
      : coded('SYNC_UNREACHABLE', 'Server not reachable')));
    conn.connect({
      host, port, username, privateKey, readyTimeout: READY_TIMEOUT_MS, keepaliveInterval: 0,
      hostVerifier: (key) => { const ok = hostKeyFingerprint(key) === hostKeySha256; mismatch = !ok; return ok; },
    });
  });
}

const call = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (e, v) => (e ? reject(e) : resolve(v))));
const missing = (e) => e?.code === NO_SUCH_FILE;

export function createSftpStore(config, secrets, { connect = realConnect } = {}) {
  let session = null; // Promise<{ sftp, end }>
  let idle = null;
  const drop = () => { const s = session; session = null; s?.then((x) => x.end(), () => {}); };
  async function sftp() {
    clearTimeout(idle);
    session ??= connect(config, secrets).catch((e) => { session = null; throw e.code ? e : coded('SYNC_UNREACHABLE', 'Server not reachable'); });
    const s = await session;
    idle = setTimeout(drop, IDLE_MS);
    idle.unref?.();
    return s.sftp;
  }
  const io = async (fn) => {
    try { return await fn(await sftp()); } catch (e) {
      if (String(e.code || '').startsWith('SYNC_')) throw e;
      drop();
      throw coded('SYNC_IO', 'SFTP operation failed');
    }
  };
  async function mkdirp(s, segs) {
    for (let i = 1; i <= segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      try { await call(s, 'stat', dir); } catch (e) { if (!missing(e)) throw e; await call(s, 'mkdir', dir, {}); }
    }
  }
  async function rmTree(s, dir) {
    let entries;
    try { entries = await call(s, 'readdir', dir); } catch (e) { if (missing(e)) return; throw e; }
    for (const e of entries) {
      const child = `${dir}/${e.filename}`;
      if (e.attrs.isDirectory()) await rmTree(s, child); else await call(s, 'unlink', child);
    }
    await call(s, 'rmdir', dir);
  }
  return {
    async put(path, bytes) {
      const segs = checkPath(path); checkSize(bytes);
      await io(async (s) => {
        await mkdirp(s, segs.slice(0, -1));
        const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
        await call(s, 'writeFile', tmp, Buffer.from(bytes));
        await call(s, 'ext_openssh_rename', tmp, path);
      });
    },
    async get(path) {
      checkPath(path);
      return io(async (s) => {
        try {
          const st = await call(s, 'stat', path);
          if (st.size > MAX_FILE_BYTES) throw coded('SYNC_TOO_LARGE', 'Sync file too large');
          return await call(s, 'readFile', path);
        } catch (e) { if (missing(e)) return null; throw e; }
      });
    },
    async list(dir) {
      checkPath(dir);
      return io(async (s) => {
        try {
          return (await call(s, 'readdir', dir)).filter((e) => !e.attrs.isDirectory() && !e.filename.includes('.tmp-'))
            .map((e) => ({ name: e.filename, size: e.attrs.size, mtimeMs: e.attrs.mtime * 1000 }));
        } catch (e) { if (missing(e)) return []; throw e; }
      });
    },
    async remove(path) {
      checkPath(path);
      await io(async (s) => { try { await call(s, 'unlink', path); } catch (e) { if (!missing(e)) throw e; } });
    },
    async removeTree(dir) { checkPath(dir); await io((s) => rmTree(s, dir)); },
    describe() { return { kind: 'sftp', root: `${config.username}@${config.host}:${config.port}` }; },
    async close() { clearTimeout(idle); drop(); },
  };
}
```

The SFTP session's working directory is `/data` (`ForceCommand internal-sftp -d /data`), so every path is relative to it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-store-sftp.test.mjs`
Expected: PASS (contract 4 + 4 unit; the live test is SKIPPED).

- [ ] **Step 6: Commit**

```bash
git add extension/connectors/sync-store/sftp.mjs extension/tests/sync-store-sftp.test.mjs extension/package.json extension/package-lock.json
git commit -m "feat(sync): SFTP SyncStore adapter with pinned host key" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Snapshot kinds (load, redact, clamp, fit)

**Files:**
- Create: `extension/routes/sync/kinds.mjs`
- Test: `extension/tests/sync-kinds.test.mjs`

**Interfaces:**
- Consumes: `listChatSessions`, `getChatSession` (`kb/chat-sessions.mjs`); `listMeetings`, `listEntitiesForMeetings` (`kb/meetings.mjs`); `listPlans`, `getPlan` (`kb/plans.mjs`); `usageSummary` (`kb/usage.mjs`); `usageOf` (`routes/host-api/reads.mjs`); `getQuickChatId` (`kb/host-api-devices.mjs`); `redactSecretsForStorage` (`core/redact-secrets.mjs`); `MAX_FRAME` (Task 1).
- Produces:
  - `KINDS = ['chats', 'meetings', 'plans', 'usage']`
  - `DEPTH = { sessions: 20, messages: 30, meetings: 50, notes: 40, plans: 30, tasks: 100 }`
  - `buildKinds(raw, now): Record<kind, Buffer>` (pure). `raw = { sessions, phoneChatId, meetings, entities, plans, usage }`, and each Buffer is a UTF-8 JSON frame ≤ `MAX_FRAME`
  - `loadKinds(userId, now = Date.now()): Record<kind, Buffer>` (reads kb, calls `buildKinds`)

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/sync-kinds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKinds, KINDS } from '../routes/sync/kinds.mjs';
import { MAX_FRAME } from '../core/sync-envelope.mjs';

const raw = (over = {}) => ({
  sessions: [{ id: 's1', title: 'Hello', updatedAt: 100, messages: [{ seq: 1, role: 'user', content: 'hi' }, { seq: 2, role: 'system', content: 'x' }, { seq: 3, role: 'assistant', content: 'key sk-ant-api03-' + 'a'.repeat(90) }] }],
  phoneChatId: 's1',
  meetings: [{ id: 'm1', title: 'Standup', date: '2026-11-05', duration_sec: 600, participants: ['A', 'B'] }],
  entities: { m1: [{ kind: 'decision', text: 'Ship it' }] },
  plans: [{ id: 'p1', title: 'Plan', goal: 'G', updatedAt: 5, tasks: [{ title: 'T', status: 'todo', owner: 'me', due: null, milestone: 'M1', risk: 'low', description: 'not synced' }] }],
  usage: { providers: {} },
  ...over,
});

test('every kind is a closed JSON frame; system lines, descriptions and secrets do not leave', () => {
  const k = buildKinds(raw(), 1000);
  assert.deepEqual(Object.keys(k).sort(), [...KINDS].sort());
  const chats = JSON.parse(k.chats);
  assert.equal(chats.v, 1); assert.equal(chats.kind, 'chats'); assert.equal(chats.truncated, false);
  assert.deepEqual(chats.items[0].messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(chats.items[0].phoneChat, true);
  assert.ok(!k.chats.toString().includes('sk-ant-api03'), 'secrets are re-redacted');
  assert.ok(!k.plans.toString().includes('not synced'));
  assert.equal(JSON.parse(k.meetings).items[0].notes[0].text, 'Ship it');
  assert.equal(JSON.parse(k.usage).kind, 'usage');
});

test('an oversized kind drops oldest items until it fits and says truncated', () => {
  const big = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, title: 't', updatedAt: 1000 - i,
    messages: Array.from({ length: 30 }, (_, j) => ({ seq: j + 1, role: 'user', content: 'x'.repeat(8000) })) }));
  const k = buildKinds(raw({ sessions: big }), 1);
  const chats = JSON.parse(k.chats);
  assert.ok(k.chats.length <= MAX_FRAME);
  assert.equal(chats.truncated, true);
  assert.equal(chats.items[0].id, 's0', 'newest kept');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-kinds.test.mjs`
Expected: FAIL with `Cannot find module '…/routes/sync/kinds.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// extension/routes/sync/kinds.mjs
// Snapshot kinds (design 4.2): a fixed allow-list, every string re-redacted and clamped as routes/host-api/reads.mjs
// does, trimmed from the oldest end to one padding bucket. Kind names only ever appear inside the ciphertext.
import { MAX_FRAME } from '../../core/sync-envelope.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';
import { listChatSessions, getChatSession } from '../../kb/chat-sessions.mjs';
import { listMeetings, listEntitiesForMeetings } from '../../kb/meetings.mjs';
import { listPlans, getPlan } from '../../kb/plans.mjs';
import { usageSummary } from '../../kb/usage.mjs';
import { getDb } from '../../kb/db.mjs';
import { getQuickChatId } from '../../kb/host-api-devices.mjs';
import { usageOf } from '../host-api/reads.mjs';

export const KINDS = Object.freeze(['chats', 'meetings', 'plans', 'usage']);
export const DEPTH = Object.freeze({ sessions: 20, messages: 30, meetings: 50, notes: 40, plans: 30, tasks: 100 });

const text = (s, max) => {
  const t = redactSecretsForStorage(typeof s === 'string' ? s : '');
  return t.length > max ? t.slice(0, max) : t;
};
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);

/** Newest items first; drop from the end (oldest) until the frame fits one bucket. */
function frame(kind, items, now) {
  let kept = items;
  let truncated = false;
  for (;;) {
    const buf = Buffer.from(JSON.stringify({ v: 1, kind, generatedAt: now, truncated, items: kept }));
    if (buf.length <= MAX_FRAME) return buf;
    truncated = true;
    if (kept.length <= 1) return Buffer.from(JSON.stringify({ v: 1, kind, generatedAt: now, truncated, items: [] }));
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.8)));
  }
}

export function buildKinds(raw, now) {
  const chats = (raw.sessions ?? []).slice(0, DEPTH.sessions).map((s) => ({
    id: String(s.id), title: text(s.title, 120) || 'New chat', updatedAt: num(s.updatedAt),
    ...(s.id === raw.phoneChatId ? { phoneChat: true } : {}),
    messages: (s.messages ?? []).filter((m) => m?.role === 'user' || m?.role === 'assistant').slice(-DEPTH.messages)
      .map((m) => ({ seq: m.seq, role: m.role, content: text(m.content, 8000) })),
  }));
  const meetings = (raw.meetings ?? []).slice(0, DEPTH.meetings).map((m) => ({
    id: String(m.id), title: text(m.title, 200), date: text(m.date, 40), durationSec: num(m.duration_sec),
    participants: (Array.isArray(m.participants) ? m.participants : []).slice(0, 20).map((p) => text(typeof p === 'string' ? p : p?.name, 120)),
    notes: (raw.entities?.[m.id] ?? []).slice(0, DEPTH.notes).map((e) => ({ kind: text(e.kind, 40), text: text(e.text, 500) })),
  }));
  const plans = (raw.plans ?? []).slice(0, DEPTH.plans).map((p) => ({
    id: String(p.id), title: text(p.title, 200), goal: text(p.goal, 2000), updatedAt: num(p.updatedAt),
    tasks: (p.tasks ?? []).slice(0, DEPTH.tasks).map((t) => ({ title: text(t.title, 300), status: text(t.status, 40), owner: text(t.owner, 120),
      due: t.due ? text(String(t.due), 40) : null, milestone: text(t.milestone, 120), risk: text(t.risk, 40) })),
  }));
  return {
    chats: frame('chats', chats, now),
    meetings: frame('meetings', meetings, now),
    plans: frame('plans', plans, now),
    usage: Buffer.from(JSON.stringify({ v: 1, kind: 'usage', generatedAt: now, truncated: false, items: [usageOf(raw.usage)] })),
  };
}

export function loadKinds(userId, now = Date.now()) {
  const sessions = listChatSessions(userId, { limit: DEPTH.sessions })
    .map((s) => ({ ...s, messages: getChatSession(userId, s.id, { messageLimit: DEPTH.messages * 2 })?.messages ?? [] }));
  const meetings = listMeetings(userId, null, DEPTH.meetings);
  const entities = listEntitiesForMeetings(userId, meetings.map((m) => m.id));
  const plans = listPlans(userId, DEPTH.plans).map((p) => getPlan(userId, p.id)).filter(Boolean);
  return buildKinds({ sessions, phoneChatId: getQuickChatId(userId), meetings, entities, plans, usage: usageSummary(getDb(), userId) }, now);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-kinds.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/routes/sync/kinds.mjs extension/tests/sync-kinds.test.mjs
git commit -m "feat(sync): redacted, size-capped snapshot kinds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Desktop keys and the snapshot producer

**Files:**
- Create: `extension/routes/sync/keys.mjs`, `extension/routes/sync/producer.mjs`
- Test: `extension/tests/sync-producer.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`deviceKeys`, `seal`, `makeSyncWrap`, `sha256`, `newSigningKey`), Task 2 (state helpers), Task 3 (`SyncStore`), Task 5 (`loadKinds`, `KINDS`); `getSecret`/`setSecret` (`server/vault.mjs`).
- Produces:
  - `ensureSyncKeys(userId): { root: Buffer, epoch: number, signingKey: KeyObject, signingSpki: Buffer, fingerprint: string }`
  - `syncIdsFor(userId, state): { userId, desktopId }`
  - `HEARTBEAT_MS = 900000`, `VALID_FOR_MS = 2700000`
  - `publishOnce({ userId, store, now = Date.now(), loadKinds? }): Promise<{ devices: number, blobs: number, manifests: number }>`

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/sync-producer.test.mjs
// A test device decrypts everything it would read: wrap -> manifest -> blobs. The store must hold no plaintext marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createHash, createPublicKey } from 'node:crypto';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-producer-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const S = await import('../core/sync-envelope.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { publishOnce, HEARTBEAT_MS } = await import('../routes/sync/producer.mjs');
const { ensureSyncKeys } = await import('../routes/sync/keys.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sp-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'p' }).id;
const MARK = 'PLAINTEXT-MARKER-7f3a';
const fakeKinds = (extra = '') => () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k, Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: 1, truncated: false, items: [MARK + extra] }))]));

function device(u) {
  const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const d = { deviceId: 'h1-dev-1', dir: 'D'.repeat(22), tier: 'web', name: 'Phone',
    ecdhSpki: ecdh.publicKey.export({ type: 'spki', format: 'der' }), signingSpki: sig.publicKey.export({ type: 'spki', format: 'der' }) };
  st.addSyncDevice(u, { ...d, now: 1 });
  return { ...d, ecdhPrivate: ecdh.privateKey };
}

async function readAs(store, state, u, dev, epoch = 0) {
  const base = `${state.syncId}/d/${dev.dir}`;
  const spki = await store.get(`${base}/key.bin`);
  const verifyKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const keys = S.unwrapSync({ env: JSON.parse(await store.get(`${base}/wrap.bin`)), ecdhPrivate: dev.ecdhPrivate, deviceEcdhSpki: dev.ecdhSpki,
    desktopSigningSpki: spki, verifyKey, currentEpoch: epoch, deviceId: dev.deviceId });
  const manifest = JSON.parse(S.open({ env: JSON.parse(await store.get(`${base}/manifest.bin`)), key: keys.manifest, verifyKey, expect: { purpose: 'manifest', to: dev.deviceId } }));
  const kinds = {};
  for (const [kind, e] of Object.entries(manifest.kinds)) {
    const bytes = await store.get(`${base}/${e.file}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), e.sha256, 'manifest binds the blob');
    kinds[kind] = JSON.parse(S.open({ env: JSON.parse(bytes), key: keys.snapshot, verifyKey, expect: { purpose: 'snapshot', to: dev.deviceId } }));
  }
  return { manifest, kinds, spki };
}

test('publish writes key, wrap, manifest and blobs a device can verify and decrypt; the store sees no plaintext', async () => {
  const u = user();
  const state = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const dev = device(u);
  const store = createMemoryStore();
  const r = await publishOnce({ userId: u, store, now: 10_000, loadKinds: fakeKinds() });
  assert.deepEqual(r, { devices: 1, blobs: 4, manifests: 1 });
  const { manifest, kinds, spki } = await readAs(store, state, u, dev);
  assert.equal(S.spkiFingerprint(spki), ensureSyncKeys(u).fingerprint);
  assert.deepEqual(Object.keys(kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
  assert.equal(manifest.validUntil, manifest.generatedAt + 45 * 60_000);
  for (const [, bytes] of store.dump()) assert.ok(!bytes.toString('latin1').includes(MARK), 'blindness');
});

test('an unchanged publish writes nothing until the heartbeat, a change rewrites only that kind, old blobs are removed', async () => {
  const u = user();
  const state = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const dev = device(u);
  const store = createMemoryStore();
  await publishOnce({ userId: u, store, now: 10_000, loadKinds: fakeKinds() });
  const first = (await readAs(store, state, u, dev)).manifest;
  assert.deepEqual(await publishOnce({ userId: u, store, now: 20_000, loadKinds: fakeKinds() }), { devices: 1, blobs: 0, manifests: 0 });
  const beat = await publishOnce({ userId: u, store, now: 10_000 + HEARTBEAT_MS, loadKinds: fakeKinds() });
  assert.deepEqual(beat, { devices: 1, blobs: 0, manifests: 1 });
  const changed = () => ({ ...fakeKinds()(), chats: Buffer.from('{"v":1,"kind":"chats","generatedAt":2,"truncated":false,"items":["new"]}') });
  assert.deepEqual(await publishOnce({ userId: u, store, now: 10_000 + HEARTBEAT_MS + 1, loadKinds: changed }), { devices: 1, blobs: 1, manifests: 1 });
  const { manifest, kinds } = await readAs(store, state, u, dev);
  assert.ok(manifest.manifestSeq > first.manifestSeq, 'manifestSeq only grows');
  assert.deepEqual(kinds.chats.items, ['new']);
  const files = (await store.list(`${state.syncId}/d/${dev.dir}/s`)).map((f) => `s/${f.name}`).sort();
  assert.deepEqual(files, Object.values(manifest.kinds).map((k) => k.file).sort(), 'only manifest-named blobs remain');
});

test('disabled sync publishes nothing', async () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  device(u);
  const store = createMemoryStore();
  assert.deepEqual(await publishOnce({ userId: u, store, now: 1, loadKinds: fakeKinds() }), { devices: 0, blobs: 0, manifests: 0 });
  assert.equal(store.dump().size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-producer.test.mjs`
Expected: FAIL with `Cannot find module '…/routes/sync/producer.mjs'`.

- [ ] **Step 3: Write `extension/routes/sync/keys.mjs`**

```js
// extension/routes/sync/keys.mjs
// Desktop-held sync keys (design 5.1): the per-epoch root and the ECDSA P-256 signing key, in the core vault whose
// master key the desktop keeps in the OS keychain. Created on first use; never logged, never returned to a client.
import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState } from '../../kb/sync-state.mjs';
import { newSigningKey, spkiFingerprint } from '../../core/sync-envelope.mjs';

export function ensureSyncKeys(userId) {
  const db = getDb();
  const state = getSyncState(userId);
  if (!state) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  let root = getSecret(db, userId, 'sync.rootKey');
  if (!root) { root = randomBytes(32).toString('base64url'); setSecret(db, userId, 'sync.rootKey', root); }
  let pkcs8 = getSecret(db, userId, 'sync.signingKey');
  if (!pkcs8) { pkcs8 = newSigningKey().pkcs8.toString('base64url'); setSecret(db, userId, 'sync.signingKey', pkcs8); }
  const signingKey = createPrivateKey({ key: Buffer.from(pkcs8, 'base64url'), format: 'der', type: 'pkcs8' });
  const signingSpki = createPublicKey(signingKey).export({ type: 'spki', format: 'der' });
  return { root: Buffer.from(root, 'base64url'), epoch: state.epoch, signingKey, signingSpki, fingerprint: spkiFingerprint(signingSpki) };
}

export const syncIdsFor = (userId, state) => ({ userId, desktopId: state.syncId });
```

- [ ] **Step 4: Write `extension/routes/sync/producer.mjs`**

```js
// extension/routes/sync/producer.mjs
// Snapshot producer (design 4.2 to 4.3, 7): per device, write key.bin and wrap.bin when its wrap epoch is behind, the
// changed kinds as fresh random blob names, then the manifest, then remove blobs the manifest does not name (this also
// cleans up after a crash mid-publish). Unchanged kinds are not rewritten; the manifest is refreshed on the heartbeat.
import { randomBytes } from 'node:crypto';
import { deviceKeys, seal, makeSyncWrap, sha256 } from '../../core/sync-envelope.mjs';
import { getSyncState, listSyncDevices, getPublished, setPublished, nextSeq, recordPublish, setDeviceWrapEpoch } from '../../kb/sync-state.mjs';
import { ensureSyncKeys, syncIdsFor } from './keys.mjs';
import { loadKinds as defaultLoadKinds, KINDS } from './kinds.mjs';

export const HEARTBEAT_MS = 15 * 60_000;
export const VALID_FOR_MS = 45 * 60_000;
const hex = (b) => Buffer.from(b).toString('hex');
const envBytes = (env) => Buffer.from(JSON.stringify(env));

export async function publishOnce({ userId, store, now = Date.now(), loadKinds = defaultLoadKinds }) {
  const out = { devices: 0, blobs: 0, manifests: 0 };
  const state = getSyncState(userId);
  if (!state?.enabled) return out;
  const keys = ensureSyncKeys(userId);
  const ids = syncIdsFor(userId, state);
  const frames = loadKinds(userId, now);
  const heartbeatDue = !state.lastPublishAt || now - state.lastPublishAt >= HEARTBEAT_MS;
  let wroteManifest = false;
  for (const dev of listSyncDevices(userId)) {
    out.devices += 1;
    const base = `${state.syncId}/d/${dev.dir}`;
    const dk = deviceKeys(keys.root, { ...ids, deviceId: dev.deviceId }, keys.epoch);
    const header = (purpose, seq) => ({ purpose, userId, desktopId: state.syncId, from: state.syncId, to: dev.deviceId, epoch: keys.epoch, session: '', seq, issuedAt: now, tier: '' });
    if (dev.wrapEpoch !== keys.epoch) {
      await store.put(`${base}/key.bin`, keys.signingSpki);
      const wrap = makeSyncWrap({ ids: { ...ids, deviceId: dev.deviceId }, epoch: keys.epoch, tier: dev.tier, deviceEcdhSpki: dev.ecdhSpki,
        desktopSigningSpki: keys.signingSpki, keys: dk, signingKey: keys.signingKey, seq: nextSeq(userId, now), issuedAt: now });
      await store.put(`${base}/wrap.bin`, envBytes(wrap));
      setDeviceWrapEpoch(userId, dev.deviceId, keys.epoch);
    }
    const published = getPublished(userId, dev.deviceId);
    const changed = KINDS.filter((k) => published[k]?.plainSha256 !== hex(sha256(frames[k])) || published[k]?.epoch !== keys.epoch);
    if (!changed.length && !heartbeatDue) continue;
    const entries = Object.fromEntries(KINDS.filter((k) => published[k]).map((k) => [k, published[k]]));
    for (const kind of changed) {
      const seq = nextSeq(userId, now);
      const bytes = envBytes(seal({ header: header('snapshot', seq), key: dk.snapshot, plaintext: frames[kind], signingKey: keys.signingKey }));
      const file = `s/${randomBytes(16).toString('hex')}.bin`;
      await store.put(`${base}/${file}`, bytes);
      entries[kind] = { file, seq, fileSha256: hex(sha256(bytes)), plainSha256: hex(sha256(frames[kind])), epoch: keys.epoch };
      out.blobs += 1;
    }
    const manifestSeq = nextSeq(userId, now);
    const manifest = { v: 1, manifestSeq, epoch: keys.epoch, generatedAt: now, validUntil: now + VALID_FOR_MS,
      kinds: Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, { file: e.file, seq: e.seq, sha256: e.fileSha256 }])) };
    await store.put(`${base}/manifest.bin`, envBytes(seal({ header: header('manifest', manifestSeq), key: dk.manifest, plaintext: Buffer.from(JSON.stringify(manifest)), signingKey: keys.signingKey })));
    out.manifests += 1;
    wroteManifest = true;
    for (const kind of changed) setPublished(userId, dev.deviceId, kind, entries[kind]);
    const keep = new Set(Object.values(entries).map((e) => e.file.slice(2)));
    for (const f of await store.list(`${base}/s`)) if (!keep.has(f.name)) await store.remove(`${base}/s/${f.name}`);
  }
  if (wroteManifest) recordPublish(userId, { at: now });
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-producer.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add extension/routes/sync/keys.mjs extension/routes/sync/producer.mjs extension/tests/sync-producer.test.mjs
git commit -m "feat(sync): desktop keys and encrypted snapshot producer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Inbox consumer at the read-only ceiling

**Files:**
- Create: `extension/routes/sync/consumer.mjs`
- Test: `extension/tests/sync-consumer.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`open`, `seal`, `deviceKeys`), Task 2 (`listSyncDevices`, `recordRequest`, `finishRequest`, `countRequestsSince`, `nextSeq`, `getSyncState`), Task 6 (`ensureSyncKeys`); at runtime `startHostTurn` and `cancelChatTurn` (`routes/agent-v2.mjs`), `getQuickChatId`/`setQuickChatId` (`kb/host-api-devices.mjs`), `createChatSession` (`kb/chat-sessions.mjs`).
- Produces:
  - `LIMITS = { maxFileBytes: 65536, maxText: 4000, maxAgeMs: 86400000, maxSkewMs: 600000, perDrain: 5, perDay: 50, turnMs: 600000, outboxDays: 7 }`
  - `parseRequest(plain: Buffer): { requestId, text } | null`
  - `drainOnce({ userId, store, now = Date.now(), deps? }): Promise<{ ran: number, refused: number, replied: number }>`, where `deps = { turn(args), cancel(userId, chatSessionId), phoneChatId(userId): Promise<string> }`

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/sync-consumer.test.mjs
// The ceiling (relay design 5.2, D2): typed request only, signature by the registered device, desktop-clock age,
// record-before-execute, quota, turns only through the injected startHostTurn, approval requests never answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, createPublicKey } from 'node:crypto';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-consumer-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const S = await import('../core/sync-envelope.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { drainOnce, LIMITS } = await import('../routes/sync/consumer.mjs');
const { ensureSyncKeys } = await import('../routes/sync/keys.mjs');

let n = 0;
const NOW = 1_762_300_000_000;
function setup() {
  const u = users.registerUser(kb.getDb(), { email: `sc-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'c' }).id;
  const state = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dev = { deviceId: `h1-dev-${n}`, dir: randomBytes(16).toString('base64url'), tier: 'web', name: 'Phone',
    ecdhSpki: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }), signingSpki: sig.publicKey.export({ type: 'spki', format: 'der' }) };
  st.addSyncDevice(u, { ...dev, now: 1 });
  const keys = ensureSyncKeys(u);
  const dk = S.deviceKeys(keys.root, { userId: u, desktopId: state.syncId, deviceId: dev.deviceId }, keys.epoch);
  const store = createMemoryStore();
  const base = `${state.syncId}/d/${dev.dir}`;
  const send = async (body, { issuedAt = NOW, signer = sig.privateKey, requestId = randomBytes(16).toString('base64url'), epoch = keys.epoch } = {}) => {
    const env = S.seal({ header: { purpose: 'request', userId: u, desktopId: state.syncId, from: dev.deviceId, to: state.syncId, epoch, session: '', seq: 1, issuedAt, tier: '' },
      key: dk.request, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId, class: 'chat.send', text: 'hello', ...body })), signingKey: signer });
    await store.put(`${base}/in/${issuedAt}-${requestId}.bin`, Buffer.from(JSON.stringify(env)));
    return requestId;
  };
  const reply = async (requestId) => {
    const bytes = await store.get(`${base}/out/${requestId}.bin`);
    return bytes && JSON.parse(S.open({ env: JSON.parse(bytes), key: dk.reply, verifyKey: createPublicKey(keys.signingKey), expect: { purpose: 'reply', to: dev.deviceId } }));
  };
  const calls = [];
  const deps = (events = [{ type: 'delta', text: 'hi there' }, { type: 'result' }]) => ({
    phoneChatId: async () => 'phone-chat',
    cancel: (userId, id) => calls.push(['cancel', id]),
    turn: async (args) => { calls.push(['turn', args.chatSessionId, args.message, Object.keys(args).sort().join(',')]); for (const e of events) args.onEvent(e); },
  });
  return { u, store, base, send, reply, calls, deps };
}

test('a valid queued prompt runs once through the turn dep and gets an encrypted reply', async () => {
  const t = setup();
  const id = await t.send({});
  assert.deepEqual(await drainOnce({ userId: t.u, store: t.store, now: NOW + 1000, deps: t.deps() }), { ran: 1, refused: 0, replied: 1 });
  assert.deepEqual(await t.reply(id), { v: 1, requestId: id, ok: true, text: 'hi there', finishedAt: NOW + 1000 });
  assert.deepEqual(t.calls[0], ['turn', 'phone-chat', 'hello', 'chatSessionId,message,onEvent,userId'], 'no mode or tool option reaches the turn');
  assert.deepEqual(await t.store.list(`${t.base}/in`), [], 'inbox file removed');
});

test('a replayed request id never runs twice', async () => {
  const t = setup();
  const id = await t.send({});
  await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() });
  await t.send({}, { requestId: id });
  assert.deepEqual(await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() }), { ran: 0, refused: 0, replied: 0 });
  assert.equal(t.calls.filter((c) => c[0] === 'turn').length, 1);
});

test('refusals: wrong signer, unknown field, wrong class, over-long text, oversize file', async () => {
  const t = setup();
  await t.send({}, { signer: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
  await t.send({ extra: 1 });
  await t.send({ class: 'files.write' });
  await t.send({ text: 'x'.repeat(LIMITS.maxText + 1) });
  await t.store.put(`${t.base}/in/${NOW}-${'Z'.repeat(22)}.bin`, Buffer.alloc(LIMITS.maxFileBytes + 1));
  const r = await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() });
  assert.equal(r.ran, 0);
  assert.equal(r.refused, 5);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(await t.store.list(`${t.base}/in`), []);
});

test('age by the desktop clock: too old or too far ahead is expired, not run', async () => {
  const t = setup();
  const old = await t.send({}, { issuedAt: NOW - LIMITS.maxAgeMs - 1 });
  const ahead = await t.send({}, { issuedAt: NOW + LIMITS.maxSkewMs + 1 });
  await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps() });
  assert.equal((await t.reply(old)).code, 'expired');
  assert.equal((await t.reply(ahead)).code, 'expired');
  assert.equal(t.calls.length, 0);
});

test('an approval request is never answered remotely: cancel and reply needs_approval', async () => {
  const t = setup();
  const id = await t.send({});
  await drainOnce({ userId: t.u, store: t.store, now: NOW, deps: t.deps([{ type: 'approval_request', requestId: 'a1', kind: 'ToolApproval' }, { type: 'error', message: 'cancelled' }]) });
  assert.equal((await t.reply(id)).code, 'needs_approval');
  assert.ok(t.calls.some((c) => c[0] === 'cancel'));
});

test('quota: at most perDrain per drain and perDay per device', async () => {
  const t = setup();
  for (let i = 0; i < LIMITS.perDrain + 2; i++) await t.send({}, { issuedAt: NOW + i });
  assert.equal((await drainOnce({ userId: t.u, store: t.store, now: NOW + 100, deps: t.deps() })).ran, LIMITS.perDrain);
  for (let i = 0; i < LIMITS.perDay; i++) st.recordRequest(t.u, `h1-dev-${n}`, `q${i}`.padEnd(22, 'q'), NOW);
  const id = await t.send({}, { issuedAt: NOW + 200 });
  await drainOnce({ userId: t.u, store: t.store, now: NOW + 300, deps: t.deps() });
  assert.equal((await t.reply(id)).code, 'quota');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-consumer.test.mjs`
Expected: FAIL with `Cannot find module '…/routes/sync/consumer.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// extension/routes/sync/consumer.mjs
// Inbox consumer at the fixed read-only ceiling (design 6; relay design 5.2, D2). Every inbox file is untrusted:
// size, then signature by the REGISTERED device key, then a closed schema; record-before-execute; the turn runs only
// through startHostTurn (auto_read_only, phone chat, extension workspace) and an approval request is never answered
// from here. Nothing decrypted is logged.
import { createPublicKey } from 'node:crypto';
import { open, seal, deviceKeys } from '../../core/sync-envelope.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';
import { getSyncState, listSyncDevices, recordRequest, finishRequest, countRequestsSince, nextSeq } from '../../kb/sync-state.mjs';
import { getQuickChatId, setQuickChatId } from '../../kb/host-api-devices.mjs';
import { ensureSyncKeys } from './keys.mjs';

export const LIMITS = Object.freeze({ maxFileBytes: 65536, maxText: 4000, maxAgeMs: 86_400_000, maxSkewMs: 600_000, perDrain: 5, perDay: 50, turnMs: 600_000, outboxDays: 7 });
const NAME_RE = /^([0-9]{13})-([A-Za-z0-9_-]{22})\.bin$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const REQUEST_KEYS = ['class', 'requestId', 'text', 'v'];

export function parseRequest(plain) {
  let o;
  try { o = JSON.parse(Buffer.from(plain).toString('utf8')); } catch { return null; }
  if (!o || typeof o !== 'object' || Object.keys(o).sort().join() !== REQUEST_KEYS.join()) return null;
  if (o.v !== 1 || o.class !== 'chat.send' || !ID_RE.test(o.requestId)) return null;
  if (typeof o.text !== 'string' || o.text.length < 1 || o.text.length > LIMITS.maxText) return null;
  return { requestId: o.requestId, text: o.text };
}

const defaultDeps = {
  turn: async (args) => (await import('../agent-v2.mjs')).startHostTurn(args),
  cancel: async (userId, id) => (await import('../agent-v2.mjs')).cancelChatTurn(userId, id),
  phoneChatId: async (userId) => {
    const have = getQuickChatId(userId);
    if (have) return have;
    const id = (await import('../../kb/chat-sessions.mjs')).createChatSession(userId, { title: 'Phone chat', surface: 'any', mode: 'agent' }).id;
    setQuickChatId(userId, id);
    return id;
  },
};

async function runTurn(userId, text, deps) {
  const chatSessionId = await deps.phoneChatId(userId);
  let reply = '';
  let failure = null;
  const timer = setTimeout(() => { failure ??= 'turn_failed'; deps.cancel(userId, chatSessionId); }, LIMITS.turnMs);
  timer.unref?.();
  try {
    await deps.turn({ userId, chatSessionId, message: text, onEvent: (e) => {
      if (e?.type === 'delta' && typeof e.text === 'string') reply += e.text;
      else if (e?.type === 'approval_request') { failure ??= 'needs_approval'; deps.cancel(userId, chatSessionId); }
      else if (e?.type === 'error') failure ??= 'turn_failed';
    } });
  } catch { failure ??= 'turn_failed'; } finally { clearTimeout(timer); }
  return failure ? { ok: false, code: failure } : { ok: true, text: redactSecretsForStorage(reply).slice(0, 100_000) };
}

export async function drainOnce({ userId, store, now = Date.now(), deps = defaultDeps }) {
  const out = { ran: 0, refused: 0, replied: 0 };
  const state = getSyncState(userId);
  if (!state?.enabled) return out;
  const keys = ensureSyncKeys(userId);
  for (const dev of listSyncDevices(userId)) {
    const base = `${state.syncId}/d/${dev.dir}`;
    const dk = deviceKeys(keys.root, { userId, desktopId: state.syncId, deviceId: dev.deviceId }, keys.epoch);
    const verifyKey = createPublicKey({ key: dev.signingSpki, format: 'der', type: 'spki' });
    const writeReply = async (requestId, body) => {
      const env = seal({ header: { purpose: 'reply', userId, desktopId: state.syncId, from: state.syncId, to: dev.deviceId, epoch: keys.epoch, session: '', seq: nextSeq(userId, now), issuedAt: now, tier: '' },
        key: dk.reply, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId, ...body })), signingKey: keys.signingKey });
      await store.put(`${base}/out/${requestId}.bin`, Buffer.from(JSON.stringify(env)));
      out.replied += 1;
    };
    const files = (await store.list(`${base}/in`)).sort((a, b) => (a.name < b.name ? -1 : 1));
    let taken = 0;
    for (const f of files) {
      const path = `${base}/in/${f.name}`;
      const m = NAME_RE.exec(f.name);
      if (!m || f.size > LIMITS.maxFileBytes) { await store.remove(path); out.refused += 1; continue; }
      if (taken >= LIMITS.perDrain) break;
      const bytes = await store.get(path);
      let env; let req = null;
      try {
        env = JSON.parse(Buffer.from(bytes).toString('utf8'));
        req = parseRequest(open({ env, key: dk.request, verifyKey, expect: { purpose: 'request', userId, desktopId: state.syncId, from: dev.deviceId, to: state.syncId, epoch: keys.epoch } }));
      } catch { req = null; }
      if (!req || req.requestId !== m[2]) { await store.remove(path); out.refused += 1; continue; }
      const fresh = recordRequest(userId, dev.deviceId, req.requestId, now);
      await store.remove(path);
      if (!fresh) continue; // replay: already answered or failed, never re-run
      taken += 1;
      if (env.issuedAt < now - LIMITS.maxAgeMs || env.issuedAt > now + LIMITS.maxSkewMs) {
        await writeReply(req.requestId, { ok: false, code: 'expired' }); finishRequest(userId, dev.deviceId, req.requestId, 'failed'); continue;
      }
      if (countRequestsSince(userId, dev.deviceId, now - 86_400_000) > LIMITS.perDay) {
        await writeReply(req.requestId, { ok: false, code: 'quota' }); finishRequest(userId, dev.deviceId, req.requestId, 'failed'); continue;
      }
      const result = await runTurn(userId, req.text, deps);
      out.ran += 1;
      await writeReply(req.requestId, result.ok ? { ok: true, text: result.text, finishedAt: now } : { ok: false, code: result.code });
      finishRequest(userId, dev.deviceId, req.requestId, result.ok ? 'done' : 'failed');
    }
    const cutoff = now - LIMITS.outboxDays * 86_400_000;
    for (const f of await store.list(`${base}/out`)) if (f.mtimeMs < cutoff) await store.remove(`${base}/out/${f.name}`);
  }
  return out;
}
```

The quota test records 50 extra rows and then sends one more request. `countRequestsSince` then counts 50 + 5 + 1 > 50, so the
reply is `quota`. The check runs after the new row is recorded, so it allows at most `perDay` runs per day.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-consumer.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/routes/sync/consumer.mjs extension/tests/sync-consumer.test.mjs
git commit -m "feat(sync): inbox consumer at the fixed read-only ceiling" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Scheduler, `/kb/sync/*` routes and server wiring

**Files:**
- Create: `extension/routes/sync/scheduler.mjs`, `extension/routes/sync/http-routes.mjs`, `schema/http/sync.schema.json`
- Modify: `extension/server.mjs`: the import block (top), `SERVER_API_VERSION` (line 324) plus a `v112` comment line, `ALL_ENDPOINTS`
  (after the `/host-api/*` entries near line 506), the rate-bucket function (near line 553, next to `/kb/calendar-ical/sources`),
  the dispatch block (right after the Host API block near line 806) and the post-listen block (near line 1507)
- Regenerate: `schema/http/INVENTORY.md`, generated API types, openapi
- Test: `extension/tests/sync-routes.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 4, 6, 7; `verifyBusHostProof` (`core/host-approval.mjs`); `send`, `readJson` (`server/route-http.mjs`); `getSecret`/`setSecret`.
- Produces:
  - `storeFor(userId): SyncStore | null` (scheduler.mjs)
  - `startSyncScheduler({ logger, env = process.env }): { stop(): void }` (does nothing when `LLMIDE_SYNC=off`)
  - `syncCycle(userId, { now }): Promise<{ publish, drain }>`
  - `isSyncRoute(url): boolean`, `handleSyncRoute(req, res, opts): Promise<true>`
  - HTTP (JWT + bus host proof, 403 `HOST_PROOF_REQUIRED` first):
    - `GET /kb/sync/status` → `{ configured, enabled, storeKind, store, publicKey, syncId, epoch, signingFingerprint, devices: [{ deviceId, name, tier, addedAt }], lastPublishAt, lastError }`
    - `POST /kb/sync/sftp { host, port, username, hostKeySha256 }` → status (creates the SSH key once; 400 `VALIDATION_FAILED` with `details.field`)
    - `POST /kb/sync/test` → `{ ok: true }` | 502 `{ error: { code: SYNC_HOST_KEY_MISMATCH|SYNC_AUTH_FAILED|SYNC_UNREACHABLE|SYNC_IO } }` | 409 `SYNC_NOT_SET_UP`
    - `POST /kb/sync/enabled { enabled: boolean }` → status | 409 `SYNC_NOT_SET_UP`
    - `POST /kb/sync/publish` → `{ publish: {devices, blobs, manifests}, drain: {ran, refused, replied} }` | 409 | 502

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/sync-routes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');
const { handleSyncRoute, isSyncRoute } = await import('../routes/sync/http-routes.mjs');
const { busHostProof } = await import('../core/host-approval.mjs');
const PROOF = busHostProof();

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sr-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' }).id;
async function call(method, url, { userId, body, proof = true, deps } = {}) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  // Same request double as tests/box-routes.test.mjs makeReq (readJson consumes 'data'/'end').
  const req = { method, url, user: userId ? { id: userId } : undefined, headers: proof ? { 'x-llmide-host-nonce': PROOF } : {},
    socket: { remoteAddress: '127.0.0.1' }, pause() {}, resume() {},
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end') cb(); return req; } };
  let status = 0; let payload = '';
  const res = { headersSent: false, writeHead(s) { status = s; this.headersSent = true; }, setHeader() {}, end(b) { payload = b ?? ''; } };
  await handleSyncRoute(req, res, deps ? { deps } : {});
  return { status, body: payload ? JSON.parse(payload) : null };
}
const SFTP = { host: 'sync.example.com', port: 22, username: 'llmidesync', hostKeySha256: 'SHA256:' + 'A'.repeat(43) };

test('routes need the bus host proof, then a user', async () => {
  assert.ok(isSyncRoute('/kb/sync/status'));
  assert.ok(!isSyncRoute('/kb/synchronize'));
  assert.equal((await call('GET', '/kb/sync/status', { userId: user(), proof: false })).status, 403);
  assert.equal((await call('GET', '/kb/sync/status', {})).status, 401);
});

test('SFTP setup validates, creates one SSH key, returns only the public line, never secrets', async () => {
  const u = user();
  const bad = await call('POST', '/kb/sync/sftp', { userId: u, body: { ...SFTP, port: 0 } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.field, 'port');
  const a = await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
  assert.equal(a.status, 200);
  assert.match(a.body.publicKey, /^ssh-ed25519 /);
  assert.equal(a.body.enabled, false);
  const b = await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
  assert.equal(b.body.publicKey, a.body.publicKey, 'the key is created once');
  const raw = JSON.stringify(b.body);
  assert.ok(!raw.includes('PRIVATE KEY'));
  assert.ok(!raw.includes(vault.getSecret(kb.getDb(), u, 'sync.sshKey').slice(40, 80)));
});

test('enable needs a configured store; status reflects it', async () => {
  const u = user();
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } })).status, 409);
  await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
  const on = await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } });
  assert.equal(on.body.enabled, true);
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: 'yes' } })).status, 400);
});

test('test and publish surface coded store errors', async () => {
  const u = user();
  await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
  const failing = { storeFor: () => ({ put: async () => { throw Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_MISMATCH' }); }, get: async () => null, remove: async () => {}, close: async () => {} }) };
  const r = await call('POST', '/kb/sync/test', { userId: u, deps: failing });
  assert.equal(r.status, 502); assert.equal(r.body.error.code, 'SYNC_HOST_KEY_MISMATCH');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-routes.test.mjs`
Expected: FAIL with `Cannot find module '…/routes/sync/http-routes.mjs'`.

- [ ] **Step 3: Write `extension/routes/sync/scheduler.mjs`**

```js
// extension/routes/sync/scheduler.mjs
// Timers for every user with sync on: producer every 60 s +/- 15 s, consumer every 30 s; one cycle per user at a time;
// failures back off exponentially up to 15 min and are recorded as a code only. LLMIDE_SYNC=off starts nothing.
import { getDb } from '../../kb/db.mjs';
import { getSecret } from '../../server/vault.mjs';
import { getSyncState, listEnabledSyncUsers, recordPublish } from '../../kb/sync-state.mjs';
import { createSftpStore } from '../../connectors/sync-store/sftp.mjs';
import { publishOnce } from './producer.mjs';
import { drainOnce } from './consumer.mjs';

const PRODUCE_MS = 60_000;
const DRAIN_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export function storeFor(userId) {
  const state = getSyncState(userId);
  if (state?.storeKind !== 'sftp') return null;
  const privateKey = getSecret(getDb(), userId, 'sync.sshKey');
  return privateKey ? createSftpStore(state.storeConfig, { privateKey }) : null;
}

export async function syncCycle(userId, { now = Date.now(), produce = true, store = storeFor(userId) } = {}) {
  if (!store) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  try {
    const publish = produce ? await publishOnce({ userId, store, now }) : null;
    const drain = await drainOnce({ userId, store, now });
    return { publish, drain };
  } finally { await store.close?.(); }
}

export function startSyncScheduler({ logger, env = process.env } = {}) {
  if (env.LLMIDE_SYNC === 'off') return { stop() {} };
  const busy = new Set();
  const backoff = new Map(); // userId -> { until, ms }
  let lastProduce = 0;
  const tick = async () => {
    const now = Date.now();
    const produce = now - lastProduce >= PRODUCE_MS + Math.floor(Math.random() * 15_000);
    if (produce) lastProduce = now;
    for (const userId of listEnabledSyncUsers()) {
      if (busy.has(userId) || (backoff.get(userId)?.until ?? 0) > now) continue;
      busy.add(userId);
      try {
        await syncCycle(userId, { now, produce });
        backoff.delete(userId);
      } catch (e) {
        const ms = Math.min(MAX_BACKOFF_MS, (backoff.get(userId)?.ms ?? 30_000) * 2);
        backoff.set(userId, { until: now + ms, ms });
        const code = String(e?.code || 'SYNC_FAILED');
        recordPublish(userId, { at: now, error: code });
        logger?.warn?.('sync_cycle_failed', { code, backoffMs: ms });
      } finally { busy.delete(userId); }
    }
  };
  const timer = setInterval(() => { void tick(); }, DRAIN_MS);
  timer.unref?.();
  return { stop() { clearInterval(timer); } };
}
```

- [ ] **Step 4: Write `extension/routes/sync/http-routes.mjs`**

```js
// extension/routes/sync/http-routes.mjs
// /kb/sync/* for the desktop Settings card: JWT + bus host proof (desktop UI only), per user. Never returns a private
// key, root key or folder capability; errors carry codes, never secrets.
import { send, readJson } from '../../server/route-http.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState, ensureSyncState, setSyncEnabled, listSyncDevices } from '../../kb/sync-state.mjs';
import { generateSshKey, validateSftpConfig } from '../../connectors/sync-store/sftp.mjs';
import { ensureSyncKeys } from './keys.mjs';
import { storeFor as defaultStoreFor, syncCycle } from './scheduler.mjs';

const fail = (res, status, code, message, details) => { send(res, status, { error: { code, message, ...(details ? { details } : {}) } }); return true; };

export function isSyncRoute(url) {
  const p = String(url || '').split('?')[0];
  return p === '/kb/sync' || p.startsWith('/kb/sync/');
}

function status(userId) {
  const s = getSyncState(userId);
  if (!s) return { configured: false, enabled: false, storeKind: null, store: null, publicKey: null, syncId: null, epoch: null, signingFingerprint: null, devices: [], lastPublishAt: null, lastError: null };
  const db = getDb();
  return {
    configured: true, enabled: s.enabled, storeKind: s.storeKind,
    store: s.storeKind === 'sftp' ? { host: s.storeConfig.host, port: s.storeConfig.port, username: s.storeConfig.username, hostKeySha256: s.storeConfig.hostKeySha256 } : null,
    publicKey: getSecret(db, userId, 'sync.sshPublic') ?? null,
    syncId: s.syncId, epoch: s.epoch, signingFingerprint: ensureSyncKeys(userId).fingerprint,
    devices: listSyncDevices(userId).map((d) => ({ deviceId: d.deviceId, name: d.name, tier: d.tier, addedAt: d.addedAt })),
    lastPublishAt: s.lastPublishAt, lastError: s.lastError,
  };
}

export async function handleSyncRoute(req, res, { deps = {}, env = process.env } = {}) {
  const storeFor = deps.storeFor ?? defaultStoreFor;
  const path = String(req.url || '').split('?')[0];
  if (!verifyBusHostProof(req, env)) return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  const userId = req.user?.id;
  if (!userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in first');
  try {
    if (req.method === 'GET' && path === '/kb/sync/status') { send(res, 200, status(userId)); return true; }
    if (req.method === 'POST' && path === '/kb/sync/sftp') {
      const b = await readJson(req, 4096);
      const cfg = { host: String(b.host ?? '').trim(), port: Number(b.port), username: String(b.username ?? '').trim(), hostKeySha256: String(b.hostKeySha256 ?? '').trim() };
      const field = validateSftpConfig(cfg);
      if (field) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${field}`, { field });
      ensureSyncState(userId, { storeKind: 'sftp', storeConfig: cfg });
      const db = getDb();
      if (!getSecret(db, userId, 'sync.sshKey')) {
        const k = generateSshKey(`llmide-sync-${getSyncState(userId).syncId}`);
        setSecret(db, userId, 'sync.sshKey', k.privateKey);
        setSecret(db, userId, 'sync.sshPublic', k.publicLine);
      }
      send(res, 200, status(userId)); return true;
    }
    if (req.method === 'POST' && path === '/kb/sync/enabled') {
      const b = await readJson(req, 1024);
      if (typeof b.enabled !== 'boolean') return fail(res, 400, 'VALIDATION_FAILED', 'enabled must be a boolean', { field: 'enabled' });
      if (!getSyncState(userId)) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      setSyncEnabled(userId, b.enabled);
      send(res, 200, status(userId)); return true;
    }
    if (req.method === 'POST' && (path === '/kb/sync/test' || path === '/kb/sync/publish')) {
      const state = getSyncState(userId);
      const store = state && storeFor(userId);
      if (!store) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      try {
        if (path === '/kb/sync/test') {
          const probe = `${state.syncId}/probe.bin`;
          await store.put(probe, Buffer.from('ok'));
          const back = await store.get(probe);
          await store.remove(probe);
          if (!back || Buffer.from(back).toString() !== 'ok') return fail(res, 502, 'SYNC_IO', 'The store did not return what was written');
          send(res, 200, { ok: true }); return true;
        }
        send(res, 200, await syncCycle(userId, { store })); return true;
      } catch (e) {
        const code = String(e?.code || '').startsWith('SYNC_') ? e.code : 'SYNC_IO';
        return fail(res, code === 'SYNC_NOT_SET_UP' ? 409 : 502, code, 'Sync store error');
      } finally { await store.close?.(); }
    }
    return fail(res, 404, 'NOT_FOUND', 'No such sync route');
  } catch (e) {
    return fail(res, e?.status === 413 ? 413 : 400, 'VALIDATION_FAILED', 'Bad request');
  }
}
```

The public line is stored as the vault entry `sync.sshPublic`, which Task 2 already allowed as an internal key. It is
not secret, but no client may overwrite it.

- [ ] **Step 5: Wire `extension/server.mjs`**

Add the import after the Host API import (line 22):

```js
import { handleSyncRoute, isSyncRoute } from './routes/sync/http-routes.mjs';
```

Bump the version and record the wire change (line 324, with a comment line above it like the others):

```js
//   v112 — encrypted sync, additive (design docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md, migration 0064, contract schema/http/sync.schema.json): GET /kb/sync/status, POST /kb/sync/sftp { host, port, username, hostKeySha256 }, POST /kb/sync/test, POST /kb/sync/enabled { enabled }, POST /kb/sync/publish. JWT + bus host proof (403 HOST_PROOF_REQUIRED first). Never returns a private key, root key or folder capability. Status, sftp and enabled ride 'kbWrite'; test and publish ride 'dispatch'.
const SERVER_API_VERSION = 112;
```

Add to `ALL_ENDPOINTS` after `'/host-api/devices/:id',`:

```js
  '/kb/sync/status',
  '/kb/sync/sftp',
  '/kb/sync/test',
  '/kb/sync/enabled',
  '/kb/sync/publish',
```

In the rate-bucket function, next to `if (path === '/kb/calendar-ical/sources') return 'kbWrite';`:

```js
    if (path === '/kb/sync/test' || path === '/kb/sync/publish') return 'dispatch';
    if (path.startsWith('/kb/sync/')) return 'kbWrite';
```

Add the dispatch right after the Host API block (after line 812):

```js
  // Encrypted sync settings (/kb/sync/*): JWT + bus host proof; design docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md.
  if (isSyncRoute(req.url || '')) {
    try { await handleSyncRoute(req, res); } catch (err) { sendError(res, err, { logger: reqLog }); }
    return;
  }
```

Start the scheduler next to the engine prewarm (line 1507), never in tests:

```js
    if (process.env.NODE_ENV !== 'test') {
      void import('./routes/sync/scheduler.mjs').then((m) => m.startSyncScheduler({ logger })).catch((e) => logger.warn('sync_scheduler_failed', { message: e.message }));
    }
```

- [ ] **Step 6: Contract file and generated artefacts**

```json
{
  "description": "Encrypted sync settings (docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md): the desktop Settings card's routes. Served by extension/routes/sync/http-routes.mjs, dispatched from extension/server.mjs after authenticate and the rate limiter. Every route needs the JWT AND the bus host proof header x-llmide-host-nonce, checked first: without it 403 HOST_PROOF_REQUIRED. Per user. No route returns a private key, root key or device folder name. Errors: 400 VALIDATION_FAILED (details.field), 409 SYNC_NOT_SET_UP, 502 SYNC_HOST_KEY_MISMATCH|SYNC_AUTH_FAILED|SYNC_UNREACHABLE|SYNC_IO.",
  "$defs": {
    "Status": {
      "type": "object",
      "properties": {
        "configured": { "type": "boolean" },
        "enabled": { "type": "boolean" },
        "storeKind": { "type": ["string", "null"], "description": "sftp | box | mega | memory" },
        "store": { "type": ["object", "null"], "description": "sftp: { host, port, username, hostKeySha256 }" },
        "publicKey": { "type": ["string", "null"], "description": "the ssh-ed25519 authorized_keys line" },
        "syncId": { "type": ["string", "null"] },
        "epoch": { "type": ["integer", "null"] },
        "signingFingerprint": { "type": ["string", "null"], "description": "base64url SHA-256 of the desktop signing SPKI" },
        "devices": { "type": "array" },
        "lastPublishAt": { "type": ["integer", "null"] },
        "lastError": { "type": ["string", "null"], "description": "an error code only" }
      }
    }
  },
  "endpoints": {
    "GET /kb/sync/status": { "responses": { "200": { "$ref": "#/$defs/Status" } } },
    "POST /kb/sync/sftp": { "request": { "type": "object", "required": ["host", "port", "username", "hostKeySha256"] }, "responses": { "200": { "$ref": "#/$defs/Status" } } },
    "POST /kb/sync/test": { "responses": { "200": { "type": "object", "properties": { "ok": { "type": "boolean" } } } } },
    "POST /kb/sync/enabled": { "request": { "type": "object", "required": ["enabled"] }, "responses": { "200": { "$ref": "#/$defs/Status" } } },
    "POST /kb/sync/publish": { "responses": { "200": { "type": "object", "properties": { "publish": { "type": ["object", "null"] }, "drain": { "type": "object" } } } } }
  }
}
```

Save that as `schema/http/sync.schema.json`, then run:

```bash
node scripts/conformance-http.mjs
node scripts/http-inventory.mjs && node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs
make contract-gates
```

Expected: each command exits 0. If `conformance-http.mjs` names a missing fixture or a schema keyword, add exactly what
it names, following `schema/http/host-api.schema.json` and `schema/http/fixtures/host-api/`, and run it again.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-routes.test.mjs tests/server-features-health.test.mjs tests/lazy-engine.test.mjs`
Expected: PASS. The lazy-engine test proves the scheduler import is not on the boot path; `consumer.mjs` imports
`agent-v2.mjs` only inside its deps.

- [ ] **Step 8: Commit**

```bash
git add extension/routes/sync/scheduler.mjs extension/routes/sync/http-routes.mjs extension/tests/sync-routes.test.mjs extension/server.mjs extension/server/vault.mjs schema/http
git commit -m "feat(server): sync settings routes and background scheduler (API v112)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Settings card

**Files:**
- Create: `ui/screens/settings/sync-model.ts`, `ui/screens/settings/sections/SyncSection.tsx`
- Modify: `ui/screens/settings/sections/MobileBridge.tsx` (render `<SyncSection />` after `<HostApiPairing />`)
- Test: `ui/screens/settings/tests/sync-section.test.mjs`

**Interfaces:**
- Consumes: `call`, `ApiError`, `CoreClient` (`../core-api.ts`); `useEnv` (`../context.tsx`); `Button`, `ErrorText` (`../ui.tsx`); the Task 8 routes.
- Produces: `decodeSyncStatus(v: unknown): SyncStatus`, `loadSyncStatus(client)`, `saveSftp(client, cfg)`, `testSync(client)`, `setSyncEnabled(client, enabled)`, `publishNow(client)`, and the default export `SyncSection`.

- [ ] **Step 1: Write the failing test**

```js
// ui/screens/settings/tests/sync-section.test.mjs
// Sync card model: strict decoding of /kb/sync/status, and the calls the card makes. The card hides on HOST_PROOF_REQUIRED.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = resolve(HERE, "..");
const req = createRequire(join(resolve(SETTINGS, "../../.."), "desktop", "package.json"));
const { build } = req("esbuild");
let m;
before(async () => {
  const out = join(bundleDir("sync-section"), "sync-model.mjs");
  await build({ entryPoints: [join(SETTINGS, "sync-model.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  m = await import(pathToFileURL(out).href);
});
const fake = (routes) => { const calls = []; return { calls, async request(method, path, body) { calls.push(`${method} ${path} ${body ? JSON.stringify(body) : ""}`.trim()); return routes[`${method} ${path}`] ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }; } }; };
const STATUS = { configured: true, enabled: false, storeKind: "sftp", store: { host: "llm-ide.com", port: 22, username: "llmidesync", hostKeySha256: "SHA256:" + "A".repeat(43) },
  publicKey: "ssh-ed25519 AAAAC3Nza llmide-sync-x", syncId: "B".repeat(22), epoch: 1, signingFingerprint: "C".repeat(43), devices: [], lastPublishAt: null, lastError: null };

test("decodeSyncStatus accepts the route shape and rejects junk", () => {
  assert.equal(m.decodeSyncStatus(STATUS).store.host, "llm-ide.com");
  assert.throws(() => m.decodeSyncStatus({ ...STATUS, enabled: "no" }));
  assert.throws(() => m.decodeSyncStatus({ ...STATUS, publicKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }), "a private key is never shown");
});

test("calls go to the sync routes with the typed body", async () => {
  const c = fake({ "POST /kb/sync/sftp": { status: 200, body: STATUS }, "POST /kb/sync/enabled": { status: 200, body: { ...STATUS, enabled: true } }, "GET /kb/sync/status": { status: 403, body: { error: { code: "HOST_PROOF_REQUIRED", message: "x" } } } });
  await m.saveSftp(c, { host: "llm-ide.com", port: 22, username: "llmidesync", hostKeySha256: STATUS.store.hostKeySha256 });
  assert.equal((await m.setSyncEnabled(c, true)).enabled, true);
  assert.equal(await m.loadSyncStatus(c), null, "hidden without the host proof");
  assert.ok(c.calls[0].startsWith("POST /kb/sync/sftp"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs`
Expected: FAIL (esbuild cannot resolve `sync-model.ts`).

- [ ] **Step 3: Write `ui/screens/settings/sync-model.ts`**

```ts
// Settings → Phone and web sync: the model for the /kb/sync/* routes (schema/http/sync.schema.json). Strict decoding;
// the card hides when the core does not serve these routes to this UI (no bus host proof).
import { ApiError, call, type CoreClient } from "./core-api.ts";

export interface SftpConfig { host: string; port: number; username: string; hostKeySha256: string }
export interface SyncDevice { deviceId: string; name: string; tier: "web" | "ios"; addedAt: number }
export interface SyncStatus {
  configured: boolean; enabled: boolean; storeKind: string | null; store: SftpConfig | null; publicKey: string | null;
  syncId: string | null; epoch: number | null; signingFingerprint: string | null; devices: SyncDevice[];
  lastPublishAt: number | null; lastError: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const intOrNull = (v: unknown) => v === null || Number.isInteger(v);

export function decodeSyncStatus(v: unknown): SyncStatus {
  if (!isRecord(v) || typeof v.configured !== "boolean" || typeof v.enabled !== "boolean" || !strOrNull(v.storeKind)
    || !(v.publicKey === null || (typeof v.publicKey === "string" && /^ssh-ed25519 [A-Za-z0-9+/=]+( \S+)?$/.test(v.publicKey)))
    || !strOrNull(v.syncId) || !intOrNull(v.epoch) || !strOrNull(v.signingFingerprint) || !Array.isArray(v.devices)
    || !intOrNull(v.lastPublishAt) || !strOrNull(v.lastError)) throw new ApiError(0, "BAD_RESPONSE");
  const s = v.store;
  const store = isRecord(s) && typeof s.host === "string" && Number.isInteger(s.port) && typeof s.username === "string" && typeof s.hostKeySha256 === "string"
    ? { host: s.host, port: s.port as number, username: s.username, hostKeySha256: s.hostKeySha256 } : null;
  const devices = (v.devices as unknown[]).filter((d): d is SyncDevice => isRecord(d) && typeof d.deviceId === "string" && typeof d.name === "string"
    && (d.tier === "web" || d.tier === "ios") && typeof d.addedAt === "number");
  return { configured: v.configured, enabled: v.enabled, storeKind: v.storeKind as string | null, store, publicKey: v.publicKey as string | null,
    syncId: v.syncId as string | null, epoch: v.epoch as number | null, signingFingerprint: v.signingFingerprint as string | null, devices,
    lastPublishAt: v.lastPublishAt as number | null, lastError: v.lastError as string | null };
}

export async function loadSyncStatus(client: CoreClient): Promise<SyncStatus | null> {
  try { return decodeSyncStatus(await call(client, "GET", "/kb/sync/status")); }
  catch (e) { if (e instanceof ApiError && e.code === "HOST_PROOF_REQUIRED") return null; throw e; }
}
export const saveSftp = async (client: CoreClient, cfg: SftpConfig) => decodeSyncStatus(await call(client, "POST", "/kb/sync/sftp", cfg));
export const testSync = async (client: CoreClient) => { await call(client, "POST", "/kb/sync/test", {}); };
export const setSyncEnabled = async (client: CoreClient, enabled: boolean) => decodeSyncStatus(await call(client, "POST", "/kb/sync/enabled", { enabled }));
export const publishNow = async (client: CoreClient) => call(client, "POST", "/kb/sync/publish", {});
```

Before writing this step, check `ui/screens/settings/core-api.ts` (`CoreClient`, `ApiError`, `call`): confirm that
`call(client, method, path, body?)` returns the parsed body on 2xx and throws `ApiError` with `.code` from `error.code`,
as `HostApiPairing.tsx` relies on. Also confirm that a fake `{ request(method, path, body) }` satisfies `CoreClient`, as
`tests/host-api-pairing.test.mjs` does. If the parameter order differs, adapt the five call sites above to it.

- [ ] **Step 4: Write `ui/screens/settings/sections/SyncSection.tsx`**

```tsx
// Settings → Phone and web sync (desktop off): the own-server (SFTP) store setup, connection test, on/off and "Publish
// now". Shows the public key to install on the server and the host-key fingerprint the user pasted; never a private key.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { loadSyncStatus, saveSftp, testSync, setSyncEnabled, publishNow, type SyncStatus } from "../sync-model.ts";

export default function SyncSection(): ReactNode {
  const { client } = useEnv();
  const [status, setStatus] = useState<SyncStatus | null | undefined>(undefined);
  const [form, setForm] = useState({ host: "", port: "22", username: "llmidesync", hostKeySha256: "" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null); setNote(null);
    try { await fn(); setStatus(await loadSyncStatus(client)); if (ok) setNote(ok); } catch (e) { setError(describeError(e)); }
  }, [client]);
  useEffect(() => { void loadSyncStatus(client).then((s) => {
    setStatus(s);
    if (s?.store) setForm({ host: s.store.host, port: String(s.store.port), username: s.store.username, hostKeySha256: s.store.hostKeySha256 });
  }, (e) => setError(describeError(e))); }, [client]);
  if (status === null) return null;
  const field = (name: keyof typeof form, label: string) => (
    <label className="st-field">{label}
      <input value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} aria-label={label} spellCheck={false} />
    </label>
  );
  return (
    <section className="st-card" aria-labelledby="sync-title">
      <h3 id="sync-title">Phone and web sync</h3>
      <p>With the desktop off, the phone and web app read an encrypted copy of your chats, meetings, plans and usage from your own server, and queue chat prompts that run when the desktop is back. The server only stores ciphertext.</p>
      {field("host", "Server")}{field("port", "SSH port")}{field("username", "Sync account")}
      {field("hostKeySha256", "Server host key (SHA256:… from ssh-keygen -lf on the server)")}
      <Button onClick={() => run(() => saveSftp(client, { host: form.host.trim(), port: Number(form.port), username: form.username.trim(), hostKeySha256: form.hostKeySha256.trim() }), "Saved.")}>Save</Button>
      {status?.publicKey && (
        <div className="st-stack">
          <p>Add this line once to <code>/etc/ssh/authorized_keys/{form.username || "llmidesync"}</code> on the server (see deploy/vps/sync-sftp.md):</p>
          <pre className="st-code" aria-label="Public key">{`restrict ${status.publicKey}`}</pre>
          <p>Desktop signing key fingerprint: <code>{status.signingFingerprint}</code></p>
          <Button onClick={() => run(() => testSync(client), "Connection works.")}>Test connection</Button>
          <label className="st-toggle"><input type="checkbox" checked={status.enabled} onChange={(e) => run(() => setSyncEnabled(client, e.target.checked))} /> Sync on</label>
          <Button onClick={() => run(() => publishNow(client), "Published.")} disabled={!status.enabled}>Publish now</Button>
          <p aria-live="polite">{status.lastError ? `Last error: ${status.lastError}` : status.lastPublishAt ? `Last published ${new Date(status.lastPublishAt).toLocaleString()}` : "Not published yet."} · {status.devices.length} device(s)</p>
        </div>
      )}
      {note && <p aria-live="polite">{note}</p>}
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
```

Before writing this step, check that `useEnv()` exposes `client` and that `describeError` exists in `../errors.ts`; both
are used by `HostApiPairing.tsx`. If the class names `st-card`, `st-field`, `st-toggle` or `st-code` do not exist in
`settings.css`, use the classes `HostApiPairing.tsx` uses.

- [ ] **Step 5: Render it in Mobile Control**

In `ui/screens/settings/sections/MobileBridge.tsx`:

```tsx
import SyncSection from "./SyncSection.tsx";
```

```tsx
      <HostApiPairing />
      <SyncSection />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs ../ui/screens/settings/tests/host-api-pairing.test.mjs && npm run typecheck --if-present`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add ui/screens/settings/sync-model.ts ui/screens/settings/sections/SyncSection.tsx ui/screens/settings/sections/MobileBridge.tsx ui/screens/settings/tests/sync-section.test.mjs
git commit -m "feat(ui): phone and web sync card in Settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Server setup files, check script and docs

**Files:**
- Create: `deploy/vps/sync-sftp.md`, `deploy/vps/sshd-llmidesync.conf`, `deploy/vps/llm-ide-sync.nginx.inc`, `deploy/vps/sync-check.sh`
- Modify: `deploy/vps/llm-ide.com.nginx` (include + `limit_req_zone`), `extension/CLAUDE.md` (a new section)
- Test: `deploy/vps/sync-check.sh`, which the user runs against the server

**Interfaces:**
- Consumes: the folder layout (Global Constraints), the sshd and nginx blocks from spec §8.1.
- Produces: a server the desktop can reach as `llmidesync@llm-ide.com:22`, and the `/sync/` HTTPS location for SP3 and SP4.

- [ ] **Step 1: Write `deploy/vps/sshd-llmidesync.conf`**

```text
# /etc/ssh/sshd_config.d/50-llmidesync.conf: SFTP-only, chrooted, key-only account for LLM-IDE encrypted sync.
# Design: docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md section 8.1. Only ciphertext lands here.
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

- [ ] **Step 2: Write `deploy/vps/llm-ide-sync.nginx.inc`**

```nginx
# Included inside the llm-ide.com server {} block. Each device can read only its own folder and write only new request
# files into its own inbox. The 22-character folder name is the capability, so access logs are off here.
location ~ "^/sync/(?<sid>[A-Za-z0-9_-]{22})/d/(?<dir>[A-Za-z0-9_-]{22})/(?<f>key\.bin|wrap\.bin|manifest\.bin|s/[0-9a-f]{32}\.bin|out/[A-Za-z0-9_-]{22}\.bin)$" {
    limit_except GET { deny all; }
    alias /srv/llmide-sync/data/$sid/d/$dir/$f;
    access_log off;
    error_log /var/log/nginx/error.log crit;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options "nosniff" always;
    default_type application/octet-stream;
    limit_req zone=llmidesync burst=40 nodelay;
}
location ~ "^/sync/(?<sid>[A-Za-z0-9_-]{22})/(?<f>d/[A-Za-z0-9_-]{22}/in/[0-9]{13}-[A-Za-z0-9_-]{22}\.bin|e/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}\.bin)$" {
    limit_except PUT { deny all; }
    alias /srv/llmide-sync/data/$sid/$f;
    dav_methods PUT;
    create_full_put_path off;
    dav_access group:rw;
    client_max_body_size 64k;
    access_log off;
    error_log /var/log/nginx/error.log crit;
    limit_req zone=llmidesync burst=10 nodelay;
}
location ^~ /sync/ { access_log off; return 404; }
```

In `deploy/vps/llm-ide.com.nginx`, add `limit_req_zone $binary_remote_addr zone=llmidesync:1m rate=2r/s;` at the top of the
file (http context, outside `server {}`) and `include /etc/nginx/snippets/llm-ide-sync.nginx.inc;` inside the TLS `server {}` block.

- [ ] **Step 3: Write `deploy/vps/sync-check.sh`**

```bash
#!/usr/bin/env bash
# Checks the /sync/ location from outside: no listing, no writes outside an inbox, size cap, unknown paths 404.
# Usage: deploy/vps/sync-check.sh https://llm-ide.com
set -euo pipefail
B="${1:?base url}"
S=$(printf 'A%.0s' {1..22}); D=$(printf 'B%.0s' {1..22}); R=$(printf 'C%.0s' {1..22})
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
fail=0
expect() { local want=$1 got=$2 what=$3; if [[ "$got" != "$want" ]]; then echo "FAIL $what: got $got want $want"; fail=1; else echo "ok   $what ($got)"; fi; }
expect 404 "$(code "$B/sync/")" "no listing at /sync/"
expect 404 "$(code "$B/sync/$S/d/$D/")" "no listing of a device folder"
expect 404 "$(code "$B/sync/$S/d/$D/manifest.bin")" "absent manifest is 404"
expect 405 "$(code -X PUT --data x "$B/sync/$S/d/$D/manifest.bin")" "no PUT on manifest"
expect 404 "$(code -X PUT --data x "$B/sync/$S/d/$D/in/../wrap.bin")" "no traversal"
expect 413 "$(code -X PUT --data-binary @<(head -c 70000 /dev/zero) "$B/sync/$S/d/$D/in/1762300000000-$R.bin")" "64 KiB cap"
expect 404 "$(code "$B/sync/$S/other.bin")" "unknown path 404"
exit $fail
```

`limit_except GET` answers 403 for a PUT in nginx unless DAV methods are enabled. If the first run prints `got 403 want 405` for
"no PUT on manifest", change that expectation to 403: both mean refused. Record the observed value in `sync-sftp.md`.

- [ ] **Step 4: Write `deploy/vps/sync-sftp.md`**

````markdown
# Encrypted sync on your own server (SFTP + nginx)

Design: [docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md](../../docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md) §8.1.
Only ciphertext is ever stored here. The desktop connects as `llmidesync` with a key it generated; phones and the web app
read and write only their own folder through `https://llm-ide.com/sync/`.

## 1. Account and folders (root)

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin llmidesync
install -d -m 755 -o root -g root /srv/llmide-sync
install -d -m 2770 -o llmidesync -g llmidesync /srv/llmide-sync/data
usermod -aG llmidesync www-data
install -d -m 755 /etc/ssh/authorized_keys
```

## 2. The desktop's key

In the desktop app: Settings → Mobile Control → Phone and web sync. Enter the server, port 22, account `llmidesync`, and the
host key fingerprint printed by:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # copy the SHA256:… part
```

Save, then copy the `restrict ssh-ed25519 …` line the card shows into the server:

```bash
printf '%s\n' 'restrict ssh-ed25519 AAAA… llmide-sync-…' > /etc/ssh/authorized_keys/llmidesync
chmod 644 /etc/ssh/authorized_keys/llmidesync
```

## 3. sshd

```bash
cp deploy/vps/sshd-llmidesync.conf /etc/ssh/sshd_config.d/50-llmidesync.conf
sshd -t && systemctl reload ssh
```

## 4. nginx

```bash
nginx -V 2>&1 | grep -o http_dav_module          # must print http_dav_module
cp deploy/vps/llm-ide-sync.nginx.inc /etc/nginx/snippets/llm-ide-sync.nginx.inc
# add the limit_req_zone line and the include to the llm-ide.com vhost (see deploy/vps/llm-ide.com.nginx)
nginx -t && systemctl reload nginx
deploy/vps/sync-check.sh https://llm-ide.com
```

## 5. Check from the desktop

Settings → Test connection → "Connection works." Then turn Sync on.
`ssh llmidesync@llm-ide.com` must be refused a shell; `sftp llmidesync@llm-ide.com` lands in `/data`.

## Revoke without the desktop

`rm -r /srv/llmide-sync/data/<syncId>/d/<folder>`. The desktop drops that device on its next start (sub-project SP2).
To cut the desktop off: empty `/etc/ssh/authorized_keys/llmidesync`.
````

- [ ] **Step 5: Add the `extension/CLAUDE.md` section** (after "Host API v1 (desktop)")

```markdown
## Sync (desktop producer)

- **What**: encrypted snapshots (chats, meetings, plans, usage) and a queued-prompt inbox in a user-owned folder, for the phone and web with the desktop off. Design `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md`, ADR 0020.
- **Where**: envelope `core/sync-envelope.mjs` (relay v1 bytes + `snapshot`/`manifest`/`syncwrap`; vectors `schema/sync/v1`, check `node scripts/sync-vectors.mjs`); stores `connectors/sync-store/` (memory, SFTP via `ssh2`); state `kb/sync-state.mjs` (migration 0064); keys in the vault (`sync.rootKey`, `sync.signingKey`, `sync.sshKey`, `sync.sshPublic`, all internal); producer/consumer/scheduler/routes `routes/sync/`.
- **Ceiling**: queued requests are `chat.send` only and run only through `startHostTurn` (`auto_read_only`, phone chat); an approval request cancels the turn and replies `needs_approval`; record-before-execute in `sync_requests`.
- **Off switch**: `LLMIDE_SYNC=off` starts no scheduler; per user, Settings "Sync on" (`sync_state.enabled`).
- **Never** log keys, folder names, `es` or decrypted content.
```

- [ ] **Step 6: Verify**

Run: `cd extension && npm test` (all extension tests), then `make contract-gates`. The user runs
`deploy/vps/sync-check.sh https://llm-ide.com` after Steps 1 to 4 of `sync-sftp.md` and, optionally,
`LLMIDE_SYNC_SFTP_IT=llmidesync@llm-ide.com:22 LLMIDE_SYNC_SFTP_IT_KEY=… LLMIDE_SYNC_SFTP_IT_HOSTKEY=SHA256:… node --test tests/sync-store-sftp.test.mjs`.
Expected: all green; the check script prints only `ok` lines; the live SFTP test passes.

- [ ] **Step 7: Commit**

```bash
git add deploy/vps/sync-sftp.md deploy/vps/sshd-llmidesync.conf deploy/vps/llm-ide-sync.nginx.inc deploy/vps/sync-check.sh deploy/vps/llm-ide.com.nginx extension/CLAUDE.md
git commit -m "docs(deploy): own-server SFTP and nginx setup for encrypted sync" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage (SP1 rows of spec §14):**

| Spec requirement | Task |
|---|---|
| `SyncStore` interface, path rules, contract suite (§2.1) | 3 |
| SFTP adapter, host key pinned, never TOFU, desktop-generated ed25519 key (§8.1) | 4, 8 |
| sync v1 envelope = relay v1 + purposes, shared vectors (§4.1, §13) | 1 |
| Keys held by the desktop in the vault (§5.1) | 2, 6 |
| Folder layout, per-device copies, one writer per file (§3, §7) | 6, 7 |
| Snapshot kinds, redaction, size cap, truncation (§4.2) | 5 |
| Manifest with `manifestSeq`, `validUntil`, hash binding; heartbeat (§4.3) | 6 |
| Hybrid counter (§4.5) | 2 |
| Inbox at the read-only ceiling: closed schema, signature, age, record-before-execute, quota, approval → `needs_approval`, outbox 7 days (§4.4, §6) | 7 |
| Failure behaviour: back-off, coded errors, orphan clean-up (§12) | 4, 6, 8 |
| Settings controls (setup, test, on/off, publish now, status) | 8, 9 |
| Server setup: sshd Match block, nginx location, check script (§8.1) | 10 |
| Blindness test (§13) | 6 |

Not covered here, by design, because they belong to later sub-projects:

- enrollment, slot, SAS, revoke and rotate (SP2);
- the PWA and iOS readers (SP3, SP4);
- Box (SP5) and MEGA (SP6);
- direct reads (SP7);
- parking ADR 0019 (SP8).

The `memory` store kind exists only for tests and is never offered in Settings.

**Placeholder scan:** Three steps check an existing helper's signature (`core-api.ts` `call`, `useEnv`, CSS class names) and
one step reads a gate's output (`conformance-http.mjs`). Each says exactly what to check and what to do. No step reads
"TBD" or "add error handling".

**Type consistency:**

- `deviceKeys()` returns `{ request, reply, snapshot, manifest }` in Tasks 1, 6 and 7.
- `ensureSyncKeys()` returns `{ root, epoch, signingKey, signingSpki, fingerprint }` in Tasks 6, 7 and 8.
- `SyncStore` methods (`put/get/list/remove/removeTree/describe`, plus `close` on SFTP) match Tasks 3, 4, 6, 7 and 8.
- `listSyncDevices()` fields (`deviceId, dir, tier, name, ecdhSpki, signingSpki, addedAt, wrapEpoch`) match Tasks 2, 6, 7 and 8.
- The vault key `sync.sshPublic` (used in Task 8) is allowed in Task 2.
````
