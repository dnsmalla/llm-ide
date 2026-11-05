# Encrypted Sync, Desktop Producer (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop core publishes end-to-end-encrypted snapshots of chats, meetings, plans and usage into a
user-owned folder, and runs queued phone and web chat prompts from that folder's inbox at the fixed read-only
ceiling. The storage sits behind a `SyncStore` interface, and the first real adapter is MEGA (a dedicated MEGA
account used only for LLM-IDE).

**Architecture:** The envelope library is `extension/core/sync-envelope.mjs`, a byte-for-byte port of relay v1
plus the purposes `snapshot`, `manifest` and `syncwrap`. Storage adapters live in
`extension/connectors/sync-store/` (memory for tests, MEGA over `megajs`). Durable state is in the new tables of
migration 0064 (`extension/kb/sync-state.mjs`). Keys live in the core vault. The producer, the consumer, the
scheduler and the HTTP routes live under `extension/routes/sync/`. The consumer calls `startHostTurn`, which is
in the routes layer. Settings gets one card in the shared UI. **No Rust change:** another agent is editing
`desktop/src-tauri`, and the vault master key is already in the OS keychain (`secrets.rs`).

**Tech Stack:** Node 22 core (pure `node:http`, `node:crypto`, better-sqlite3), `megajs` 1.3.10 (new, exact pin),
React 19 + TypeScript Settings card, Node test runner.

**Spec:** [docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md](../specs/2026-11-05-box-encrypted-sync-design.md)
(ADR: [docs/decisions/0020-box-encrypted-sync.md](../../decisions/0020-box-encrypted-sync.md)).

> **User decision, 2026-11-05:** MEGA is the first storage adapter, for now. The plan's filename keeps the approved
> "box" name. The user's own server over SFTP (with its nginx endpoint and sshd setup) is a later sub-project with
> its own plan (spec §14, SP5), and Box after it (SP6). The credential custody for MEGA is spec §8.3 and Q8: a
> dedicated MEGA account, email and password in the core vault only, two-factor login off on that account only.
> The desktop's MEGA client is `megajs` (MIT, unofficial). This plan writes only the desktop side; the PWA and
> iPhone MEGA clients belong to SP3 and SP4.

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
- Never log keys, `es`, folder names (`dir`), decrypted content, or the MEGA email or password. Logs carry counts and codes only.
  The MEGA password never leaves the core: no route returns it, and the Settings webview only sends it once on Save.
- Bump `SERVER_API_VERSION` to 112 and add the new paths to `ALL_ENDPOINTS`.
- New dependency: `megajs` exactly `1.3.10` (npm `latest`, MIT, published 2026-04-20, one maintainer, repository
  `qgustavor/mega` last pushed 2026-04-20, not archived), with a justification comment. Its transitive packages
  (`pumpify`, `stream-skip` and their own dependencies) must all be MIT or ISC. No other new dependency.
- MEGA: one dedicated account, recommended in the UI; email and password only in the vault (`sync.megaEmail`,
  `sync.megaPassword`, internal keys); two-factor login is not supported for the sync account (MEGA's `EMFAREQUIRED`
  becomes `SYNC_MFA_REQUIRED` with guidance); one logged-in session per user is reused while the core runs, logged out
  on shutdown or when the setup changes; an expired session (`ESID`) re-logs in once; `EAGAIN`/`ERATELIMIT`/
  `ETEMPUNAVAIL` are retried twice (2 s, 8 s) and then surface as `SYNC_RATE_LIMITED`, which the scheduler backs off;
  the sync folder (default `llmide-sync`) sits at the root of the account's Cloud Drive and is created on first use;
  deletes are permanent (no rubbish bin); only sealed sync v1 envelopes are uploaded, on top of MEGA's own encryption.
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
| `extension/server/vault.mjs` | **modify (shared)** | allow internal keys `sync.rootKey`, `sync.signingKey`, `sync.megaEmail`, `sync.megaPassword` |
| `extension/connectors/sync-store/index.mjs` | create | `checkPath`, `MAX_FILE_BYTES`, `createMemoryStore` |
| `extension/tests/helpers/sync-store-contract.mjs` | create | the contract suite every adapter runs |
| `extension/tests/sync-store-memory.test.mjs` | create | |
| `extension/connectors/sync-store/mega.mjs` | create | the MEGA adapter: login and session reuse, error mapping, retry, folder, watch |
| `extension/tests/helpers/fake-mega.mjs` | create | an in-memory stand-in for the `megajs` `Storage` surface the adapter uses |
| `extension/tests/sync-store-mega.test.mjs` | create | contract suite on the fake MEGA client, unit tests, plus an opt-in live run |
| `extension/package.json`, `extension/package-lock.json` | **modify (shared)** | `megajs` 1.3.10 |
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
| `extension/CLAUDE.md` | **modify (shared)** | a "Sync (desktop producer)" section |

**Shared-file edits (coordinate with other agents):** `extension/server.mjs`, `extension/server/vault.mjs`,
`extension/package.json`/`package-lock.json`, `ui/screens/settings/sections/MobileBridge.tsx`, `extension/CLAUDE.md`,
the generated `schema/http/INVENTORY.md`, types and openapi. Nothing under `deploy/` changes: MEGA needs no server.
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
  - Vault internal keys `sync.rootKey`, `sync.signingKey`, `sync.megaEmail`, `sync.megaPassword` (readable through `getSecret`/`setSecret`, never client-settable or listed)

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
  const a = st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
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
  for (const k of ['sync.rootKey', 'sync.signingKey', 'sync.megaEmail', 'sync.megaPassword']) {
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
-- Additive, N-1 safe. No key or secret is stored here: keys and the MEGA login live in the vault (sync.rootKey,
-- sync.signingKey, sync.megaEmail, sync.megaPassword). store_config is non-secret (MEGA: the folder name only).
-- 'sftp' and 'box' are listed now so the later adapters (spec section 14) need no table rebuild.
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

In `extension/server/vault.mjs`, add four entries at the end of the `ALLOWED_KEYS` set (after `'email.imapPasswordHost'`), and extend `INTERNAL_KEYS`:

```js
  // Encrypted sync (routes/sync/keys.mjs, routes/sync/http-routes.mjs): the per-epoch root key, the desktop ECDSA
  // P-256 signing key (PKCS8), and the dedicated MEGA account's email and password for the MEGA adapter.
  // Server-internal: never client-settable through /kb/vault, never listed, never returned by a route.
  'sync.rootKey',
  'sync.signingKey',
  'sync.megaEmail',
  'sync.megaPassword',
```

```js
const INTERNAL_KEYS = new Set(['email.imapPasswordHost', 'sync.rootKey', 'sync.signingKey', 'sync.megaEmail', 'sync.megaPassword']);
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

### Task 4: MEGA adapter (dedicated account) with session reuse and rate-limit back-off

**Files:**
- Create: `extension/connectors/sync-store/mega.mjs`
- Create: `extension/tests/helpers/fake-mega.mjs`
- Modify: `extension/package.json` (dependency + justification), `extension/package-lock.json`
- Test: `extension/tests/sync-store-mega.test.mjs`

**Interfaces:**
- Consumes: `checkPath`, `checkSize`, `MAX_FILE_BYTES` (Task 3); `runSyncStoreContract` (Task 3).
- Produces:
  - `DEFAULT_MEGA_FOLDER = 'llmide-sync'`
  - `validateMegaConfig({ email, password, folder }): string|null` (null = valid; otherwise the field name `email | password | folder`)
  - `maskEmail(email: string): string`, for example `'l***@example.com'`
  - `classifyMegaError(e: Error, { duringLogin?: boolean }): string`, one of `SYNC_SESSION_EXPIRED | SYNC_MFA_REQUIRED | SYNC_RATE_LIMITED | SYNC_QUOTA | SYNC_AUTH_FAILED | SYNC_UNREACHABLE | SYNC_IO`
  - `createMegaStore({ folder }, { email, password }, { login?, sleep? }): SyncStore & { watch(dir, onChange): () => void, close(): Promise<void> }`.
    Errors carry `code` in `SYNC_AUTH_FAILED | SYNC_MFA_REQUIRED | SYNC_RATE_LIMITED | SYNC_QUOTA | SYNC_UNREACHABLE | SYNC_IO`,
    plus `SYNC_BAD_PATH | SYNC_TOO_LARGE` from Task 3. `describe()` returns `{ kind: 'mega', root: <folder>, account: <masked email> }`.
    `watch` returns its `stop` function.
  - Test helper `createFakeMega({ email, password })` with `login`, `root`, `failNext(op, message)`, `loseSessions()`,
    `flush()`, and the counters `logins`, `logouts`, `permanentDeletes`, `uploads`.

**Facts this task relies on** (read from the `megajs@1.3.10` package, `dist/main.node-es.mjs` and `types/es.d.ts`, on 2026-11-05):

- ESM entry `import { Storage } from 'megajs'`. `new Storage({ email, password, keepalive, autoload, userAgent })` logs in at
  once. `storage.ready` resolves when it is logged in and, with `autoload: true`, has loaded the whole file tree.
  `secondFactorCode` is the only 2FA input, and this adapter never sets it.
- `storage.root` is the Cloud Drive. A node has `nodeId`, `name`, `directory`, `size`, `timestamp` (seconds), `parent` and
  `children`. `node.mkdir(name)` returns the new folder. `node.upload({ name, size }, buffer).complete` resolves to the new
  file. `file.downloadBuffer({})` resolves to a `Buffer`. `node.delete(true)` deletes permanently; without `true` it moves the
  node to the rubbish bin.
- `storage.close()` logs the session out (`sml`).
- MEGA errors are plain `Error`s whose message starts with `"ENAME (-n): …"`, for example
  `"ERATELIMIT (-4): You have exceeded your command weight per time quota…"`, `"ESID (-15): Invalid or expired user session, please relogin"`,
  and `"EMFAREQUIRED (-26): Multi-Factor Authentication Required"`. The library retries `EAGAIN (-3)` 4 times on its own
  (2, 4, 8 and 16 s) before it reports it. It also answers MEGA's `X-Hashcash` login challenge on its own.
- With `keepalive: true` the library long-polls MEGA's server-command channel. It applies remote changes to the tree and
  emits `add`, `update` and `delete` on the storage. A failed poll emits `error` on `storage.api`. **An `error` event with no
  listener throws and would crash the core, so the adapter always attaches one.** A delete reaches the local tree only
  when its server packet arrives, so the adapter hides the nodes it deleted itself until then.
- `Storage#toJSON()` serialises the session id **and the account master key**. The adapter never persists it, because it
  is as powerful as the password (spec §8.3).

- [ ] **Step 1: Add the dependency and check its licenses**

```bash
cd extension && npm install --save-exact megajs@1.3.10
```

In `extension/package.json`, add a `"//"` key next to `"dependencies"` (JSON has no comments, and the file has no `"//"`
key yet):

```json
  "//": "megajs 1.3.10 (exact): MEGA client for the first encrypted-sync adapter (connectors/sync-store/mega.mjs), user decision 2026-11-05. MEGA ships no Node SDK and no OAuth; megajs is MIT, unofficial, fetch-based, no native code. Exact pin because it handles the sync account's password. No other MEGA code in the repo.",
```

Run:

```bash
cd extension && node -e "import('megajs').then(m => console.log(typeof m.Storage))"
npm view megajs@1.3.10 license
git diff -U0 package-lock.json | grep -o '"node_modules/[^"]*": {' | sed 's/": {//; s/"//g' | sort -u | while read p; do node -p "'$p ' + require('./$p/package.json').license"; done
```

Expected: `function`, then `MIT`, then one line per newly locked package, each ending in `MIT` or `ISC`. Packages the
lockfile already had (`once`, `readable-stream`, …) do not appear. If any line shows another license, stop and report it.
Do not add the package.

- [ ] **Step 2: Write the fake MEGA client**

```js
// extension/tests/helpers/fake-mega.mjs
// An in-memory stand-in for the part of megajs 1.3.10's Storage that connectors/sync-store/mega.mjs uses: storage.root (the
// Cloud Drive); node.nodeId/name/directory/size/timestamp/parent/children; node.mkdir(name); node.upload({ name, size },
// buffer).complete; node.downloadBuffer({}); node.delete(permanent); storage.on('add'|'update'|'delete'); storage.close().
// As with the real client, a delete reaches the local tree only when the server's packet arrives (here: flush()), and
// errors are plain Errors carrying megajs's "ENAME (-n): ..." message. No network.
import { EventEmitter } from 'node:events';

const ENOENT = 'ENOENT (-9): Object (typically, node or user) not found. Wrong password?';

export function createFakeMega({ email, password }) {
  const queued = [];          // [{ op, message }]: the next call of `op` fails with `message`
  const sessions = new Set(); // live fake Storage objects
  const pendingDeletes = [];  // deleted nodes still in the tree until flush()
  let ids = 0;
  const emit = (event, node) => { for (const s of sessions) s.emit(event, node); };
  const gate = async (op) => {
    const i = queued.findIndex((q) => q.op === op);
    if (i >= 0) throw new Error(queued.splice(i, 1)[0].message);
  };
  const fake = {
    logins: 0, logouts: 0, permanentDeletes: 0, uploads: [],
    failNext(op, message) { queued.push({ op, message }); },
    loseSessions() { for (const s of [...sessions]) s.lose(); },
    flush() {
      for (const n of pendingDeletes.splice(0)) {
        n.parent.children.splice(n.parent.children.indexOf(n), 1);
        emit('delete', n);
      }
    },
  };
  const makeNode = ({ name, directory, parent, data = null }) => {
    const n = {
      nodeId: `n${++ids}`, name, directory, parent, data, deleted: false,
      size: data ? data.length : 0, timestamp: Math.floor(Date.now() / 1000), children: directory ? [] : undefined,
      async mkdir(opt) {
        await gate('mkdir');
        const c = makeNode({ name: typeof opt === 'string' ? opt : opt.name, directory: true, parent: n });
        n.children.push(c);
        emit('add', c);
        return c;
      },
      upload(opt, source) {
        return { complete: (async () => {
          await gate('upload');
          if (!Buffer.isBuffer(source) || source.length !== opt.size) throw new Error('Specified data size does not match');
          const c = makeNode({ name: opt.name, directory: false, parent: n, data: Buffer.from(source) });
          n.children.push(c);
          fake.uploads.push(Buffer.from(source));
          emit('add', c);
          return c;
        })() };
      },
      async downloadBuffer() {
        await gate('download');
        if (n.deleted) throw new Error(ENOENT);
        return Buffer.from(n.data);
      },
      async delete(permanent) {
        await gate('delete');
        if (permanent !== true) throw new Error('fake-mega: sync deletes must be permanent (no rubbish bin)');
        if (n.deleted) throw new Error(ENOENT);
        n.deleted = true;
        fake.permanentDeletes++;
        pendingDeletes.push(n);
      },
    };
    return n;
  };
  fake.root = makeNode({ name: 'Cloud Drive', directory: true, parent: null });
  fake.login = async (creds, { onLost } = {}) => {
    fake.logins++;
    await gate('login');
    if (creds.email !== email || creds.password !== password) throw new Error(ENOENT);
    const s = new EventEmitter();
    s.root = fake.root;
    s.lose = () => { sessions.delete(s); onLost?.(new Error('ESID (-15): Invalid or expired user session, please relogin')); };
    s.close = async () => { sessions.delete(s); fake.logouts++; };
    sessions.add(s);
    return s;
  };
  return fake;
}
```

- [ ] **Step 3: Write the failing test**

```js
// extension/tests/sync-store-mega.test.mjs
// The MEGA adapter runs the SyncStore contract on a fake MEGA client (tests/helpers/fake-mega.mjs): no network in CI.
// A live run against a real THROWAWAY MEGA account is opt-in and manual:
//   LLMIDE_SYNC_MEGA_IT=1 LLMIDE_SYNC_MEGA_IT_EMAIL=... LLMIDE_SYNC_MEGA_IT_PASSWORD=... node --test tests/sync-store-mega.test.mjs
// Never point it at a personal account: it writes and deletes under the Cloud Drive folder "llmide-sync-it".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMegaStore, validateMegaConfig, maskEmail, classifyMegaError, DEFAULT_MEGA_FOLDER } from '../connectors/sync-store/mega.mjs';
import { createFakeMega } from './helpers/fake-mega.mjs';
import { runSyncStoreContract } from './helpers/sync-store-contract.mjs';

const CREDS = { email: 'llmide-sync@example.com', password: 'a long dedicated password' };
const CFG = { folder: DEFAULT_MEGA_FOLDER };
function make(fake = createFakeMega(CREDS)) {
  const sleeps = [];
  const store = createMegaStore(CFG, CREDS, { login: fake.login, sleep: async (ms) => { sleeps.push(ms); } });
  return { fake, store, sleeps };
}

runSyncStoreContract(test, assert, async () => make().store, 'mega (fake client)');

test('one login serves every operation; close logs out', async () => {
  const { fake, store } = make();
  await store.put('a/x.bin', Buffer.from('1'));
  await store.get('a/x.bin');
  await store.list('a');
  await store.remove('a/x.bin');
  assert.equal(fake.logins, 1);
  await store.close();
  assert.equal(fake.logouts, 1);
});

test('the sync folder is created once, at the Cloud Drive root, with the configured name', async () => {
  const fake = createFakeMega(CREDS);
  await make(fake).store.put('a.bin', Buffer.from('1'));
  await make(fake).store.put('b.bin', Buffer.from('2'));
  assert.deepEqual(fake.root.children.filter((c) => c.directory).map((d) => d.name), ['llmide-sync']);
  await createMegaStore({ folder: 'other-sync' }, CREDS, { login: fake.login }).put('c.bin', Buffer.from('3'));
  assert.deepEqual(fake.root.children.filter((c) => c.directory).map((d) => d.name).sort(), ['llmide-sync', 'other-sync']);
});

test('replace uploads exactly the given bytes, then deletes the old copy permanently', async () => {
  const { fake, store } = make();
  await store.put('d/manifest.bin', Buffer.from('old'));
  await store.put('d/manifest.bin', Buffer.from('new'));
  assert.deepEqual(fake.uploads.map((b) => b.toString()), ['old', 'new'], 'the adapter adds nothing to the bytes');
  assert.equal(fake.permanentDeletes, 1);
  fake.flush();
  const dir = fake.root.children[0].children.find((c) => c.name === 'd');
  assert.deepEqual(dir.children.map((c) => c.data.toString()), ['new']);
  assert.equal(Buffer.from(await store.get('d/manifest.bin')).toString(), 'new');
});

test('an expired session logs in again once; a lost keepalive session is replaced', async () => {
  const { fake, store } = make();
  await store.put('e/x.bin', Buffer.from('1'));
  fake.failNext('download', 'ESID (-15): Invalid or expired user session, please relogin');
  assert.equal(Buffer.from(await store.get('e/x.bin')).toString(), '1');
  assert.equal(fake.logins, 2);
  fake.loseSessions();
  await store.list('e');
  assert.equal(fake.logins, 3);
});

test('MEGA rate limits are retried twice (2 s, 8 s), then surface as SYNC_RATE_LIMITED', async () => {
  const { fake, store, sleeps } = make();
  fake.failNext('upload', 'ERATELIMIT (-4): You have exceeded your command weight per time quota.');
  await store.put('r/1.bin', Buffer.from('1'));
  assert.deepEqual(sleeps, [2000]);
  for (let i = 0; i < 3; i++) fake.failNext('download', 'EAGAIN (-3): A temporary congestion or server malfunction prevented your request from being processed.');
  await assert.rejects(() => store.get('r/1.bin'), (e) => e.code === 'SYNC_RATE_LIMITED');
  assert.deepEqual(sleeps, [2000, 2000, 8000]);
});

test('a wrong password and a two-factor account give codes that never carry the credentials', async () => {
  const fake = createFakeMega(CREDS);
  const wrong = createMegaStore(CFG, { ...CREDS, password: 'nope-nope' }, { login: fake.login });
  await assert.rejects(() => wrong.get('a.bin'), (e) => e.code === 'SYNC_AUTH_FAILED'
    && !e.message.includes('nope-nope') && !e.message.includes(CREDS.email));
  fake.failNext('login', 'EMFAREQUIRED (-26): Multi-Factor Authentication Required');
  const mfa = createMegaStore(CFG, CREDS, { login: fake.login });
  await assert.rejects(() => mfa.get('a.bin'), (e) => e.code === 'SYNC_MFA_REQUIRED');
});

test('classifyMegaError maps quota, network, login and unknown errors', () => {
  assert.equal(classifyMegaError(new Error('EOVERQUOTA (-17): Request over quota')), 'SYNC_QUOTA');
  assert.equal(classifyMegaError(new Error('MEGA returned a 509 status code')), 'SYNC_QUOTA');
  assert.equal(classifyMegaError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'SYNC_UNREACHABLE');
  assert.equal(classifyMegaError(new Error('ETEMPUNAVAIL (-18): Resource temporarily not available, please try again later')), 'SYNC_RATE_LIMITED');
  assert.equal(classifyMegaError(new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?'), { duringLogin: true }), 'SYNC_AUTH_FAILED');
  assert.equal(classifyMegaError(new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?')), 'SYNC_IO');
  assert.equal(classifyMegaError(new Error('something else')), 'SYNC_IO');
});

test('validateMegaConfig names the bad field; maskEmail hides the local part', () => {
  assert.equal(validateMegaConfig({ ...CREDS, folder: 'llmide-sync' }), null);
  assert.equal(validateMegaConfig({ ...CREDS, email: 'not-an-email', folder: 'x' }), 'email');
  assert.equal(validateMegaConfig({ ...CREDS, password: '', folder: 'x' }), 'password');
  assert.equal(validateMegaConfig({ ...CREDS, folder: '../up' }), 'folder');
  assert.equal(validateMegaConfig({ ...CREDS, folder: '..' }), 'folder');
  assert.equal(maskEmail('llmide-sync@example.com'), 'l***@example.com');
});

test('watch signals files added to its folder, survives a re-login, and stops', async () => {
  const { fake, store } = make();
  let hits = 0;
  const stop = store.watch('w/in', () => { hits++; });
  await store.put('w/in/1.bin', Buffer.from('1'));
  await store.put('w/other.bin', Buffer.from('2'));
  assert.equal(hits, 1);
  fake.loseSessions();
  await store.put('w/in/2.bin', Buffer.from('3'));
  assert.equal(hits, 2);
  stop();
  await store.put('w/in/3.bin', Buffer.from('4'));
  assert.equal(hits, 2);
});

const IT = process.env.LLMIDE_SYNC_MEGA_IT === '1';
test('live MEGA account (opt-in, throwaway account only)', { skip: !IT }, async () => {
  const s = createMegaStore({ folder: 'llmide-sync-it' },
    { email: process.env.LLMIDE_SYNC_MEGA_IT_EMAIL, password: process.env.LLMIDE_SYNC_MEGA_IT_PASSWORD });
  const dir = `probe-${Date.now()}`;
  try {
    await s.put(`${dir}/x.bin`, Buffer.from('one'));
    await s.put(`${dir}/x.bin`, Buffer.from('two'));
    assert.equal(Buffer.from(await s.get(`${dir}/x.bin`)).toString(), 'two');
    assert.deepEqual((await s.list(dir)).map((e) => e.name), ['x.bin']);
    await s.remove(`${dir}/x.bin`);
    assert.equal(await s.get(`${dir}/x.bin`), null);
  } finally {
    await s.removeTree(dir);
    await s.close();
  }
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-store-mega.test.mjs`
Expected: FAIL with `Cannot find module '…/connectors/sync-store/mega.mjs'`.

- [ ] **Step 5: Write the implementation**

```js
// extension/connectors/sync-store/mega.mjs
// SyncStore over MEGA (design 8.3): the first adapter, by user decision 2026-11-05. It talks to a dedicated MEGA account
// used only for LLM-IDE and stores only sealed sync v1 envelopes; MEGA's own encryption sits underneath and is not relied
// on. One logged-in session is reused while the core runs (megajs keepalive keeps its file tree current). An expired
// session logs in again once. EAGAIN / ERATELIMIT / ETEMPUNAVAIL are retried twice (2 s, 8 s), then surface as
// SYNC_RATE_LIMITED for the scheduler's back-off. Operations run one at a time per store, so two callers never race to
// create the same folder. Deletes are permanent. The email and password never appear in a log line or an error.
import { Storage } from 'megajs';
import { checkPath, checkSize, MAX_FILE_BYTES } from './index.mjs';

export const DEFAULT_MEGA_FOLDER = 'llmide-sync';
const RETRY_DELAYS_MS = [2_000, 8_000];
const RATE_LIMITED = new Set([-3, -4, -6, -18, -19]); // EAGAIN, ERATELIMIT, ETOOMANY, ETEMPUNAVAIL, ETOOMANYCONNECTIONS
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const FOLDER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const NETWORK_RE = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR/;
const MESSAGES = {
  SYNC_AUTH_FAILED: 'MEGA refused the sync account login',
  SYNC_MFA_REQUIRED: 'The sync account has two-factor login on; use a dedicated MEGA account with it off',
  SYNC_RATE_LIMITED: 'MEGA asked LLM-IDE to slow down',
  SYNC_QUOTA: 'The MEGA account is over its storage or transfer quota',
  SYNC_UNREACHABLE: 'MEGA not reachable',
  SYNC_SESSION_EXPIRED: 'MEGA session expired',
  SYNC_TOO_LARGE: 'Sync file too large',
  SYNC_IO: 'MEGA operation failed',
};

const coded = (code) => Object.assign(new Error(MESSAGES[code] ?? MESSAGES.SYNC_IO), { code });

/** megajs reports API errors as plain Errors whose message reads "ENAME (-n): ..." (its ERRORS table). */
export function megaErrorNumber(e) {
  const m = /\((-\d+)\)/.exec(String(e?.message ?? ''));
  return m ? Number(m[1]) : null;
}

export function classifyMegaError(e, { duringLogin = false } = {}) {
  const n = megaErrorNumber(e);
  const text = `${e?.message ?? ''} ${e?.cause?.code ?? ''}`;
  if (n === -15) return 'SYNC_SESSION_EXPIRED';
  if (n === -26) return 'SYNC_MFA_REQUIRED';
  if (RATE_LIMITED.has(n) || /maybe caused by rate limit/.test(text)) return 'SYNC_RATE_LIMITED';
  if (n === -17 || n === -24 || /returned a 509 status/.test(text)) return 'SYNC_QUOTA';
  if (n === -16) return 'SYNC_AUTH_FAILED'; // EBLOCKED
  if (duringLogin && (n === -9 || /invalid credentials|Account version not supported/.test(text))) return 'SYNC_AUTH_FAILED';
  if (n === null && NETWORK_RE.test(text)) return 'SYNC_UNREACHABLE';
  return 'SYNC_IO';
}

const asCoded = (e, opts) => (String(e?.code ?? '').startsWith('SYNC_') ? e : coded(classifyMegaError(e, opts)));

export function validateMegaConfig(c) {
  if (!c || typeof c.email !== 'string' || !EMAIL_RE.test(c.email)) return 'email';
  if (typeof c.password !== 'string' || c.password.length < 1 || c.password.length > 1024) return 'password';
  if (typeof c.folder !== 'string' || !FOLDER_RE.test(c.folder) || c.folder === '.' || c.folder === '..') return 'folder';
  return null;
}

export function maskEmail(email) {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  return at > 0 ? `${s[0]}***${s.slice(at)}` : '***';
}

function realLogin({ email, password }, { onLost }) {
  // A fresh options object each time: megajs deletes options.password once it has derived the key. autoload reads the
  // whole tree, which is small because the dedicated account holds only sync files. 2FA is never sent (spec 8.3).
  const storage = new Storage({ email, password, keepalive: true, autoload: true, userAgent: 'LLM-IDE-sync' });
  // The keepalive poll reports a dead session as an 'error' event on storage.api. Without a listener Node would throw
  // and take the core down; with it, the next operation logs in again.
  storage.api.on('error', onLost);
  return storage.ready.catch((e) => { try { storage.api.close(); } catch { /* already closed */ } throw e; });
}

export function createMegaStore(config, secrets, { login = realLogin, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const folderName = config?.folder || DEFAULT_MEGA_FOLDER;
  const gone = new Set();     // nodeIds this store deleted; hidden until MEGA's delete packet reaches the tree
  const watchers = new Set(); // { dir, onChange }
  let session = null;         // Promise<Storage> for the one live login
  let chain = Promise.resolve();

  const byAge = (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0); // stable sort: same second keeps upload order
  const live = (node) => (node?.children ?? []).filter((c) => !gone.has(c.nodeId));
  const filesNamed = (node, name) => live(node).filter((c) => !c.directory && c.name === name).sort(byAge); // last = newest
  const folderNamed = (node, name) => live(node).find((c) => c.directory && c.name === name) ?? null;

  /** 'a/b' for a folder below the sync folder; null outside it. */
  function pathBelowSyncFolder(node, cloudRoot) {
    const names = [];
    for (let n = node; n; n = n.parent) {
      if (n.parent === cloudRoot && n.name === folderName) return names.reverse().join('/');
      names.push(n.name);
    }
    return null;
  }
  function notify(st, file) {
    if (!watchers.size || !file) return;
    const dir = pathBelowSyncFolder(file.parent, st.root);
    for (const w of watchers) {
      if (w.dir === dir) { try { w.onChange(); } catch { /* a watcher's bug never breaks sync */ } }
    }
  }
  function attach(st) {
    st.on('add', (f) => notify(st, f));
    st.on('update', (f) => notify(st, f));
    st.on('delete', (f) => { gone.delete(f?.nodeId); notify(st, f); });
  }

  function storage() {
    if (!session) {
      const p = login({ email: secrets.email, password: secrets.password }, { onLost: () => { if (session === p) session = null; } })
        .then((st) => { attach(st); return st; })
        .catch((e) => { if (session === p) session = null; throw asCoded(e, { duringLogin: true }); });
      session = p;
    }
    return session;
  }
  function drop() {
    const old = session;
    session = null;
    old?.then((st) => st.close(), () => {}).catch(() => {});
  }
  async function attempt(fn) {
    let relogged = false;
    let retry = 0;
    for (;;) {
      try { return await fn(await storage()); } catch (e) {
        const err = asCoded(e);
        if (err.code === 'SYNC_SESSION_EXPIRED' && !relogged) { relogged = true; drop(); continue; }
        if (err.code === 'SYNC_RATE_LIMITED' && retry < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[retry++]); continue; }
        throw err.code === 'SYNC_SESSION_EXPIRED' ? coded('SYNC_AUTH_FAILED') : err;
      }
    }
  }
  const serial = (fn) => { const run = chain.then(() => attempt(fn)); chain = run.catch(() => {}); return run; };

  async function walk(st, segs, create) {
    let node = folderNamed(st.root, folderName) ?? await st.root.mkdir(folderName); // the sync folder: created on first use
    for (const name of segs) {
      const next = folderNamed(node, name);
      if (next) node = next;
      else if (create) node = await node.mkdir(name);
      else return null;
    }
    return node;
  }

  return {
    async put(path, bytes) {
      const segs = checkPath(path); checkSize(bytes);
      const data = Buffer.from(bytes);
      await serial(async (st) => {
        const dir = await walk(st, segs.slice(0, -1), true);
        const name = segs.at(-1);
        const older = filesNamed(dir, name);
        await dir.upload({ name, size: data.length }, data).complete; // readers see the old copy or the new one, never a mix
        for (const f of older) { await f.delete(true); gone.add(f.nodeId); }
      });
    },
    async get(path) {
      const segs = checkPath(path);
      return serial(async (st) => {
        const dir = await walk(st, segs.slice(0, -1), false);
        const f = dir && filesNamed(dir, segs.at(-1)).at(-1);
        if (!f) return null;
        if ((f.size ?? 0) > MAX_FILE_BYTES) throw coded('SYNC_TOO_LARGE');
        return f.downloadBuffer({});
      });
    },
    async list(dir) {
      const segs = checkPath(dir);
      return serial(async (st) => {
        const node = await walk(st, segs, false);
        if (!node) return [];
        const newest = new Map();
        for (const c of live(node).filter((x) => !x.directory).sort(byAge)) newest.set(c.name, c);
        return [...newest.values()].map((c) => ({ name: c.name, size: c.size ?? 0, mtimeMs: (c.timestamp ?? 0) * 1000 }));
      });
    },
    async remove(path) {
      const segs = checkPath(path);
      await serial(async (st) => {
        const dir = await walk(st, segs.slice(0, -1), false);
        for (const f of dir ? filesNamed(dir, segs.at(-1)) : []) { await f.delete(true); gone.add(f.nodeId); }
      });
    },
    async removeTree(dir) {
      const segs = checkPath(dir);
      await serial(async (st) => {
        const node = await walk(st, segs, false);
        if (node) { await node.delete(true); gone.add(node.nodeId); }
      });
    },
    watch(dir, onChange) {
      const w = { dir: checkPath(dir).join('/'), onChange };
      watchers.add(w);
      void serial(async () => {}).catch(() => {}); // make sure a session, and so the change feed, exists
      return () => { watchers.delete(w); };
    },
    describe() { return { kind: 'mega', root: folderName, account: maskEmail(secrets.email) }; },
    async close() {
      watchers.clear();
      const old = session;
      session = null;
      if (old) await old.then((st) => st.close(), () => {}).catch(() => {});
    },
  };
}
```

`watch` is the optional `SyncStore.watch` from spec §2.1. The scheduler in Task 8 still polls, so watch is not on the
critical path, but SP3 and SP4 can use the same change feed to drain the inbox sooner.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-store-mega.test.mjs tests/sync-store-memory.test.mjs`
Expected: PASS. The MEGA file has 4 contract tests and 9 unit tests, and the live test is SKIPPED. The memory file is unchanged at 5.

- [ ] **Step 7: Commit**

```bash
git add extension/connectors/sync-store/mega.mjs extension/tests/helpers/fake-mega.mjs extension/tests/sync-store-mega.test.mjs extension/package.json extension/package-lock.json
git commit -m "feat(sync): MEGA SyncStore adapter for a dedicated account" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
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
  the dispatch block (right after the Host API block near line 806), the post-listen block (near line 1507) and `shutdown()`
  (near line 1195)
- Modify: `extension/CLAUDE.md` (a new section after "Host API v1 (desktop)")
- Regenerate: `schema/http/INVENTORY.md`, generated API types, openapi
- Test: `extension/tests/sync-routes.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 4, 6, 7; `verifyBusHostProof` (`core/host-approval.mjs`); `send`, `readJson` (`server/route-http.mjs`); `getSecret`/`setSecret`.
- Produces:
  - `storeFor(userId): SyncStore | null` (scheduler.mjs). It caches one MEGA store per user, so one logged-in session is reused while the core runs.
  - `dropStore(userId): Promise<void>` (logs that user's session out; called when the setup changes or sync is turned off)
  - `closeSyncStores(): Promise<void>` (logs every session out; called on shutdown)
  - `recordCycleFailure(userId, err, { now, backoff }): number` (records the code, returns the back-off in ms; turns sync off on `SYNC_AUTH_FAILED` or `SYNC_MFA_REQUIRED`)
  - `startSyncScheduler({ logger, env = process.env }): { stop(): Promise<void> }` (does nothing when `LLMIDE_SYNC=off`)
  - `syncCycle(userId, { now }): Promise<{ publish, drain }>`
  - `isSyncRoute(url): boolean`, `handleSyncRoute(req, res, opts): Promise<true>`
  - HTTP (JWT + bus host proof, 403 `HOST_PROOF_REQUIRED` first):
    - `GET /kb/sync/status` → `{ configured, enabled, storeKind, store, syncId, epoch, signingFingerprint, devices: [{ deviceId, name, tier, addedAt }], lastPublishAt, lastError }`, where `store` is `{ folder, account }` for MEGA and `account` is the masked email
    - `POST /kb/sync/mega { email, password, folder? }` → status (stores the login in the vault; 400 `VALIDATION_FAILED` with `details.field`)
    - `POST /kb/sync/test` → `{ ok: true }` | 502 `{ error: { code: SYNC_AUTH_FAILED|SYNC_MFA_REQUIRED|SYNC_RATE_LIMITED|SYNC_QUOTA|SYNC_UNREACHABLE|SYNC_IO } }` | 409 `SYNC_NOT_SET_UP`
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
const st = await import('../kb/sync-state.mjs');
const { handleSyncRoute, isSyncRoute } = await import('../routes/sync/http-routes.mjs');
const { recordCycleFailure } = await import('../routes/sync/scheduler.mjs');
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
const MEGA = { email: 'llmide-sync@example.com', password: 'a long dedicated password', folder: 'llmide-sync' };

test('routes need the bus host proof, then a user', async () => {
  assert.ok(isSyncRoute('/kb/sync/status'));
  assert.ok(!isSyncRoute('/kb/synchronize'));
  assert.equal((await call('GET', '/kb/sync/status', { userId: user(), proof: false })).status, 403);
  assert.equal((await call('GET', '/kb/sync/status', {})).status, 401);
});

test('MEGA setup validates, keeps the login only in the vault, and never returns it', async () => {
  const u = user();
  const bad = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, email: 'not-an-email' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.field, 'email');
  const badFolder = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, folder: '../up' } });
  assert.equal(badFolder.body.error.details.field, 'folder');
  const a = await call('POST', '/kb/sync/mega', { userId: u, body: { email: MEGA.email, password: MEGA.password } });
  assert.equal(a.status, 200);
  assert.equal(a.body.storeKind, 'mega');
  assert.deepEqual(a.body.store, { folder: 'llmide-sync', account: 'l***@example.com' }, 'the default folder name applies');
  assert.equal(a.body.enabled, false);
  const raw = JSON.stringify(a.body);
  assert.ok(!raw.includes(MEGA.password)); assert.ok(!raw.includes(MEGA.email));
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.megaPassword'), MEGA.password);
  assert.deepEqual(st.getSyncState(u).storeConfig, { folder: 'llmide-sync' }, 'the database holds the folder name only');
});

test('enable needs a configured store; status reflects it', async () => {
  const u = user();
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } })).status, 409);
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  const on = await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } });
  assert.equal(on.body.enabled, true);
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: 'yes' } })).status, 400);
});

test('test and publish surface coded store errors', async () => {
  const u = user();
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  const failing = { storeFor: () => ({ put: async () => { throw Object.assign(new Error('x'), { code: 'SYNC_MFA_REQUIRED' }); }, get: async () => null, remove: async () => {} }) };
  const r = await call('POST', '/kb/sync/test', { userId: u, deps: failing });
  assert.equal(r.status, 502); assert.equal(r.body.error.code, 'SYNC_MFA_REQUIRED');
});

test('a refused login turns sync off instead of retrying (no account lockout); rate limits back off', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
  st.setSyncEnabled(u, true);
  const backoff = new Map();
  const ms = recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_RATE_LIMITED' }), { now: 1000, backoff });
  assert.equal(ms, 60_000);
  assert.equal(st.getSyncState(u).enabled, true);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_RATE_LIMITED');
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_AUTH_FAILED' }), { now: 2000, backoff });
  assert.equal(st.getSyncState(u).enabled, false);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_AUTH_FAILED');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-routes.test.mjs`
Expected: FAIL with `Cannot find module '…/routes/sync/http-routes.mjs'`.

- [ ] **Step 3: Write `extension/routes/sync/scheduler.mjs`**

```js
// extension/routes/sync/scheduler.mjs
// Timers for every user with sync on: producer every 60 s +/- 15 s, consumer every 30 s; one cycle per user at a time;
// failures back off exponentially up to 15 min and are recorded as a code only. A refused login (SYNC_AUTH_FAILED,
// SYNC_MFA_REQUIRED) turns sync off instead of retrying, so a changed password never locks the MEGA account. One MEGA
// store (one logged-in session) per user is cached while the core runs. LLMIDE_SYNC=off starts nothing.
import { getDb } from '../../kb/db.mjs';
import { getSecret } from '../../server/vault.mjs';
import { getSyncState, listEnabledSyncUsers, recordPublish, setSyncEnabled } from '../../kb/sync-state.mjs';
import { createMegaStore } from '../../connectors/sync-store/mega.mjs';
import { publishOnce } from './producer.mjs';
import { drainOnce } from './consumer.mjs';

const PRODUCE_MS = 60_000;
const DRAIN_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const SETUP_ERRORS = new Set(['SYNC_AUTH_FAILED', 'SYNC_MFA_REQUIRED']);
const stores = new Map(); // userId -> SyncStore

export function storeFor(userId) {
  const cached = stores.get(userId);
  if (cached) return cached;
  const state = getSyncState(userId);
  if (state?.storeKind !== 'mega') return null;
  const db = getDb();
  const email = getSecret(db, userId, 'sync.megaEmail');
  const password = getSecret(db, userId, 'sync.megaPassword');
  if (!email || !password) return null;
  const store = createMegaStore(state.storeConfig, { email, password });
  stores.set(userId, store);
  return store;
}

export async function dropStore(userId) {
  const s = stores.get(userId);
  stores.delete(userId);
  await s?.close?.();
}

export async function closeSyncStores() {
  const all = [...stores.values()];
  stores.clear();
  await Promise.allSettled(all.map((s) => s.close?.()));
}

export async function syncCycle(userId, { now = Date.now(), produce = true, store = storeFor(userId) } = {}) {
  if (!store) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  const publish = produce ? await publishOnce({ userId, store, now }) : null;
  const drain = await drainOnce({ userId, store, now });
  return { publish, drain };
}

export function recordCycleFailure(userId, e, { now, backoff }) {
  const code = String(e?.code || 'SYNC_FAILED');
  recordPublish(userId, { at: now, error: code });
  if (SETUP_ERRORS.has(code)) {
    setSyncEnabled(userId, false);
    backoff.delete(userId);
    void dropStore(userId);
    return 0;
  }
  const ms = Math.min(MAX_BACKOFF_MS, (backoff.get(userId)?.ms ?? 30_000) * 2);
  backoff.set(userId, { until: now + ms, ms });
  return ms;
}

export function startSyncScheduler({ logger, env = process.env } = {}) {
  if (env.LLMIDE_SYNC === 'off') return { async stop() {} };
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
        const ms = recordCycleFailure(userId, e, { now, backoff });
        logger?.warn?.('sync_cycle_failed', { code: String(e?.code || 'SYNC_FAILED'), backoffMs: ms });
      } finally { busy.delete(userId); }
    }
  };
  const timer = setInterval(() => { void tick(); }, DRAIN_MS);
  timer.unref?.();
  return { async stop() { clearInterval(timer); await closeSyncStores(); } };
}
```

- [ ] **Step 4: Write `extension/routes/sync/http-routes.mjs`**

```js
// extension/routes/sync/http-routes.mjs
// /kb/sync/* for the desktop Settings card: JWT + bus host proof (desktop UI only), per user. Never returns the MEGA
// password, the full MEGA email, a private key, the root key or a folder capability; errors carry codes, never secrets.
import { send, readJson } from '../../server/route-http.mjs';
import { verifyBusHostProof } from '../../core/host-approval.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { getSyncState, ensureSyncState, setSyncEnabled, listSyncDevices } from '../../kb/sync-state.mjs';
import { DEFAULT_MEGA_FOLDER, maskEmail, validateMegaConfig } from '../../connectors/sync-store/mega.mjs';
import { ensureSyncKeys } from './keys.mjs';
import { storeFor as defaultStoreFor, dropStore, syncCycle } from './scheduler.mjs';

const fail = (res, status, code, message, details) => { send(res, status, { error: { code, message, ...(details ? { details } : {}) } }); return true; };

export function isSyncRoute(url) {
  const p = String(url || '').split('?')[0];
  return p === '/kb/sync' || p.startsWith('/kb/sync/');
}

function status(userId) {
  const s = getSyncState(userId);
  if (!s) return { configured: false, enabled: false, storeKind: null, store: null, syncId: null, epoch: null, signingFingerprint: null, devices: [], lastPublishAt: null, lastError: null };
  return {
    configured: true, enabled: s.enabled, storeKind: s.storeKind,
    store: s.storeKind === 'mega' ? { folder: s.storeConfig.folder ?? DEFAULT_MEGA_FOLDER, account: maskEmail(getSecret(getDb(), userId, 'sync.megaEmail')) } : null,
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
    if (req.method === 'POST' && path === '/kb/sync/mega') {
      const b = await readJson(req, 4096);
      const cfg = { email: String(b.email ?? '').trim(), password: typeof b.password === 'string' ? b.password : '', folder: String(b.folder ?? DEFAULT_MEGA_FOLDER).trim() || DEFAULT_MEGA_FOLDER };
      const field = validateMegaConfig(cfg);
      if (field) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${field}`, { field });
      const db = getDb();
      setSecret(db, userId, 'sync.megaEmail', cfg.email);
      setSecret(db, userId, 'sync.megaPassword', cfg.password);
      ensureSyncState(userId, { storeKind: 'mega', storeConfig: { folder: cfg.folder } });
      await dropStore(userId); // the next use logs in with the new login
      send(res, 200, status(userId)); return true;
    }
    if (req.method === 'POST' && path === '/kb/sync/enabled') {
      const b = await readJson(req, 1024);
      if (typeof b.enabled !== 'boolean') return fail(res, 400, 'VALIDATION_FAILED', 'enabled must be a boolean', { field: 'enabled' });
      if (!getSyncState(userId)) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      setSyncEnabled(userId, b.enabled);
      if (!b.enabled) await dropStore(userId); // log the MEGA session out while sync is off
      send(res, 200, status(userId)); return true;
    }
    if (req.method === 'POST' && (path === '/kb/sync/test' || path === '/kb/sync/publish')) {
      const state = getSyncState(userId);
      const store = state && storeFor(userId);
      if (!store) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      try {
        if (path === '/kb/sync/test') {
          // Logs in, creates the sync folder on first use, then a write/read/delete round trip.
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
      }
    }
    return fail(res, 404, 'NOT_FOUND', 'No such sync route');
  } catch (e) {
    return fail(res, e?.status === 413 ? 413 : 400, 'VALIDATION_FAILED', 'Bad request');
  }
}
```

The store is not closed after a route call: the cached session belongs to the scheduler and stays logged in while the
core runs. The `/kb/sync/test` probe file is the only plaintext the store ever sees: the two bytes `ok` under a random
`syncId`, deleted at once.

- [ ] **Step 5: Wire `extension/server.mjs`**

Add the import after the Host API import (line 22):

```js
import { handleSyncRoute, isSyncRoute } from './routes/sync/http-routes.mjs';
```

Bump the version and record the wire change (line 324, with a comment line above it like the others):

```js
//   v112 — encrypted sync, additive (design docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md, migration 0064, contract schema/http/sync.schema.json): GET /kb/sync/status, POST /kb/sync/mega { email, password, folder? }, POST /kb/sync/test, POST /kb/sync/enabled { enabled }, POST /kb/sync/publish. JWT + bus host proof (403 HOST_PROOF_REQUIRED first). Never returns the MEGA password or full email, a private key, root key or folder capability. Status, mega and enabled ride 'kbWrite'; test and publish ride 'dispatch'.
const SERVER_API_VERSION = 112;
```

Add to `ALL_ENDPOINTS` after `'/host-api/devices/:id',`:

```js
  '/kb/sync/status',
  '/kb/sync/mega',
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

Declare the scheduler handle next to `let shuttingDown = false;` (near line 1194):

```js
let syncScheduler = null; // routes/sync/scheduler.mjs, started after listen; its stop() logs the MEGA sessions out
```

Start the scheduler next to the engine prewarm (line 1507), never in tests:

```js
    if (process.env.NODE_ENV !== 'test') {
      void import('./routes/sync/scheduler.mjs').then((m) => { syncScheduler = m.startSyncScheduler({ logger }); }).catch((e) => logger.warn('sync_scheduler_failed', { message: e.message }));
    }
```

In `shutdown()`, after `stopBackgroundOutcomePoller();`:

```js
  // Encrypted sync: stop the timers and log each MEGA session out (best-effort, at most 2 s of the shutdown budget).
  const syncStopped = syncScheduler ? syncScheduler.stop().catch(() => {}) : Promise.resolve();
```

and inside the `server.close(async () => {` callback, right after `await busStopped;`:

```js
    await Promise.race([syncStopped, new Promise((r) => setTimeout(r, 2000))]);
```

- [ ] **Step 6: Contract file and generated artefacts**

```json
{
  "description": "Encrypted sync settings (docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md): the desktop Settings card's routes. Served by extension/routes/sync/http-routes.mjs, dispatched from extension/server.mjs after authenticate and the rate limiter. Every route needs the JWT AND the bus host proof header x-llmide-host-nonce, checked first: without it 403 HOST_PROOF_REQUIRED. Per user. No route returns the MEGA password or full email, a private key, root key or device folder name. Errors: 400 VALIDATION_FAILED (details.field), 409 SYNC_NOT_SET_UP, 502 SYNC_AUTH_FAILED|SYNC_MFA_REQUIRED|SYNC_RATE_LIMITED|SYNC_QUOTA|SYNC_UNREACHABLE|SYNC_IO.",
  "$defs": {
    "Status": {
      "type": "object",
      "properties": {
        "configured": { "type": "boolean" },
        "enabled": { "type": "boolean" },
        "storeKind": { "type": ["string", "null"], "description": "mega | memory (sftp | box in later sub-projects)" },
        "store": { "type": ["object", "null"], "description": "mega: { folder, account }, account = masked email" },
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
    "POST /kb/sync/mega": { "request": { "type": "object", "required": ["email", "password"], "properties": { "email": { "type": "string" }, "password": { "type": "string" }, "folder": { "type": "string" } } }, "responses": { "200": { "$ref": "#/$defs/Status" } } },
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

- [ ] **Step 7: Add the `extension/CLAUDE.md` section** (after "Host API v1 (desktop)")

```markdown
## Sync (desktop producer)

- **What**: encrypted snapshots (chats, meetings, plans, usage) and a queued-prompt inbox in a user-owned folder, for the phone and web with the desktop off. Design `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md`, ADR 0020.
- **Where**: envelope `core/sync-envelope.mjs` (relay v1 bytes + `snapshot`/`manifest`/`syncwrap`; vectors `schema/sync/v1`, check `node scripts/sync-vectors.mjs`); stores `connectors/sync-store/` (memory for tests; MEGA via `megajs` 1.3.10, the first adapter by user decision; SFTP and Box are later sub-projects); state `kb/sync-state.mjs` (migration 0064); vault keys `sync.rootKey`, `sync.signingKey`, `sync.megaEmail`, `sync.megaPassword` (all internal); producer/consumer/scheduler/routes `routes/sync/`.
- **MEGA**: a dedicated account only; 2FA off on that account (`SYNC_MFA_REQUIRED` otherwise); one session per user cached in `routes/sync/scheduler.mjs` while the core runs, logged out on shutdown, setup change or sync off; a refused login turns sync off instead of retrying. Tests use `tests/helpers/fake-mega.mjs`; the live run is opt-in (`LLMIDE_SYNC_MEGA_IT=1`).
- **Ceiling**: queued requests are `chat.send` only and run only through `startHostTurn` (`auto_read_only`, phone chat); an approval request cancels the turn and replies `needs_approval`; record-before-execute in `sync_requests`.
- **Off switch**: `LLMIDE_SYNC=off` starts no scheduler; per user, Settings "Sync on" (`sync_state.enabled`).
- **Never** log keys, folder names, `es`, the MEGA email or password, or decrypted content.
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd extension && node --test tests/sync-routes.test.mjs tests/server-features-health.test.mjs tests/lazy-engine.test.mjs`
Expected: PASS. The lazy-engine test proves the scheduler import is not on the boot path; `consumer.mjs` imports
`agent-v2.mjs` only inside its deps. `http-routes.mjs` imports `connectors/sync-store/mega.mjs`, which imports `megajs`
at module load. That is on the request path for `/kb/sync/*` only if `server.mjs` imports `http-routes.mjs` statically,
which Step 5 does. If `lazy-engine.test.mjs` or a boot-time budget test flags `megajs`, change the Step 5 import to a lazy
`await import('./routes/sync/http-routes.mjs')` inside the dispatch block, and keep `isSyncRoute` as the inline check
`p === '/kb/sync' || p.startsWith('/kb/sync/')`.

- [ ] **Step 9: Commit**

```bash
git add extension/routes/sync/scheduler.mjs extension/routes/sync/http-routes.mjs extension/tests/sync-routes.test.mjs extension/server.mjs extension/CLAUDE.md schema/http
git commit -m "feat(server): sync settings routes and background scheduler (API v112)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Settings card (MEGA setup) and full verification

**Files:**
- Create: `ui/screens/settings/sync-model.ts`, `ui/screens/settings/sections/SyncSection.tsx`
- Modify: `ui/screens/settings/sections/MobileBridge.tsx` (render `<SyncSection />` after `<HostApiPairing />`)
- Test: `ui/screens/settings/tests/sync-section.test.mjs`

**Interfaces:**
- Consumes: `call`, `ApiError`, `CoreClient` (`../core-api.ts`); `useEnv` (`../context.tsx`); `Button`, `ErrorText` (`../ui.tsx`); the Task 8 routes.
- Produces: `decodeSyncStatus(v: unknown): SyncStatus`, `loadSyncStatus(client)`, `saveMega(client, cfg)`, `testSync(client)`, `setSyncEnabled(client, enabled)`, `publishNow(client)`, `syncErrorText(code: string): string | null`, `describeSyncError(e: unknown): string | null`, and the default export `SyncSection`.

- [ ] **Step 1: Write the failing test**

```js
// ui/screens/settings/tests/sync-section.test.mjs
// Sync card model: strict decoding of /kb/sync/status, the calls the card makes, and the MEGA error texts. The card
// hides on HOST_PROOF_REQUIRED.
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
const STATUS = { configured: true, enabled: false, storeKind: "mega", store: { folder: "llmide-sync", account: "l***@example.com" },
  syncId: "B".repeat(22), epoch: 1, signingFingerprint: "C".repeat(43), devices: [], lastPublishAt: null, lastError: null };

test("decodeSyncStatus accepts the route shape, rejects junk, and never keeps a password", () => {
  assert.equal(m.decodeSyncStatus(STATUS).store.folder, "llmide-sync");
  assert.throws(() => m.decodeSyncStatus({ ...STATUS, enabled: "no" }));
  const leaked = m.decodeSyncStatus({ ...STATUS, store: { ...STATUS.store, password: "secret" } });
  assert.deepEqual(leaked.store, { folder: "llmide-sync", account: "l***@example.com" });
});

test("calls go to the sync routes with the typed body", async () => {
  const c = fake({ "POST /kb/sync/mega": { status: 200, body: STATUS }, "POST /kb/sync/enabled": { status: 200, body: { ...STATUS, enabled: true } }, "GET /kb/sync/status": { status: 403, body: { error: { code: "HOST_PROOF_REQUIRED", message: "x" } } } });
  await m.saveMega(c, { email: "llmide-sync@example.com", password: "pw", folder: "llmide-sync" });
  assert.equal((await m.setSyncEnabled(c, true)).enabled, true);
  assert.equal(await m.loadSyncStatus(c), null, "hidden without the host proof");
  assert.ok(c.calls[0].startsWith("POST /kb/sync/mega"));
});

test("MEGA error codes read as guidance", () => {
  assert.match(m.syncErrorText("SYNC_MFA_REQUIRED"), /two-factor/);
  assert.match(m.syncErrorText("SYNC_AUTH_FAILED"), /email or password/);
  assert.equal(m.syncErrorText("SOMETHING_ELSE"), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs`
Expected: FAIL (esbuild cannot resolve `sync-model.ts`).

- [ ] **Step 3: Write `ui/screens/settings/sync-model.ts`**

```ts
// Settings → Phone and web sync: the model for the /kb/sync/* routes (schema/http/sync.schema.json). Strict decoding;
// the card hides when the core does not serve these routes to this UI (no bus host proof). The MEGA password is sent
// once, on Save, and is never read back: no route returns it, and the decoder keeps only folder + masked account.
import { ApiError, call, type CoreClient } from "./core-api.ts";

export interface MegaSetup { email: string; password: string; folder: string }
export interface MegaStore { folder: string; account: string }
export interface SyncDevice { deviceId: string; name: string; tier: "web" | "ios"; addedAt: number }
export interface SyncStatus {
  configured: boolean; enabled: boolean; storeKind: string | null; store: MegaStore | null;
  syncId: string | null; epoch: number | null; signingFingerprint: string | null; devices: SyncDevice[];
  lastPublishAt: number | null; lastError: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const intOrNull = (v: unknown) => v === null || Number.isInteger(v);

export function decodeSyncStatus(v: unknown): SyncStatus {
  if (!isRecord(v) || typeof v.configured !== "boolean" || typeof v.enabled !== "boolean" || !strOrNull(v.storeKind)
    || !strOrNull(v.syncId) || !intOrNull(v.epoch) || !strOrNull(v.signingFingerprint) || !Array.isArray(v.devices)
    || !intOrNull(v.lastPublishAt) || !strOrNull(v.lastError)) throw new ApiError(0, "BAD_RESPONSE");
  const s = v.store;
  const store = isRecord(s) && typeof s.folder === "string" && typeof s.account === "string" ? { folder: s.folder, account: s.account } : null;
  const devices = (v.devices as unknown[]).filter((d): d is SyncDevice => isRecord(d) && typeof d.deviceId === "string" && typeof d.name === "string"
    && (d.tier === "web" || d.tier === "ios") && typeof d.addedAt === "number");
  return { configured: v.configured, enabled: v.enabled, storeKind: v.storeKind as string | null, store,
    syncId: v.syncId as string | null, epoch: v.epoch as number | null, signingFingerprint: v.signingFingerprint as string | null, devices,
    lastPublishAt: v.lastPublishAt as number | null, lastError: v.lastError as string | null };
}

const SYNC_ERROR_TEXT: Record<string, string> = {
  SYNC_AUTH_FAILED: "MEGA refused the email or password. Check them, then Save again. Sync was turned off so MEGA does not lock the account.",
  SYNC_MFA_REQUIRED: "This MEGA account has two-factor login on. The desktop logs in by itself, so use a separate MEGA account with two-factor off (keep it on for your personal account).",
  SYNC_RATE_LIMITED: "MEGA asked LLM-IDE to slow down. Sync retries by itself in a few minutes.",
  SYNC_QUOTA: "The MEGA account is over its storage or transfer quota.",
  SYNC_UNREACHABLE: "MEGA could not be reached. Check the network; sync retries by itself.",
  SYNC_IO: "A MEGA operation failed. Sync retries by itself.",
};
export const syncErrorText = (code: string): string | null => SYNC_ERROR_TEXT[code] ?? null;
export const describeSyncError = (e: unknown): string | null => (e instanceof ApiError ? syncErrorText(e.code) : null);

export async function loadSyncStatus(client: CoreClient): Promise<SyncStatus | null> {
  try { return decodeSyncStatus(await call(client, "GET", "/kb/sync/status")); }
  catch (e) { if (e instanceof ApiError && e.code === "HOST_PROOF_REQUIRED") return null; throw e; }
}
export const saveMega = async (client: CoreClient, cfg: MegaSetup) => decodeSyncStatus(await call(client, "POST", "/kb/sync/mega", cfg));
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
// Settings → Phone and web sync (desktop off): MEGA store setup (a dedicated account), connection test, on/off and
// "Publish now". The password field is write-only: it is cleared after Save and never filled from the core.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { loadSyncStatus, saveMega, testSync, setSyncEnabled, publishNow, syncErrorText, describeSyncError, type SyncStatus } from "../sync-model.ts";

export default function SyncSection(): ReactNode {
  const { client } = useEnv();
  const [status, setStatus] = useState<SyncStatus | null | undefined>(undefined);
  const [form, setForm] = useState({ email: "", password: "", folder: "llmide-sync" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null); setNote(null);
    try { await fn(); if (ok) setNote(ok); } catch (e) { setError(describeSyncError(e) ?? describeError(e)); }
    try { setStatus(await loadSyncStatus(client)); } catch { /* keep the last status */ }
  }, [client]);
  useEffect(() => { void loadSyncStatus(client).then((s) => {
    setStatus(s);
    if (s?.store) setForm((f) => ({ ...f, folder: s.store!.folder }));
  }, (e) => setError(describeError(e))); }, [client]);
  if (status === null) return null;
  const save = () => run(async () => {
    await saveMega(client, { email: form.email.trim(), password: form.password, folder: form.folder.trim() || "llmide-sync" });
    setForm((f) => ({ ...f, password: "" }));
    await testSync(client); // logs in and creates the folder on first use
  }, "Saved. MEGA connection works.");
  return (
    <section className="st-card" aria-labelledby="sync-title">
      <h3 id="sync-title">Phone and web sync</h3>
      <p>With the desktop off, the phone and web app read an encrypted copy of your chats, meetings, plans and usage from a MEGA folder, and queue chat prompts that run when the desktop is back. MEGA only ever stores ciphertext.</p>
      <div className="st-stack" role="note">
        <p><strong>Use a separate MEGA account made only for LLM-IDE</strong>, never your personal one. It will hold nothing but encrypted sync files, so a leak of its password exposes nothing readable.</p>
        <p>Turn off two-factor login on that account: the desktop logs in by itself in the background. Keep two-factor on for your personal account.</p>
        <p>The email and password are kept in this computer's encrypted vault and are never shown again.</p>
      </div>
      <label className="st-field">MEGA email
        <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="MEGA email" autoComplete="off" spellCheck={false} />
      </label>
      <label className="st-field">MEGA password
        <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-label="MEGA password" autoComplete="new-password" />
      </label>
      <label className="st-field">Folder name
        <input value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} aria-label="Folder name" spellCheck={false} />
      </label>
      <Button onClick={save} disabled={!form.email.trim() || !form.password}>Save and test</Button>
      {status?.store && (
        <div className="st-stack">
          <p>Connected account <code>{status.store.account}</code>, folder <code>{status.store.folder}</code> in its Cloud Drive.</p>
          <p>Desktop signing key fingerprint: <code>{status.signingFingerprint}</code></p>
          <Button onClick={() => run(() => testSync(client), "MEGA connection works.")}>Test connection</Button>
          <label className="st-toggle"><input type="checkbox" checked={status.enabled} onChange={(e) => run(() => setSyncEnabled(client, e.target.checked))} /> Sync on</label>
          <Button onClick={() => run(() => publishNow(client), "Published.")} disabled={!status.enabled}>Publish now</Button>
          <p aria-live="polite">{status.lastError ? `Last error: ${syncErrorText(status.lastError) ?? status.lastError}` : status.lastPublishAt ? `Last published ${new Date(status.lastPublishAt).toLocaleString()}` : "Not published yet."} · {status.devices.length} device(s)</p>
        </div>
      )}
      {note && <p aria-live="polite">{note}</p>}
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
```

Before writing this step, check that `useEnv()` exposes `client` and that `describeError` exists in `../errors.ts`; both
are used by `HostApiPairing.tsx`. If the class names `st-card`, `st-field`, `st-toggle` or `st-stack` do not exist in
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
git commit -m "feat(ui): phone and web sync card in Settings (MEGA)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Full verification**

Run: `cd extension && npm test`, then `make contract-gates`, then `cd desktop && npm test`.
Expected: all green, and no network access is needed: every MEGA test uses `tests/helpers/fake-mega.mjs`.

The opt-in live check is run by hand, by the user, against a **throwaway** MEGA account with two-factor off. It is never
run in CI and never against a personal account:

```bash
cd extension && LLMIDE_SYNC_MEGA_IT=1 LLMIDE_SYNC_MEGA_IT_EMAIL='…' LLMIDE_SYNC_MEGA_IT_PASSWORD='…' node --test tests/sync-store-mega.test.mjs
```

Expected: the live test passes and leaves only an empty `llmide-sync-it` folder in that account's Cloud Drive. Then, in
the desktop app (Settings → Mobile Control → Phone and web sync), Save and test with the same account, turn Sync on,
press Publish now, and check in the MEGA web app that the `llmide-sync` folder exists and that everything under it is a
`.bin` file of random bytes. With no device paired yet (enrollment is SP2), a publish writes no device folders, so an empty
folder is the expected result. Nothing is committed in this step.

---

## Self-review

**Spec coverage (SP1 rows of spec §14):**

| Spec requirement | Task |
|---|---|
| `SyncStore` interface, path rules, contract suite (§2.1) | 3 |
| MEGA adapter: dedicated account, vault-only login, no 2FA, session reuse, re-login on expiry, rate-limit retry, folder on first use, permanent deletes, optional watch (§8.3) | 4, 8 |
| Contract suite on memory and on a fake MEGA client; opt-in live run with a throwaway account (§13) | 3, 4, 9 |
| sync v1 envelope = relay v1 + purposes, shared vectors (§4.1, §13) | 1 |
| Keys held by the desktop in the vault (§5.1) | 2, 6 |
| Folder layout, per-device copies, one writer per file (§3, §7) | 6, 7 |
| Snapshot kinds, redaction, size cap, truncation (§4.2) | 5 |
| Manifest with `manifestSeq`, `validUntil`, hash binding; heartbeat (§4.3) | 6 |
| Hybrid counter (§4.5) | 2 |
| Inbox at the read-only ceiling: closed schema, signature, age, record-before-execute, quota, approval → `needs_approval`, outbox 7 days (§4.4, §6) | 7 |
| Failure behaviour: back-off, coded errors, orphan clean-up, refused login turns sync off (§12) | 4, 6, 8 |
| Settings controls (MEGA email, password, folder, separate-account guidance, test, on/off, publish now, status) | 8, 9 |
| Blindness test (§13) | 6 |

Not covered here, by design, because they belong to later sub-projects:

- enrollment, slot, SAS, revoke and rotate (SP2);
- the PWA and iOS readers, including their MEGA clients (SP3, SP4);
- the own-server SFTP adapter with its nginx and sshd setup (SP5) and Box (SP6);
- direct reads (SP7);
- parking ADR 0019 (SP8).

The `memory` store kind exists only for tests and is never offered in Settings.

**Placeholder scan:** Three steps check an existing helper's signature (`core-api.ts` `call`, `useEnv`, CSS class names),
one step reads a gate's output (`conformance-http.mjs`), and Task 8 Step 8 says exactly what to change if a boot-path
test flags the `megajs` import. Each says what to check and what to do. No step reads "TBD" or "add error handling".

**Type consistency:**

- `deviceKeys()` returns `{ request, reply, snapshot, manifest }` in Tasks 1, 6 and 7.
- `ensureSyncKeys()` returns `{ root, epoch, signingKey, signingSpki, fingerprint }` in Tasks 6, 7 and 8.
- `SyncStore` methods (`put/get/list/remove/removeTree/describe`, plus `watch` and `close` on MEGA) match Tasks 3, 4, 6, 7 and 8.
- `listSyncDevices()` fields (`deviceId, dir, tier, name, ecdhSpki, signingSpki, addedAt, wrapEpoch`) match Tasks 2, 6, 7 and 8.
- The vault keys `sync.megaEmail` and `sync.megaPassword` (used in Task 8) are allowed in Task 2.
- `createMegaStore(config, secrets, deps)`, `validateMegaConfig`, `maskEmail` and `DEFAULT_MEGA_FOLDER` (Task 4) are the
  names Task 8 imports. The status `store` shape `{ folder, account }` matches Tasks 8 and 9.
- The error codes `SYNC_AUTH_FAILED | SYNC_MFA_REQUIRED | SYNC_RATE_LIMITED | SYNC_QUOTA | SYNC_UNREACHABLE | SYNC_IO` match
  Task 4, the Task 8 routes and schema, and the Task 9 texts.
