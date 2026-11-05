# Sync SP2: enrollment and device registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop user can add a phone or browser to encrypted sync with a QR code and a 6-digit code (SAS) that a malicious storage provider cannot defeat. They can revoke a device, rotate keys, and revoke a lost device with the desktop off by deleting its folder.

**Architecture:** The enrollment crypto (QR payload, claim, signed ack, SAS) is a new L0 module, `extension/core/sync-enroll.mjs`, on top of the SP1 envelope. Shared vectors come from the independent reference (`scripts/sync-vectors.mjs`). The desktop state machine (`extension/routes/sync/enroll.mjs`) keeps one pending enrollment per user in memory only. It pins the device's claim the first time it sees it and never fetches it again. The registry operations (revoke, missing-folder pruning) and key rotation hook into the SP1 producer, consumer and scheduler. A Node reference device (`extension/tests/helpers/sync-device.mjs`) runs the device contract that SP3 (WebCrypto) and SP4 (Swift) will implement. The Settings sync card gains "Add a phone or browser".

**Tech Stack:** Node 20+ `node:crypto` (ECDSA/ECDH P-256, AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256), better-sqlite3 (existing tables only, no migration), `node:test`, React 18 + TypeScript (desktop webview), `qrcode-generator` 2.0.4 (already a dependency).

**Spec:** `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` (§3 layout, §4 formats, §5 keys, §12 failures, §13 testing, §14 SP2 row), ADR `docs/decisions/0020-box-encrypted-sync.md`. Read with: SP1 plan `docs/superpowers/plans/2026-11-05-box-sync-desktop-producer.md`, the SP1 review `docs/superpowers/reviews/2026-11-06-sync-sp1-review.md`, and the device-linking lessons in `docs/superpowers/reviews/2026-11-05-device-linking-and-site-review.md` and `docs/superpowers/reviews/2026-11-05-relay-review.md` (Round 3).

## Global Constraints

- **Malicious storage model:** MEGA, Box, the user's server, or anyone holding the storage login can read, replace, replay or delete any file in the sync folder at any time. No value read from storage may enter a trust decision unless it is authenticated by a key pinned from the QR. The pinned keys are the desktop signing key (via `sfp`) and the enrollment secret `es`.
- **Commit-before-reveal:** each side computes the SAS only from values it holds or that were committed before the other side revealed. The device's keys are committed in its claim before the desktop picks `nD`. The desktop's values (`sid`, `sfp`, `dir`, `slot`, `es`, tier) are fixed in the QR before the device reveals anything.
- **Pin once:** the desktop pins the claim at the poll that first sees it and **never fetches the claim again**. Confirm uses only the pinned values.
- **Every SAS input is covered:** `sid, slot, dir, sfp (all 256 bits), tier, deviceId, device ECDH SPKI, device signing SPKI, name, nD`.
- **Tier comes from the desktop:** the user picks "iPhone app" or "Browser" on the desktop. The registry row's tier is that choice, never a value from storage.
- `es` is 16 random bytes. It exists only in the QR, in the desktop's process memory for at most 245 s, and on the device until its first wrap. It is never written to the database, the vault, the store or a log, and it is zeroed when the enrollment ends.
- Windows: the claim must arrive within **120 s** of opening the slot (by the desktop clock), and confirm must happen within **120 s** of the claim.
- Revoke = delete the device folder (`removeTree(<syncId>/d/<dir>)`) + drop the registry row + rotate the epoch. This follows the user's instruction. Spec §5.3 says rotation is not required; it is done anyway.
- Desktop-off revoke (spec Q10): a registered device whose wrap was written at this location (`wrapEpoch > 0`) and whose folder has no `key.bin` is dropped and the epoch rotated. The desktop records an activity notice and **never recreates the folder**.
- Rotation (spec §5.3, relay §4.9): new `K_root`, epoch + 1, new `wrap.bin` per device, full republish, then delete old blobs. The previous root is kept for 24 h (`sync.prevRootKey`, an internal vault key) only so that old-epoch requests can be answered `stale_epoch` under the old reply key.
- **Depends on the SP1 review fixes in `f73a73d5`:** `resetSyncPublish` sets `wrap_epoch = 0` on a store change, so pruning skips `wrapEpoch === 0`. `publishNow` runs under `withUserLock`. The sync routes and `megajs` load lazily (`server.mjs` line 819 imports `routes/sync/http-routes.mjs` dynamically), so new modules must be imported only from `routes/sync/*`, never from `server.mjs` statically. `sweepStuckRequests` stays as it is.
- ESLint layers (`extension/eslint.config.mjs`), zero exemptions: `core/` imports nothing internal except other `core/` files; `kb/` imports only `core`; routes may import any Node layer; nothing imports a route module except `server.mjs` and other `routes/sync/*` files (already the SP1 pattern).
- Every `kb` helper takes `userId` first. Every multi-step DB write uses `db.transaction()`. There is **no new migration**: the existing `sync_devices` table is the registry.
- Never log keys, `es`, `dir`, decrypted content or claim names. Logs carry counts and codes only. No route returns `es` except the one `POST /kb/sync/devices/enroll` response that the desktop webview turns into the QR.
- Bump `SERVER_API_VERSION` from 112 to **113** (or the next free number if another workstream took 113 first; then use that number everywhere this plan says 113) and add every new path to `ALL_ENDPOINTS`.
- Do not touch `ui/screens/settings/sections/AccountSection.tsx` (retired accounts) or anything under `desktop/src-tauri/`.
- Tests: `cd extension && node --test tests/<file>`. Each test file sets `LLMIDE_DB_PATH` to its own `_…-test.db`, as `tests/sync-producer.test.mjs` does.
- Commit on `main` (user rule: no branches), Conventional Commits, one concern per commit, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

---

## Device contract (SP3 WebCrypto, SP4 Swift)

This is the normative summary. Task 1 copies it into `schema/sync/v1/README.md` ("Enrollment") together with the vectors in `schema/sync/v1/vectors/v1.json` → `enroll`. The Node reference is `extension/tests/helpers/sync-device.mjs` (Task 2).

**Notation.** `enc`, `seal`, `open`, `subkey` and `syncwrap` are relay/sync v1 (`schema/relay/v1/README.md`, `schema/sync/v1/README.md`). b64u means base64url without padding. "Id22" means 16 random bytes as b64u (22 chars).

**1. QR payload.** The query is `sv=1&sid=<Id22>&sfp=<43 b64u>&dir=<Id22>&slot=<Id22>&es=<Id22>&st=<percent-encoded store descriptor>`, in exactly that order.

- iPhone app: `llmide://pair?<query>`.
- Browser: `<webOrigin>/#pair=<encodeURIComponent(query)>`. `webOrigin` defaults to `https://llm-ide.com`. The page must `history.replaceState` the fragment away before any other code runs.
- `st` in v1 is `mega:<folder>`, with the folder matching `[A-Za-z0-9_.-]{1,64}`. `memory:` exists for tests only.
- A device must ignore unknown parameters, because a later merged QR also carries the Host API fields `ip, pin, h1port, h1fp, api`. It must reject `sv` ≠ `1` and any field that does not match its pattern.

**2. Device keys.** The device generates fresh P-256 ECDH and ECDSA key pairs (non-extractable where the platform allows). `deviceId = b64u(SHA-256(signingSPKI)[0..16])`, which is 22 chars. `name` is 1 to 64 UTF-16 code units with no control characters.

**3. Derived keys.** `E(label) = HKDF-SHA-256(ikm = es (16 bytes), salt = SHA-256("llmide-sync-enroll-v1"), info = enc([label, sid, slot]), L = 32)` for `label ∈ {"enroll", "enrollack", "bind", "sas"}`. Let `sfpBytes = b64u-decode(sfp)` (32 bytes) and
`B = [sid, slot, dir, sfpBytes, tier, deviceId, ecdhSPKI, signingSPKI, name]`, where `tier` is `"ios"` for the iPhone app and `"web"` for a browser.

- `mac = HMAC-SHA-256(E("bind"), enc(B))`
- `claimHash = SHA-256(enc(["llmide/sync-claim/v1", deviceId, ecdhSPKI, signingSPKI, name]))`
- `SAS = u32be(HMAC-SHA-256(E("sas"), enc(B ++ [nD]))[0..4]) mod 1,000,000`, shown as 6 digits with leading zeros.

**4. Files and steps (device side).** All paths are relative to the store root.

| Step | Device does | File |
|---|---|---|
| a | Parse and validate the QR (1). | — |
| b | GET `<sid>/d/<dir>/key.bin`. Require `b64u(SHA-256(bytes)) == sfp` from the QR, and that the bytes are a canonical P-256 SPKI. Pin it as the desktop verify key. Stop on mismatch. | read `key.bin` |
| c | Write the claim once, under a random Id22 name, and reuse the same name and bytes on any retry. The claim is `seal(header { purpose "enroll", userId "", desktopId sid, from deviceId, to sid, epoch 0, session slot, seq 0, issuedAt <device ms>, tier "" }, key E("enroll"), plaintext enc([ecdhSPKI, signingSPKI, name, mac]), signed by the device signing key, extra = signingSPKI)`. The JSON goes to `<sid>/e/<slot>/<Id22>.bin`. | write claim |
| d | Poll `<sid>/e/<slot>/ack.bin` every 2 s for up to 150 s. `open` it with the pinned desktop key and `E("enrollack")`, expecting `{ purpose "enrollack", desktopId sid, from sid, to deviceId, epoch 0, session slot, tier <own tier> }`. The plaintext is `enc([nD (16 bytes), claimHash])`. Require `claimHash` = its own value, or fail with `ack_mismatch` ("someone else answered this code"). Keep `userId = header.userId`. Show the SAS. | read `ack.bin` |
| e | Poll `<sid>/d/<dir>/wrap.bin` every 2 s for up to 300 s. Require header `tier` = own tier, `from = desktopId = sid`, and `userId` = the ack's. Then `unwrapSync` (verify with the pinned key first, `to = deviceId`, `epoch > 0`) gives `{request, reply, snapshot, manifest}`. Erase `es` and the `E(*)` keys. | read `wrap.bin` |
| f | From then on, read only `<sid>/d/<dir>/`: `manifest.bin`, the `s/<hex>.bin` blobs it names, `out/<requestId>.bin`. Write only `in/<13-digit ms>-<requestId>.bin` (spec §4.3, §4.4). | — |

**5. Rotation (device side).** When `manifest.bin` has `epoch` above the device's own, GET `wrap.bin` and unwrap (it accepts only a higher epoch). Then reopen the manifest. Erase old keys after the new manifest verifies, except the old reply key, which is kept for 24 h. A reply `{ok:false, code:"stale_epoch"}` sealed under that old reply key means "send the request again under the new epoch".

**6. Revoke.** The device's folder disappears. A device that finds `key.bin`, `wrap.bin` or `manifest.bin` missing shows "This device was removed from sync" and stops. With the desktop off, the user deletes `<sid>/d/<dir>` in the storage's web UI. Settings shows the first 6 characters of each `dir` as `folderHint` so the user can find it.

**7. Desktop side (what the device relies on).** The desktop writes `key.bin` when the slot opens. It pins the first claim it sees. More than one claim file means the slot is killed (`contested`). It writes exactly one `ack.bin` per slot, bound to the pinned claim's hash and a fresh `nD`. On confirm it writes the registry row (tier = the desktop's choice), then `wrap.bin`, then publishes, then deletes `e/<slot>/`.

**Why storage cannot sit in the middle.** Without `es`, storage cannot produce a claim that opens (GCM under `E("enroll")`, plus the MAC), and it cannot read or forge the ack. Without the desktop signing key, whose fingerprint came through the QR, it cannot forge `key.bin`, `ack.bin` or `wrap.bin`. Suppose an attacker photographed the QR and so knows `es`, and also controls storage. It can replace the real claim with its own. The desktop then signs an ack bound to the attacker's `claimHash`, so the real device fails at (d) and never shows a code. It cannot grind keys to match the phone's SAS, because `nD` is chosen after its claim is pinned, and the device never accepts an ack for a different claim. A second claim kills the slot.

---

## File Structure

| File | New/Modify | Responsibility |
|---|---|---|
| `extension/core/sync-enroll.mjs` | create | QR payload, enrollment keys, claim/ack seal and open, MAC, claim hash, SAS (L0) |
| `extension/core/sync-envelope.mjs` | modify | add purposes `enroll`, `enrollack` |
| `scripts/sync-vectors.mjs` | modify | build and check the `enroll` vectors from the independent reference |
| `schema/sync/v1/vectors/v1.json` | regenerate | adds `enroll` (existing entries unchanged) |
| `schema/sync/v1/README.md` | modify | "Enrollment (device contract)" section |
| `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` | modify | §5.2 amended: derived `deviceId`, signed ack with `nD`, full SAS inputs |
| `extension/tests/sync-enroll-crypto.test.mjs` | create | core vs vectors, negatives |
| `extension/routes/sync/producer.mjs` | modify | extract `writeDeviceWrap`; prune missing folders and rotate at the top of `publishOnce` |
| `extension/routes/sync/enroll.mjs` | create | desktop enrollment state machine (in memory) |
| `extension/tests/helpers/sync-device.mjs` | create | Node reference device (the device contract) |
| `extension/tests/sync-enroll.test.mjs` | create | happy path end to end, expiry, cancel, replace, es never stored |
| `extension/tests/helpers/tamper-store.mjs` | create | a store that rewrites anything |
| `extension/tests/sync-enroll-malicious.test.mjs` | create | malicious storage at every step |
| `extension/routes/sync/keys.mjs` | modify | `rotateKeys`, `previousRoot`, `PREV_KEY_MS` |
| `extension/server/vault.mjs` | modify | `sync.prevRootKey` allowed + internal |
| `extension/routes/sync/scheduler.mjs` | modify | `rotateNow`, `rotationPending`, rotation inside `syncCycle` |
| `extension/routes/sync/consumer.mjs` | modify | `stale_epoch` replies; never write a reply into a missing folder |
| `extension/tests/sync-rotate.test.mjs` | create | rotation, stale_epoch, pending rotation |
| `extension/kb/sync-state.mjs` | modify | `deleteSyncDevice` |
| `extension/kb/activity.mjs` | modify | activity kind `sync_device_removed` |
| `extension/routes/sync/registry.mjs` | create | `folderPresent`, `revokeDevice`, `pruneMissingDevices` |
| `extension/tests/sync-registry.test.mjs` | create | revoke, desktop-off revoke, no recreation, reply guard |
| `extension/routes/sync/http-routes.mjs` | modify | enroll/poll/confirm/cancel, revoke, rotate; status `folderHint`, `rotationPending` |
| `extension/server.mjs` | modify (shared) | `ALL_ENDPOINTS`, `SERVER_API_VERSION` 113 + comment |
| `schema/http/sync.schema.json` + regenerated `schema/http/INVENTORY.md`, API types, openapi | modify / regenerate | contract gates |
| `extension/tests/sync-routes.test.mjs` | modify | route tests |
| `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`, `extension/CLAUDE.md` | modify | version 113, kbWrite row, sync section |
| `ui/screens/settings/sync-model.ts` | modify | enrollment, revoke and rotate calls and decoders |
| `ui/screens/settings/sections/SyncDevices.tsx` | create | "Add a phone or browser": QR, SAS confirm, device list, revoke, rotate |
| `ui/screens/settings/sections/SyncSection.tsx` | modify | render `<SyncDevices />` |
| `ui/screens/settings/sections/HostApiPairing.tsx` | modify | `export` the existing `PairingQr` (no other change) |
| `ui/screens/settings/tests/sync-section.test.mjs` | modify | model tests |

---

### Task 1: Enrollment crypto, shared vectors and the device contract text

**Files:**
- Create: `extension/core/sync-enroll.mjs`
- Modify: `extension/core/sync-envelope.mjs:9` (the `PURPOSES` line)
- Modify: `scripts/sync-vectors.mjs` (`build()` and the check branch)
- Regenerate: `schema/sync/v1/vectors/v1.json`
- Modify: `schema/sync/v1/README.md`, `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md` (§5.2)
- Test: `extension/tests/sync-enroll-crypto.test.mjs`

**Interfaces:**
- Consumes: `enc`, `decodeEnc`, `seal`, `open`, `sha256`, `spkiFingerprint`, `SyncCryptoError` from `core/sync-envelope.mjs`.
- Produces (`core/sync-enroll.mjs`):
  - `PAIR_FIELDS: string[]`, `ID22: RegExp`, `NAME_MAX = 64`, `newId22(): string`
  - `pairQuery(pair): string`, `pairUrl(pair, tier, webOrigin = 'https://llm-ide.com'): string`, `parsePair(url): Pair`. `Pair = { sid, sfp, dir, slot, es, st }` (all strings).
  - `enrollKeys(es: Buffer, sid, slot): { enroll, enrollack, bind, sas }` (32-byte Buffers)
  - `deviceIdOf(signingSpki): string`, `p256Spki(bytes): KeyObject` (throws `bad_key`), `validName(name): boolean`
  - `claimMac(bindKey, f): Buffer`, `claimHash({deviceId, ecdhSpki, signingSpki, name}): Buffer`, `sasCode(sasKey, f & {nD}): string`. Here `f = { sid, slot, dir, sfp, tier, deviceId, ecdhSpki, signingSpki, name }`.
  - `sealClaim({ pair, tier, name, ecdhSpki, signingSpki, signingKey, issuedAt, nonce? }): env`
  - `openClaim({ env, pair, tier, keys }): { deviceId, ecdhSpki, signingSpki, name }`
  - `sealAck({ userId, pair, tier, claim, nD, keys, signingKey, seq, issuedAt, nonce? }): env`
  - `openAck({ env, pair, tier, claim, keys, desktopVerifyKey }): { userId, nD }`
  - Error codes (`SyncCryptoError.code`): `bad_pair`, `bad_secret`, `bad_key`, `bad_name`, `bad_tier`, `bad_from`, `bad_mac`, `bad_ack`, `ack_mismatch`, `bad_userId`, plus the envelope's own (`bad_signature`, `bad_ciphertext`, `bad_session`, `bad_tier`, …).

- [ ] **Step 1: Add the purposes to the envelope**

In `extension/core/sync-envelope.mjs` replace line 9:

```js
export const PURPOSES = Object.freeze(['request', 'reply', 'snapshot', 'manifest', 'syncwrap', 'enroll', 'enrollack']);
```

- [ ] **Step 2: Write the failing test**

Create `extension/tests/sync-enroll-crypto.test.mjs`:

```js
// Enrollment crypto (schema/sync/v1/README.md "Enrollment"): the core module reproduces the reference vectors byte for
// byte, and every negative fails closed with the stated code. SP3 (WebCrypto) and SP4 (Swift) run the same vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as S from '../core/sync-envelope.mjs';
import * as E from '../core/sync-enroll.mjs';

const V = JSON.parse(readFileSync(new URL('../../schema/sync/v1/vectors/v1.json', import.meta.url)));
const X = V.enroll;
const b = (s) => Buffer.from(s, 'base64url');
const priv = (s) => createPrivateKey({ key: b(s), format: 'der', type: 'pkcs8' });
const pub = (s) => createPublicKey({ key: b(s), format: 'der', type: 'spki' });
const claimOf = () => ({ deviceId: X.deviceId, ecdhSpki: b(V.keys.deviceEcdhSpki), signingSpki: b(X.deviceSigningSpki), name: X.name });
const keysOf = (es = X.pair.es) => E.enrollKeys(b(es), X.pair.sid, X.pair.slot);

test('QR payload: both URL forms parse back to the same fields; junk is refused', () => {
  assert.equal(E.pairUrl(X.pair, 'ios'), X.iosUrl);
  assert.equal(E.pairUrl(X.pair, 'web'), X.webUrl);
  assert.deepEqual(E.parsePair(X.iosUrl), X.pair);
  assert.deepEqual(E.parsePair(X.webUrl), X.pair);
  assert.deepEqual(E.parsePair(`${X.iosUrl}&ip=192.168.1.2&pin=123456&h1port=8443&api=1`), X.pair, 'Host API fields are ignored');
  for (const bad of [X.iosUrl.replace('sv=1', 'sv=2'), X.iosUrl.replace(/es=[^&]+/, 'es=short'), X.iosUrl.replace(/st=[^&]+/, 'st=box%3A1'), 'https://evil.example/#nope', 42]) {
    assert.throws(() => E.parsePair(bad), (e) => e.code === 'bad_pair', String(bad));
  }
});

test('derived keys, deviceId, MAC, claim hash and SAS match the reference', () => {
  const k = keysOf();
  assert.equal(k.enroll.toString('hex'), X.enrollKeyHex);
  assert.equal(k.enrollack.toString('hex'), X.enrollackKeyHex);
  assert.equal(k.bind.toString('hex'), X.bindKeyHex);
  assert.equal(k.sas.toString('hex'), X.sasKeyHex);
  assert.equal(E.deviceIdOf(b(X.deviceSigningSpki)), X.deviceId);
  const f = { ...X.pair, tier: X.tier, ...claimOf() };
  assert.equal(E.claimMac(k.bind, f).toString('hex'), X.macHex);
  assert.equal(E.claimHash(claimOf()).toString('hex'), X.claimHashHex);
  assert.equal(E.sasCode(k.sas, { ...f, nD: Buffer.from(X.nDHex, 'hex') }), X.sas);
  assert.match(X.sas, /^[0-9]{6}$/);
});

test('claim: the desktop opens the vector claim; a re-seal with the same nonce gives the same ciphertext', () => {
  const k = keysOf();
  assert.deepEqual(E.openClaim({ env: X.claim.env, pair: X.pair, tier: X.tier, keys: k }), claimOf());
  const again = E.sealClaim({ pair: X.pair, tier: X.tier, name: X.name, ecdhSpki: b(V.keys.deviceEcdhSpki), signingSpki: b(X.deviceSigningSpki),
    signingKey: priv(V.keys.deviceSigningPkcs8), issuedAt: X.claim.env.issuedAt, nonce: Buffer.from(X.claim.nonceHex, 'hex') });
  assert.equal(again.ct, X.claim.env.ct);
});

test('ack: the device opens the vector ack with the pinned desktop key', () => {
  const out = E.openAck({ env: X.ack.env, pair: X.pair, tier: X.tier, claim: claimOf(), keys: keysOf(), desktopVerifyKey: pub(V.keys.desktopSigningSpki) });
  assert.equal(out.userId, X.userId);
  assert.equal(out.nD.toString('hex'), X.nDHex);
});

test('every enroll negative fails closed with its code', () => {
  for (const n of X.negatives) {
    const env = structuredClone(n.target === 'claim' ? X.claim.env : X.ack.env);
    let pair = X.pair; let tier = X.tier; let claim = claimOf(); let es = X.pair.es; let verify = pub(V.keys.desktopSigningSpki);
    const m = n.mutate;
    if (m.op === 'flip') { const x = b(env[m.field]); x[0] ^= 1; env[m.field] = x.toString('base64url'); }
    else if (m.op === 'set') env[m.field] = m.value;
    else if (m.op === 'expect') { if (m.field === 'tier') tier = m.value; else if (m.field === 'es') es = m.value; else if (m.field === 'name') claim = { ...claim, name: m.value }; else pair = { ...pair, [m.field]: m.value }; }
    else if (m.op === 'verifyKey') verify = pub(V.keys.deviceSigningSpki);
    const keys = E.enrollKeys(b(es), pair.sid, pair.slot);
    const run = () => (n.target === 'claim'
      ? E.openClaim({ env, pair, tier, keys })
      : E.openAck({ env, pair, tier, claim, keys, desktopVerifyKey: verify }));
    assert.throws(run, (e) => e instanceof S.SyncCryptoError && e.code === n.error, `${n.target} ${JSON.stringify(m)} -> ${n.error}`);
  }
});

test('openClaim refuses a claim whose signing key is not P-256', () => {
  const k = keysOf();
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' });
  assert.throws(() => E.p256Spki(p384), (e) => e.code === 'bad_key');
  const env = { ...X.claim.env, eph: p384.toString('base64url') };
  assert.throws(() => E.openClaim({ env, pair: X.pair, tier: X.tier, keys: k }), (e) => e.code === 'bad_key');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-enroll-crypto.test.mjs`
Expected: FAIL with `Cannot find module '../core/sync-enroll.mjs'` (or `X` undefined because `enroll` is not in the vectors yet).

- [ ] **Step 4: Write `extension/core/sync-enroll.mjs`**

```js
// Sync v1 enrollment (design 5.2 as amended; schema/sync/v1/README.md "Enrollment"): the pairing QR, the device's claim,
// the desktop's signed ack and the 6-digit SAS. Node crypto only (L0). Each side computes the SAS only from values it
// holds or that were committed before the other side revealed; nothing the storage supplies enters a trust decision.
import { createHmac, createPublicKey, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { enc, decodeEnc, seal, open, sha256, SyncCryptoError } from './sync-envelope.mjs';

export const PAIR_VERSION = '1';
export const PAIR_FIELDS = Object.freeze(['sid', 'sfp', 'dir', 'slot', 'es', 'st']);
export const ID22 = /^[A-Za-z0-9_-]{22}$/;
export const NAME_MAX = 64;
const FP43 = /^[A-Za-z0-9_-]{43}$/;
const ST_RE = /^(mega:[A-Za-z0-9_.-]{1,64}|memory:)$/; // memory: is the test adapter only
const USER_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ENROLL_SALT = sha256(Buffer.from('llmide-sync-enroll-v1'));
const fail = (code) => { throw new SyncCryptoError(code); };

export const newId22 = () => randomBytes(16).toString('base64url');

export function pairQuery(p) {
  return `sv=${PAIR_VERSION}&${PAIR_FIELDS.map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&')}`;
}

export function pairUrl(p, tier, webOrigin = 'https://llm-ide.com') {
  const q = pairQuery(p);
  return tier === 'ios' ? `llmide://pair?${q}` : `${webOrigin}/#pair=${encodeURIComponent(q)}`;
}

export function parsePair(url) {
  if (typeof url !== 'string') fail('bad_pair');
  let q;
  if (url.startsWith('llmide://pair?')) q = url.slice('llmide://pair?'.length);
  else {
    const i = url.indexOf('#pair=');
    if (i < 0) fail('bad_pair');
    try { q = decodeURIComponent(url.slice(i + '#pair='.length)); } catch { fail('bad_pair'); }
  }
  const s = new URLSearchParams(q);
  if (s.get('sv') !== PAIR_VERSION) fail('bad_pair');
  const p = Object.fromEntries(PAIR_FIELDS.map((k) => [k, s.get(k) ?? '']));
  if (![p.sid, p.dir, p.slot, p.es].every((v) => ID22.test(v)) || !FP43.test(p.sfp) || !ST_RE.test(p.st)) fail('bad_pair');
  return p;
}

export function enrollKeys(es, sid, slot) {
  const ikm = Buffer.from(es);
  if (ikm.length !== 16) fail('bad_secret');
  const k = (label) => Buffer.from(hkdfSync('sha256', ikm, ENROLL_SALT, enc([label, sid, slot]), 32));
  return { enroll: k('enroll'), enrollack: k('enrollack'), bind: k('bind'), sas: k('sas') };
}

export const deviceIdOf = (signingSpki) => sha256(signingSpki).subarray(0, 16).toString('base64url');

/** A P-256 public key whose DER is canonical (re-export gives the same bytes), so ids and hashes cannot be malleated. */
export function p256Spki(bytes) {
  const der = Buffer.from(bytes);
  let key;
  try { key = createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch { fail('bad_key'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || !key.export({ type: 'spki', format: 'der' }).equals(der)) fail('bad_key');
  return key;
}

export const validName = (n) => typeof n === 'string' && n.length >= 1 && n.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(n);

const bound = (f) => [f.sid, f.slot, f.dir, Buffer.from(f.sfp, 'base64url'), f.tier, f.deviceId, f.ecdhSpki, f.signingSpki, f.name];
export const claimMac = (bindKey, f) => createHmac('sha256', bindKey).update(enc(bound(f))).digest();
export const claimHash = ({ deviceId, ecdhSpki, signingSpki, name }) => sha256(enc(['llmide/sync-claim/v1', deviceId, ecdhSpki, signingSpki, name]));

export function sasCode(sasKey, f) {
  const h = createHmac('sha256', sasKey).update(enc([...bound(f), f.nD])).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

const checkTier = (tier) => { if (tier !== 'web' && tier !== 'ios') fail('bad_tier'); };

/** Device: the claim it writes to e/<slot>/<Id22>.bin. extra = its signing SPKI, so the signature verifies before decrypt. */
export function sealClaim({ pair, tier, name, ecdhSpki, signingSpki, signingKey, issuedAt, nonce }) {
  checkTier(tier);
  if (!validName(name)) fail('bad_name');
  const keys = enrollKeys(Buffer.from(pair.es, 'base64url'), pair.sid, pair.slot);
  const deviceId = deviceIdOf(signingSpki);
  const mac = claimMac(keys.bind, { ...pair, tier, deviceId, ecdhSpki, signingSpki, name });
  const header = { purpose: 'enroll', userId: '', desktopId: pair.sid, from: deviceId, to: pair.sid, epoch: 0, session: pair.slot, seq: 0, issuedAt, tier: '' };
  return seal({ header, key: keys.enroll, plaintext: enc([ecdhSpki, signingSpki, name, mac]), signingKey, extra: Buffer.from(signingSpki), ...(nonce ? { nonce } : {}) });
}

/** Desktop: open a claim with the slot's own values (pair, tier) and keys. Every check fails closed. */
export function openClaim({ env, pair, tier, keys }) {
  checkTier(tier);
  if (!env || typeof env !== 'object' || typeof env.eph !== 'string') fail('bad_envelope');
  const spki = Buffer.from(env.eph, 'base64url');
  const verifyKey = p256Spki(spki);
  const pt = open({ env, key: keys.enroll, verifyKey, expect: { purpose: 'enroll', userId: '', desktopId: pair.sid, to: pair.sid, epoch: 0, session: pair.slot, seq: 0, tier: '' } });
  const [ecdhSpki, signingSpki, nameBytes, mac] = decodeEnc(pt, 4).map((p) => Buffer.from(p));
  if (!signingSpki.equals(spki)) fail('bad_key');
  p256Spki(ecdhSpki);
  const name = nameBytes.toString('utf8');
  if (!validName(name) || !Buffer.from(name, 'utf8').equals(nameBytes)) fail('bad_name');
  const deviceId = deviceIdOf(signingSpki);
  if (env.from !== deviceId) fail('bad_from');
  const want = claimMac(keys.bind, { ...pair, tier, deviceId, ecdhSpki, signingSpki, name });
  if (mac.length !== 32 || !timingSafeEqual(mac, want)) fail('bad_mac');
  return { deviceId, ecdhSpki, signingSpki, name };
}

/** Desktop: the one ack per slot, bound to the pinned claim and a fresh nD chosen after the claim was pinned. */
export function sealAck({ userId, pair, tier, claim, nD, keys, signingKey, seq, issuedAt, nonce }) {
  checkTier(tier);
  const header = { purpose: 'enrollack', userId, desktopId: pair.sid, from: pair.sid, to: claim.deviceId, epoch: 0, session: pair.slot, seq, issuedAt, tier };
  return seal({ header, key: keys.enrollack, plaintext: enc([nD, claimHash(claim)]), signingKey, ...(nonce ? { nonce } : {}) });
}

/** Device: verify the ack with the desktop key pinned by sfp; refuse an ack for anyone else's claim. */
export function openAck({ env, pair, tier, claim, keys, desktopVerifyKey }) {
  checkTier(tier);
  const pt = open({ env, key: keys.enrollack, verifyKey: desktopVerifyKey, expect: { purpose: 'enrollack', desktopId: pair.sid, from: pair.sid, to: claim.deviceId, epoch: 0, session: pair.slot, tier } });
  const [nD, hash] = decodeEnc(pt, 2).map((p) => Buffer.from(p));
  if (nD.length !== 16 || hash.length !== 32) fail('bad_ack');
  if (!timingSafeEqual(hash, claimHash(claim))) fail('ack_mismatch');
  if (typeof env.userId !== 'string' || !USER_RE.test(env.userId)) fail('bad_userId');
  return { userId: env.userId, nD };
}
```

- [ ] **Step 5: Extend `scripts/sync-vectors.mjs` with the independent reference**

Add `createHmac` to the `node:crypto` import. At the end of `build()`, just before `return {`, add the block below. It uses only `R.*` and Node primitives and never imports `core/sync-enroll.mjs`:

```js
  // Enrollment (README "Enrollment"), built independently of extension/core/sync-enroll.mjs.
  const ENR_SALT = sha(Buffer.from('llmide-sync-enroll-v1'));
  const es = Buffer.alloc(16, 0x77);
  const pair = { sid: ids.desktopId, sfp: sha(deskSpki).toString('base64url'), dir: 'D'.repeat(22), slot: 'E'.repeat(22), es: es.toString('base64url'), st: 'mega:llmide-sync' };
  const query = `sv=1&sid=${pair.sid}&sfp=${pair.sfp}&dir=${pair.dir}&slot=${pair.slot}&es=${pair.es}&st=${encodeURIComponent(pair.st)}`;
  const ek = (label) => Buffer.from(hkdfSync('sha256', es, ENR_SALT, R.enc([label, pair.sid, pair.slot]), 32));
  const devSig = b(keys.deviceSigningSpki);
  const deviceId = sha(devSig).subarray(0, 16).toString('base64url');
  const tier = 'ios'; const name = 'Test iPhone'; const userId = ids.userId;
  const B = [pair.sid, pair.slot, pair.dir, b(pair.sfp), tier, deviceId, devSpki, devSig, name];
  const mac = createHmac('sha256', ek('bind')).update(R.enc(B)).digest();
  const claimHash = sha(R.enc(['llmide/sync-claim/v1', deviceId, devSpki, devSig, name]));
  const nD = Buffer.alloc(16, 0x6e);
  const sasH = createHmac('sha256', ek('sas')).update(R.enc([...B, nD])).digest();
  const sas = String(sasH.readUInt32BE(0) % 1_000_000).padStart(6, '0');
  const claimEnv = R.seal({ header: { purpose: 'enroll', userId: '', desktopId: pair.sid, from: deviceId, to: pair.sid, epoch: 0, session: pair.slot, seq: 0, issuedAt: 1762300000100, tier: '' },
    key: ek('enroll'), plaintext: R.enc([devSpki, devSig, name, mac]), signingKey: priv(keys.deviceSigningPkcs8), nonce: Buffer.alloc(12, 0x61), extra: devSig });
  const ackEnv = R.seal({ header: { purpose: 'enrollack', userId, desktopId: pair.sid, from: pair.sid, to: deviceId, epoch: 0, session: pair.slot, seq: 12, issuedAt: 1762300000200, tier },
    key: ek('enrollack'), plaintext: R.enc([nD, claimHash]), signingKey, nonce: Buffer.alloc(12, 0x62) });
  const enroll = {
    pair, tier, name, userId, iosUrl: `llmide://pair?${query}`, webUrl: `https://llm-ide.com/#pair=${encodeURIComponent(query)}`,
    deviceSigningSpki: keys.deviceSigningSpki, deviceId,
    enrollKeyHex: hex(ek('enroll')), enrollackKeyHex: hex(ek('enrollack')), bindKeyHex: hex(ek('bind')), sasKeyHex: hex(ek('sas')),
    macHex: hex(mac), claimHashHex: hex(claimHash), nDHex: hex(nD), sas,
    claim: { name: 'F'.repeat(22), nonceHex: hex(Buffer.alloc(12, 0x61)), env: claimEnv }, ack: { nonceHex: hex(Buffer.alloc(12, 0x62)), env: ackEnv },
    negatives: [
      { target: 'claim', mutate: { op: 'flip', field: 'ct' }, error: 'bad_signature' },
      { target: 'claim', mutate: { op: 'expect', field: 'es', value: Buffer.alloc(16, 0x78).toString('base64url') }, error: 'bad_ciphertext' },
      { target: 'claim', mutate: { op: 'expect', field: 'tier', value: 'web' }, error: 'bad_mac' },
      { target: 'claim', mutate: { op: 'expect', field: 'dir', value: 'G'.repeat(22) }, error: 'bad_mac' },
      { target: 'claim', mutate: { op: 'expect', field: 'sfp', value: 'H'.repeat(43) }, error: 'bad_mac' },
      { target: 'claim', mutate: { op: 'set', field: 'session', value: 'G'.repeat(22) }, error: 'bad_session' },
      { target: 'ack', mutate: { op: 'flip', field: 'sig' }, error: 'bad_signature' },
      { target: 'ack', mutate: { op: 'verifyKey' }, error: 'bad_signature' },
      { target: 'ack', mutate: { op: 'expect', field: 'name', value: 'Attacker phone' }, error: 'ack_mismatch' },
      { target: 'ack', mutate: { op: 'expect', field: 'tier', value: 'web' }, error: 'bad_tier' },
      { target: 'ack', mutate: { op: 'set', field: 'session', value: 'G'.repeat(22) }, error: 'bad_session' },
    ],
  };
```

Add `enroll,` to the returned object, after `syncwrap: { env: syncwrap },`. In the check branch, after the `sigOk` computation, add a verification of the two enrollment signatures and fold it into the exit condition:

```js
  const verifyEnv = (e, spki) => verify('sha256', Buffer.concat([Buffer.from(`llmide/${e.purpose}/v1\0`), R.enc([...R.headerFields(e), e.eph ? b(e.eph) : Buffer.alloc(0), b(e.nonce), b(e.ct)])]), { key: pub(spki), dsaEncoding: 'ieee-p1363' }, b(e.sig));
  const enrollOk = !!current.enroll && verifyEnv(current.enroll.claim.env, current.enroll.deviceSigningSpki) && verifyEnv(current.enroll.ack.env, current.keys.desktopSigningSpki);
```

and change the exit line to `if (!same || !sigOk || !enrollOk) { … }`. Also add `deviceSigningPkcs8: keys.deviceSigningPkcs8, deviceSigningSpki: keys.deviceSigningSpki` to the `keys:` object in the returned vectors, so SP3/SP4 have the device signing key. (The test reads `V.keys.deviceSigningPkcs8`.)

Note on the `ack.name` negative: the "expected" claim in that case is the real one with a different `name`. Its `claimHash` therefore differs, and `openAck` must return `ack_mismatch`. That is the substituted-claim case.

- [ ] **Step 6: Regenerate and check the vectors**

Run: `node scripts/sync-vectors.mjs --write && node scripts/sync-vectors.mjs`
Expected: `wrote …/v1.json` then `sync v1 vectors ok`. Run `git diff --stat schema/sync/v1/vectors/v1.json`. The existing `snapshot`/`manifest`/`syncwrap` ciphertexts must be unchanged (fixed nonces); only `sig` strings, the new `keys` entries and `enroll` change.

- [ ] **Step 7: Run the tests**

Run: `cd extension && node --test tests/sync-enroll-crypto.test.mjs tests/sync-envelope.test.mjs`
Expected: PASS (all). If a negative reports a different code, fix the code in `sync-enroll.mjs`, not the vector. The vector codes are the contract.

- [ ] **Step 8: Write the device contract into `schema/sync/v1/README.md`**

Add two rows to the purpose table (`enroll`: device → desktop, key `E("enroll")`; `enrollack`: desktop → device, key `E("enrollack")`). Append a section `## Enrollment (device contract)` that contains, verbatim, items 1 to 7 and "Why storage cannot sit in the middle" from this plan's "Device contract" section. Then add one line: "Adding `enroll`/`enrollack` is additive: no existing byte changes, so `v` stays 1; vectors: `enroll` in `vectors/v1.json`; Node reference device: `extension/tests/helpers/sync-device.mjs`."

- [ ] **Step 9: Amend spec §5.2**

In `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md`, §5.2, replace steps 2 to 5 with the steps below, and add `sv` to the field table ("payload version, `1`"). Leave the rest of §5.2 unchanged.

```markdown
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
```

- [ ] **Step 10: Commit**

```bash
git add extension/core/sync-enroll.mjs extension/core/sync-envelope.mjs scripts/sync-vectors.mjs schema/sync/v1 extension/tests/sync-enroll-crypto.test.mjs docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md
git commit -m "feat(sync): enrollment crypto, QR payload and shared vectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Desktop enrollment state machine and the Node reference device

**Files:**
- Modify: `extension/routes/sync/producer.mjs` (extract `writeDeviceWrap`, lines 51-57 today)
- Create: `extension/routes/sync/enroll.mjs`
- Create: `extension/tests/helpers/sync-device.mjs`
- Test: `extension/tests/sync-enroll.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`core/sync-enroll.mjs`); `ensureSyncKeys`, `syncIdsFor` (`routes/sync/keys.mjs`); `getSyncState`, `listSyncDevices`, `addSyncDevice`, `nextSeq`, `setDeviceWrapEpoch` (`kb/sync-state.mjs`); `deviceKeys`, `makeSyncWrap`, `unwrapSync`, `seal`, `open`, `sha256`, `spkiFingerprint` (`core/sync-envelope.mjs`).
- Produces:
  - `writeDeviceWrap({ userId, store, state, keys, dev, now }): Promise<void>` (producer.mjs). Writes `key.bin` and `wrap.bin`, then sets `wrapEpoch`.
  - `ENROLL = { claimMs: 120000, confirmMs: 120000, maxClaimBytes: 8192 }` (enroll.mjs)
  - `startEnrollment(userId, { store, tier, now?, env? }): Promise<{ qr, expiresAt, tier }>`
  - `pollEnrollment(userId, { now? }): Promise<{ phase: 'none'|'waiting'|'confirm'|'failed'|'expired', sas: string|null, name: string|null, tier: 'web'|'ios'|null, code: string|null }>`
  - `confirmEnrollment(userId, { now? }): Promise<{ deviceId }>`; throws codes `ENROLL_NOT_READY`, `ENROLL_FAILED`, `SYNC_OFF`
  - `cancelEnrollment(userId): Promise<void>`, `_resetEnrollmentsForTest(): void`
  - Failure codes in `pollEnrollment().code`: `expired`, `contested`, `claim_invalid`, `store`, `replaced`, `cancelled`
  - Reference device `createReferenceDevice({ tier, name })` with: `deviceId`, `scanAndClaim(store, qr, { now })`, `readAck(store) → sas | null` (throws on a forged or foreign ack), `readWrap(store) → boolean`, `readSnapshot(store) → { manifest, kinds }`, `sendRequest(store, text, { now, epoch?, key? }) → requestId`, `readReply(store, requestId) → reply | null`, and the state `epoch`, `wrapKeys`, `prevReply`.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/sync-enroll.test.mjs`:

```js
// Enrollment end to end with the Node reference device: QR -> claim -> pinned claim + signed ack -> same SAS on both
// screens -> registry (desktop tier) -> wrap -> the device reads its first snapshot. es never reaches the store or DB.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-enroll-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const E = await import('../core/sync-enroll.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { publishOnce } = await import('../routes/sync/producer.mjs');
const { startEnrollment, pollEnrollment, confirmEnrollment, cancelEnrollment, ENROLL, _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');

const T = 1_762_400_000_000;
let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `se-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'e' }).id;
const kinds = () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k, Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: 1, truncated: false, items: [] }))]));
function setup() {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  return { u, store: createMemoryStore(), sid: st.getSyncState(u).syncId };
}
beforeEach(() => _resetEnrollmentsForTest());

test('happy path: same SAS on both screens, desktop tier, wrap, first snapshot, slot gone', async () => {
  const { u, store, sid } = setup();
  const { qr, tier, expiresAt } = await startEnrollment(u, { store, tier: 'ios', now: T });
  assert.equal(tier, 'ios'); assert.equal(expiresAt, T + ENROLL.claimMs);
  assert.ok(qr.startsWith('llmide://pair?sv=1&'));
  const pair = E.parsePair(qr);
  assert.equal(pair.sid, sid);
  assert.equal(pair.st, 'memory:');
  assert.equal((await pollEnrollment(u, { now: T + 500 })).phase, 'waiting');

  const dev = createReferenceDevice({ tier: 'ios', name: 'My iPhone' });
  await dev.scanAndClaim(store, qr, { now: T + 600 });
  assert.equal(await dev.readAck(store), null, 'no ack before the desktop has seen the claim');
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'confirm'); assert.equal(p.name, 'My iPhone'); assert.match(p.sas, /^[0-9]{6}$/);
  assert.equal(await dev.readAck(store), p.sas, 'both screens show the same code');
  assert.equal(st.listSyncDevices(u).length, 0, 'nothing is registered before the user confirms');

  assert.deepEqual(await confirmEnrollment(u, { now: T + 2000 }), { deviceId: dev.deviceId });
  const [row] = st.listSyncDevices(u);
  assert.equal(row.deviceId, dev.deviceId); assert.equal(row.tier, 'ios'); assert.equal(row.dir, pair.dir); assert.equal(row.name, 'My iPhone');
  assert.ok(row.signingSpki.equals(dev.signingSpki)); assert.ok(row.ecdhSpki.equals(dev.ecdhSpki));
  assert.equal(await dev.readWrap(store), true);
  assert.equal(dev.epoch, st.getSyncState(u).epoch);
  await publishOnce({ userId: u, store, now: T + 3000, loadKinds: kinds });
  const snap = await dev.readSnapshot(store);
  assert.deepEqual(Object.keys(snap.kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
  assert.deepEqual(await store.list(`${sid}/e/${pair.slot}`), [], 'the slot is deleted');
  assert.equal((await pollEnrollment(u, { now: T + 4000 })).phase, 'none');

  const esBytes = Buffer.from(pair.es, 'base64url');
  for (const [p2, bytes] of store.dump()) assert.ok(!bytes.includes(esBytes) && !bytes.includes(Buffer.from(pair.es)), `es not in ${p2}`);
  kb.getDb().pragma('wal_checkpoint(TRUNCATE)');
  assert.ok(!fs.readFileSync(tmpDb).includes(Buffer.from(pair.es)), 'es not in the database');
});

test('the web form carries the same fields; the default web origin is llm-ide.com', async () => {
  const { u, store } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'web', now: T, env: {} });
  assert.ok(qr.startsWith('https://llm-ide.com/#pair=sv%3D1%26'));
  const dev = createReferenceDevice({ tier: 'web', name: 'Laptop browser' });
  await dev.scanAndClaim(store, qr, { now: T });
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(await dev.readAck(store), p.sas);
  const { qr: dev2 } = await startEnrollment(u, { store, tier: 'web', now: T, env: { LLMIDE_SYNC_WEB_ORIGIN: 'http://localhost:5173' } });
  assert.ok(dev2.startsWith('http://localhost:5173/#pair='));
  const { qr: bad } = await startEnrollment(u, { store, tier: 'web', now: T, env: { LLMIDE_SYNC_WEB_ORIGIN: 'javascript:alert(1)' } });
  assert.ok(bad.startsWith('https://llm-ide.com/#pair='), 'a bad origin falls back to the default');
});

test('no claim within 120 s: expired, key.bin and the slot are removed, nothing registered', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  assert.ok(await store.get(`${sid}/d/${pair.dir}/key.bin`));
  const p = await pollEnrollment(u, { now: T + ENROLL.claimMs + 1 });
  assert.equal(p.phase, 'expired');
  assert.equal(await store.get(`${sid}/d/${pair.dir}/key.bin`), null);
  assert.equal(st.listSyncDevices(u).length, 0);
});

test('a confirm more than 120 s after the claim is refused', async () => {
  const { u, store } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, qr, { now: T });
  assert.equal((await pollEnrollment(u, { now: T + 1000 })).phase, 'confirm');
  await assert.rejects(confirmEnrollment(u, { now: T + 1000 + ENROLL.confirmMs + 1 }), (e) => e.code === 'ENROLL_FAILED');
  assert.equal(st.listSyncDevices(u).length, 0);
});

test('cancel and a new start both clean up the old slot; enrollment needs sync on', async () => {
  const { u, store, sid } = setup();
  const a = E.parsePair((await startEnrollment(u, { store, tier: 'ios', now: T })).qr);
  const b = E.parsePair((await startEnrollment(u, { store, tier: 'ios', now: T })).qr);
  assert.equal(await store.get(`${sid}/d/${a.dir}/key.bin`), null, 'the replaced slot is cleaned up');
  await cancelEnrollment(u);
  assert.equal(await store.get(`${sid}/d/${b.dir}/key.bin`), null);
  assert.equal((await pollEnrollment(u, { now: T })).phase, 'none');
  st.setSyncEnabled(u, false);
  await assert.rejects(startEnrollment(u, { store, tier: 'ios', now: T }), (e) => e.code === 'SYNC_OFF');
  await assert.rejects(startEnrollment(u, { store, tier: 'android', now: T }), (e) => e.code === 'VALIDATION_FAILED');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-enroll.test.mjs`
Expected: FAIL with `Cannot find module '../routes/sync/enroll.mjs'`.

- [ ] **Step 3: Extract `writeDeviceWrap` in `producer.mjs`**

Add `setDeviceWrapEpoch` is already imported; keep the imports. Add above `publishOnce`:

```js
/** key.bin + a signed syncwrap for one device at the current epoch (design 5.2 step 4; used by enrollment and publish). */
export async function writeDeviceWrap({ userId, store, state, keys, dev, now }) {
  const base = `${state.syncId}/d/${dev.dir}`;
  const ids = syncIdsFor(userId, state);
  await store.put(`${base}/key.bin`, keys.signingSpki);
  const dk = deviceKeys(keys.root, { ...ids, deviceId: dev.deviceId }, keys.epoch);
  const wrap = makeSyncWrap({ ids: { ...ids, deviceId: dev.deviceId }, epoch: keys.epoch, tier: dev.tier, deviceEcdhSpki: dev.ecdhSpki,
    desktopSigningSpki: keys.signingSpki, keys: dk, signingKey: keys.signingKey, seq: nextSeq(userId, now), issuedAt: now });
  await store.put(`${base}/wrap.bin`, envBytes(wrap));
  setDeviceWrapEpoch(userId, dev.deviceId, keys.epoch);
}
```

In `publishOnce`, replace the whole `if (dev.wrapEpoch !== keys.epoch) { … }` block with:

```js
    if (dev.wrapEpoch !== keys.epoch) await writeDeviceWrap({ userId, store, state, keys, dev, now });
```

Run: `cd extension && node --test tests/sync-producer.test.mjs` → PASS (no behaviour change).

- [ ] **Step 4: Write `extension/routes/sync/enroll.mjs`**

```js
// Desktop side of enrollment (design 5.2 as amended; schema/sync/v1/README.md "Enrollment"). One pending enrollment per
// user, in memory only: es never touches the database, the vault, a log or the store, and is zeroed when it ends. The
// claim is pinned the first time it is seen and never fetched again; the tier is the one the user picked here.
import { randomBytes } from 'node:crypto';
import { enrollKeys, newId22, openClaim, sealAck, sasCode, pairUrl } from '../../core/sync-enroll.mjs';
import { getSyncState, listSyncDevices, addSyncDevice, nextSeq } from '../../kb/sync-state.mjs';
import { ensureSyncKeys } from './keys.mjs';
import { writeDeviceWrap } from './producer.mjs';

export const ENROLL = Object.freeze({ claimMs: 120_000, confirmMs: 120_000, maxClaimBytes: 8192 });
const CLAIM_RE = /^[A-Za-z0-9_-]{22}\.bin$/;
const ACK = 'ack.bin';
const ORIGIN_RE = /^(https:\/\/[A-Za-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$/;
const pending = new Map(); // userId -> enrollment
const codeErr = (code) => Object.assign(new Error(code), { code });
const envBytes = (env) => Buffer.from(JSON.stringify(env));
const slotDir = (p) => `${p.pair.sid}/e/${p.pair.slot}`;
const webOrigin = (env) => (ORIGIN_RE.test(env.LLMIDE_SYNC_WEB_ORIGIN ?? '') ? env.LLMIDE_SYNC_WEB_ORIGIN : 'https://llm-ide.com');

function wipe(p) {
  p.es.fill(0); p.pair.es = '';
  for (const k of Object.values(p.keys)) k.fill(0);
  clearTimeout(p.timer);
}

async function kill(p, code) {
  if (p.phase !== 'waiting' && p.phase !== 'confirm') return;
  p.phase = code === 'expired' ? 'expired' : 'failed';
  p.code = code;
  wipe(p);
  await p.store.removeTree(slotDir(p)).catch(() => {});
  await p.store.removeTree(`${p.pair.sid}/d/${p.pair.dir}`).catch(() => {}); // never registered: confirm removes p first
}

const claimFiles = async (p) => (await p.store.list(slotDir(p))).filter((f) => f.name !== ACK);
const view = (p) => ({ phase: p?.phase ?? 'none', sas: p?.phase === 'confirm' ? p.sas : null, name: p?.claim?.name ?? null, tier: p?.tier ?? null, code: p?.code ?? null });

export function _resetEnrollmentsForTest() { for (const p of pending.values()) wipe(p); pending.clear(); }

export async function startEnrollment(userId, { store, tier, now = Date.now(), env = process.env }) {
  if (tier !== 'web' && tier !== 'ios') throw codeErr('VALIDATION_FAILED');
  const state = getSyncState(userId);
  if (!state?.enabled) throw codeErr('SYNC_OFF');
  const old = pending.get(userId);
  if (old) await kill(old, 'replaced');
  const keys = ensureSyncKeys(userId);
  const d = store.describe();
  const es = randomBytes(16);
  const pair = { sid: state.syncId, sfp: keys.fingerprint, dir: newId22(), slot: newId22(), es: es.toString('base64url'), st: `${d.kind}:${d.root}` };
  const p = { pair, es, keys: enrollKeys(es, pair.sid, pair.slot), tier, store, openedAt: now, phase: 'waiting', code: null, claim: null, claimAt: 0, sas: null, timer: null };
  pending.set(userId, p);
  const qr = pairUrl(pair, tier, webOrigin(env));
  try { await store.put(`${pair.sid}/d/${pair.dir}/key.bin`, keys.signingSpki); } catch (e) { await kill(p, 'store'); throw e; }
  p.timer = setTimeout(() => { void kill(p, 'expired'); }, ENROLL.claimMs + ENROLL.confirmMs + 5_000);
  p.timer.unref?.();
  return { qr, expiresAt: now + ENROLL.claimMs, tier };
}

async function take(userId, p, now) {
  if (now > p.openedAt + ENROLL.claimMs) return kill(p, 'expired');
  const files = await claimFiles(p);
  if (files.length === 0) return;
  if (files.length > 1) return kill(p, 'contested');
  const f = files[0];
  if (!CLAIM_RE.test(f.name) || f.size > ENROLL.maxClaimBytes) return kill(p, 'claim_invalid');
  let claim;
  try {
    const bytes = await p.store.get(`${slotDir(p)}/${f.name}`);
    if (!bytes || bytes.length > ENROLL.maxClaimBytes) throw codeErr('claim_invalid');
    claim = openClaim({ env: JSON.parse(Buffer.from(bytes).toString('utf8')), pair: p.pair, tier: p.tier, keys: p.keys });
  } catch { return kill(p, 'claim_invalid'); }
  if (listSyncDevices(userId).some((dev) => dev.deviceId === claim.deviceId)) return kill(p, 'claim_invalid');
  p.claim = { ...claim, file: f.name }; // pinned: never fetched again
  p.claimAt = now;
  const nD = randomBytes(16);
  const desk = ensureSyncKeys(userId);
  try {
    await p.store.put(`${slotDir(p)}/${ACK}`, envBytes(sealAck({ userId, pair: p.pair, tier: p.tier, claim, nD, keys: p.keys, signingKey: desk.signingKey, seq: nextSeq(userId, now), issuedAt: now })));
  } catch { return kill(p, 'store'); }
  p.sas = sasCode(p.keys.sas, { ...p.pair, tier: p.tier, ...claim, nD });
  nD.fill(0);
  p.phase = 'confirm';
}

export async function pollEnrollment(userId, { now = Date.now() } = {}) {
  const p = pending.get(userId);
  if (!p) return view(null);
  if (p.phase === 'waiting') await take(userId, p, now);
  else if (p.phase === 'confirm') {
    if (now > p.claimAt + ENROLL.confirmMs) await kill(p, 'expired');
    else if ((await claimFiles(p)).some((f) => f.name !== p.claim.file)) await kill(p, 'contested');
  }
  return view(p);
}

export async function confirmEnrollment(userId, { now = Date.now() } = {}) {
  const p = pending.get(userId);
  if (!p || p.phase !== 'confirm') throw codeErr('ENROLL_NOT_READY');
  if (now > p.claimAt + ENROLL.confirmMs) { await kill(p, 'expired'); throw codeErr('ENROLL_FAILED'); }
  if ((await claimFiles(p)).some((f) => f.name !== p.claim.file)) { await kill(p, 'contested'); throw codeErr('ENROLL_FAILED'); }
  const state = getSyncState(userId);
  if (!state?.enabled) throw codeErr('SYNC_OFF');
  const { deviceId, ecdhSpki, signingSpki, name } = p.claim;
  addSyncDevice(userId, { deviceId, dir: p.pair.dir, tier: p.tier, name, ecdhSpki, signingSpki, now });
  pending.delete(userId);
  p.phase = 'done';
  wipe(p);
  const dev = listSyncDevices(userId).find((x) => x.deviceId === deviceId);
  // A failed wrap write leaves wrapEpoch 0, so the next publish writes it (producer.mjs).
  await writeDeviceWrap({ userId, store: p.store, state, keys: ensureSyncKeys(userId), dev, now }).catch(() => {});
  await p.store.removeTree(slotDir(p)).catch(() => {});
  return { deviceId };
}

export async function cancelEnrollment(userId) {
  const p = pending.get(userId);
  pending.delete(userId);
  if (p) await kill(p, 'cancelled');
}
```

Note: `slotDir(p)` reads `p.pair.sid` and `p.pair.slot`, which `wipe` keeps. Only `p.pair.es` is cleared.

- [ ] **Step 5: Write the reference device `extension/tests/helpers/sync-device.mjs`**

```js
// Reference device for the sync v1 device contract (schema/sync/v1/README.md "Enrollment"; design 4.3-4.4). SP3
// (WebCrypto) and SP4 (Swift) implement these same steps; tests drive this one against the desktop. Node crypto only.
import { generateKeyPairSync } from 'node:crypto';
import * as S from '../../core/sync-envelope.mjs';
import * as E from '../../core/sync-enroll.mjs';

const spkiOf = (k) => k.publicKey.export({ type: 'spki', format: 'der' });
const J = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));
const failWith = (code) => { throw new S.SyncCryptoError(code); };

export function createReferenceDevice({ tier = 'ios', name = 'Test iPhone' } = {}) {
  const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const d = {
    tier, name, ecdhSpki: spkiOf(ecdh), signingSpki: spkiOf(sig), ecdhPrivate: ecdh.privateKey, signingKey: sig.privateKey,
    pair: null, keys: null, desktop: null, claimName: null, userId: null, epoch: 0, wrapKeys: null, prevReply: null, manifestSeq: 0,
  };
  d.deviceId = E.deviceIdOf(d.signingSpki);
  const base = () => `${d.pair.sid}/d/${d.pair.dir}`;
  const claim = () => ({ deviceId: d.deviceId, ecdhSpki: d.ecdhSpki, signingSpki: d.signingSpki, name: d.name });

  return Object.assign(d, {
    /** Contract 4a-4c: parse the QR, pin the desktop key by sfp, write the claim once. */
    async scanAndClaim(store, qr, { now = Date.now() } = {}) {
      d.pair = E.parsePair(qr);
      const spki = await store.get(`${base()}/key.bin`);
      if (!spki || S.spkiFingerprint(spki) !== d.pair.sfp) failWith('bad_desktop_key');
      d.desktop = { spki: Buffer.from(spki), verifyKey: E.p256Spki(spki) };
      d.keys = E.enrollKeys(Buffer.from(d.pair.es, 'base64url'), d.pair.sid, d.pair.slot);
      d.claimName ??= E.newId22();
      const env = E.sealClaim({ pair: d.pair, tier, name, ecdhSpki: d.ecdhSpki, signingSpki: d.signingSpki, signingKey: d.signingKey, issuedAt: now });
      await store.put(`${d.pair.sid}/e/${d.pair.slot}/${d.claimName}.bin`, Buffer.from(JSON.stringify(env)));
    },
    /** Contract 4d: the SAS to show, null while there is no ack; throws on a forged ack or one for another claim. */
    async readAck(store) {
      const bytes = await store.get(`${d.pair.sid}/e/${d.pair.slot}/ack.bin`);
      if (!bytes) return null;
      const { userId, nD } = E.openAck({ env: J(bytes), pair: d.pair, tier, claim: claim(), keys: d.keys, desktopVerifyKey: d.desktop.verifyKey });
      d.userId = userId;
      return E.sasCode(d.keys.sas, { ...d.pair, tier, ...claim(), nD });
    },
    /** Contract 4e and 5: unwrap wrap.bin when it is for a newer epoch. false = nothing newer yet. */
    async readWrap(store) {
      const bytes = await store.get(`${base()}/wrap.bin`);
      if (!bytes) return false;
      const env = J(bytes);
      if (env.tier !== tier || env.from !== d.pair.sid || env.desktopId !== d.pair.sid || env.userId !== d.userId) failWith('bad_wrap');
      if (!(env.epoch > d.epoch)) return false;
      const keys = S.unwrapSync({ env, ecdhPrivate: d.ecdhPrivate, deviceEcdhSpki: d.ecdhSpki, desktopSigningSpki: d.desktop.spki,
        verifyKey: d.desktop.verifyKey, currentEpoch: d.epoch, deviceId: d.deviceId });
      if (d.wrapKeys) d.prevReply = { epoch: d.epoch, key: d.wrapKeys.reply };
      d.wrapKeys = keys;
      d.epoch = env.epoch;
      if (d.keys) { for (const k of Object.values(d.keys)) k.fill(0); d.keys = null; d.pair.es = ''; } // enrollment is over
      return true;
    },
    /** Design 4.3: manifest (rollback-checked), then each named blob by its SHA-256, then the envelope. */
    async readSnapshot(store) {
      const raw = await store.get(`${base()}/manifest.bin`);
      if (!raw) failWith('removed');
      const env = J(raw);
      if (env.epoch > d.epoch && !(await d.readWrap(store))) failWith('bad_epoch');
      const m = JSON.parse(S.open({ env, key: d.wrapKeys.manifest, verifyKey: d.desktop.verifyKey,
        expect: { purpose: 'manifest', userId: d.userId, desktopId: d.pair.sid, from: d.pair.sid, to: d.deviceId, epoch: d.epoch } }));
      if (m.manifestSeq < d.manifestSeq) failWith('rollback');
      d.manifestSeq = m.manifestSeq;
      const kinds = {};
      for (const [kind, e] of Object.entries(m.kinds)) {
        const bytes = await store.get(`${base()}/${e.file}`);
        if (!bytes || S.sha256(bytes).toString('hex') !== e.sha256) failWith('bad_blob');
        kinds[kind] = JSON.parse(S.open({ env: J(bytes), key: d.wrapKeys.snapshot, verifyKey: d.desktop.verifyKey,
          expect: { purpose: 'snapshot', desktopId: d.pair.sid, to: d.deviceId, epoch: d.epoch } }));
      }
      return { manifest: m, kinds };
    },
    async sendRequest(store, text, { now = Date.now(), epoch = d.epoch, key = d.wrapKeys.request } = {}) {
      const requestId = E.newId22();
      const env = S.seal({ header: { purpose: 'request', userId: d.userId, desktopId: d.pair.sid, from: d.deviceId, to: d.pair.sid, epoch, session: '', seq: 1, issuedAt: now, tier: '' },
        key, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId, class: 'chat.send', text })), signingKey: d.signingKey });
      await store.put(`${base()}/in/${String(now).padStart(13, '0')}-${requestId}.bin`, Buffer.from(JSON.stringify(env)));
      return requestId;
    },
    async readReply(store, requestId) {
      const bytes = await store.get(`${base()}/out/${requestId}.bin`);
      if (!bytes) return null;
      const env = J(bytes);
      const key = env.epoch === d.epoch ? d.wrapKeys.reply : env.epoch === d.prevReply?.epoch ? d.prevReply.key : null;
      if (!key) failWith('bad_epoch');
      return JSON.parse(S.open({ env, key, verifyKey: d.desktop.verifyKey, expect: { purpose: 'reply', desktopId: d.pair.sid, from: d.pair.sid, to: d.deviceId } }));
    },
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `cd extension && node --test tests/sync-enroll.test.mjs tests/sync-producer.test.mjs tests/sync-consumer.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/routes/sync/enroll.mjs extension/routes/sync/producer.mjs extension/tests/helpers/sync-device.mjs extension/tests/sync-enroll.test.mjs
git commit -m "feat(sync): desktop enrollment with pinned claim and signed ack

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Malicious-storage test suite

**Files:**
- Create: `extension/tests/helpers/tamper-store.mjs`
- Test: `extension/tests/sync-enroll-malicious.test.mjs`
- Modify (only if a case fails): `extension/routes/sync/enroll.mjs`, `extension/core/sync-enroll.mjs`

**Interfaces:**
- Consumes: Task 1 and Task 2 (exact names above).
- Produces: `createTamperStore()` → a `SyncStore` with mutable hooks `onGet(path, bytes) → bytes|null`, `onList(dir, items) → items`, plus `inner` (the memory store) and `gets` (a `Map<path, count>`).

- [ ] **Step 1: Write the helper**

```js
// A storage provider that can read and rewrite anything (design 13, "malicious store"): wraps the memory store; a test
// substitutes, drops or replays any file on get and list, and can count reads.
import { createMemoryStore } from '../../connectors/sync-store/index.mjs';

export function createTamperStore() {
  const inner = createMemoryStore();
  const s = {
    inner, gets: new Map(), onGet: null, onList: null,
    async put(path, bytes) { await inner.put(path, bytes); },
    async get(path) { s.gets.set(path, (s.gets.get(path) ?? 0) + 1); const b = await inner.get(path); return s.onGet ? s.onGet(path, b) : b; },
    async list(dir) { const l = await inner.list(dir); return s.onList ? s.onList(dir, l) : l; },
    remove: (p) => inner.remove(p), removeTree: (d) => inner.removeTree(d), describe: () => inner.describe(), dump: () => inner.dump(),
  };
  return s;
}
```

- [ ] **Step 2: Write the failing tests**

Create `extension/tests/sync-enroll-malicious.test.mjs`. It has the same env and DB preamble as `tests/sync-enroll.test.mjs`, with DB file `_sync-enroll-malicious-test.db`, the same `user()`/`setup()` helpers (but `store: createTamperStore()`), and the same imports, plus:

```js
const { createTamperStore } = await import('./helpers/tamper-store.mjs');
const S = await import('../core/sync-envelope.mjs');
const { generateKeyPairSync } = await import('node:crypto');
const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' });
const J = (b) => JSON.parse(Buffer.from(b).toString('utf8'));
const B = (o) => Buffer.from(JSON.stringify(o));
// An attacker who photographed the QR knows es; it builds a valid claim for its own keys.
function attackerClaim(qr, { tier = 'ios', name = 'My iPhone' } = {}) {
  const pair = E.parsePair(qr);
  const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return B(E.sealClaim({ pair, tier, name, ecdhSpki: spki(ecdh), signingSpki: spki(sig), signingKey: sig.privateKey, issuedAt: T }));
}
const registryEmpty = (u) => assert.equal(st.listSyncDevices(u).length, 0, 'nothing enters the registry');
```

Test cases. Each test ends with `registryEmpty(u)` unless stated:

```js
test('storage swaps key.bin for its own key: the device refuses before claiming', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const evil = spki(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }));
  store.onGet = (p, b) => (p.endsWith('/key.bin') ? evil : b);
  const dev = createReferenceDevice();
  await assert.rejects(dev.scanAndClaim(store, qr, { now: T }), (e) => e.code === 'bad_desktop_key');
  assert.deepEqual(await store.list(`${sid}/e/${E.parsePair(qr).slot}`), [], 'no claim was written');
  registryEmpty(u);
});

test('storage forges a claim without es: claim_invalid, slot and folder removed', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  const guessed = qr.replace(`es=${pair.es}`, `es=${E.newId22()}`);
  await store.put(`${sid}/e/${pair.slot}/${E.newId22()}.bin`, attackerClaim(guessed));
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'failed'); assert.equal(p.code, 'claim_invalid'); assert.equal(p.sas, null);
  assert.deepEqual(await store.list(`${sid}/d/${pair.dir}`), []);
  registryEmpty(u);
});

test('storage replays a valid claim from an earlier enrollment into a new slot: claim_invalid', async () => {
  const { u, store, sid } = setup();
  const first = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, first.qr, { now: T });
  const old = await store.inner.get(`${sid}/e/${E.parsePair(first.qr).slot}/${dev.claimName}.bin`);
  await cancelEnrollment(u);
  const second = await startEnrollment(u, { store, tier: 'ios', now: T });
  await store.put(`${sid}/e/${E.parsePair(second.qr).slot}/${dev.claimName}.bin`, old);
  assert.equal((await pollEnrollment(u, { now: T + 1000 })).code, 'claim_invalid');
  registryEmpty(u);
});

test('QR photographer with storage control swaps the real claim: the real device never shows a code', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, qr, { now: T });
  await store.inner.remove(`${sid}/e/${pair.slot}/${dev.claimName}.bin`); // storage deletes the real claim
  await store.put(`${sid}/e/${pair.slot}/${E.newId22()}.bin`, attackerClaim(qr));
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'confirm', 'the desktop pins the only claim it sees');
  // The ack is addressed to the attacker's deviceId (bad_to) and bound to its claim (ack_mismatch): either way, refused.
  await assert.rejects(dev.readAck(store), (e) => e.code === 'bad_to' || e.code === 'ack_mismatch', 'the ack is bound to the pinned claim, not the phone');
  // The SAS the phone would compute for itself differs from the desktop's (collision chance 1e-6).
  const ack = J(await store.inner.get(`${sid}/e/${pair.slot}/ack.bin`));
  const keys = E.enrollKeys(Buffer.from(pair.es, 'base64url'), pair.sid, pair.slot);
  const [nD] = S.decodeEnc(S.open({ env: ack, key: keys.enrollack, verifyKey: E.p256Spki(await store.inner.get(`${sid}/d/${pair.dir}/key.bin`)) }), 2);
  const phoneSas = E.sasCode(keys.sas, { ...pair, tier: 'ios', deviceId: dev.deviceId, ecdhSpki: dev.ecdhSpki, signingSpki: dev.signingSpki, name: dev.name, nD });
  assert.notEqual(phoneSas, p.sas);
  await cancelEnrollment(u); // the user sees no code on the phone and cancels
  registryEmpty(u);
});

test('a second claim (race) kills the slot before and after the pin', async () => {
  for (const when of ['before', 'after']) {
    const { u, store, sid } = setup();
    const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
    const pair = E.parsePair(qr);
    const dev = createReferenceDevice();
    await dev.scanAndClaim(store, qr, { now: T });
    if (when === 'after') assert.equal((await pollEnrollment(u, { now: T + 500 })).phase, 'confirm');
    await store.put(`${sid}/e/${pair.slot}/${E.newId22()}.bin`, attackerClaim(qr));
    if (when === 'after') await assert.rejects(confirmEnrollment(u, { now: T + 1000 }), (e) => e.code === 'ENROLL_FAILED');
    const p = await pollEnrollment(u, { now: T + 1000 });
    assert.equal(p.code, 'contested', when);
    registryEmpty(u);
  }
});

test('storage rewrites the claim after the pin: confirm registers the pinned keys and never re-reads the claim', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, qr, { now: T });
  const claimPath = `${sid}/e/${pair.slot}/${dev.claimName}.bin`;
  await pollEnrollment(u, { now: T + 500 });
  const evil = attackerClaim(qr);
  store.onGet = (p, b) => (p === claimPath ? evil : b);
  await confirmEnrollment(u, { now: T + 1000 });
  assert.equal(store.gets.get(claimPath), 1, 'the claim was fetched exactly once');
  const [row] = st.listSyncDevices(u);
  assert.ok(row.signingSpki.equals(dev.signingSpki) && row.ecdhSpki.equals(dev.ecdhSpki));
});

test('storage forges or replays ack.bin: the device refuses', async () => {
  const { u, store, sid } = setup();
  const first = await startEnrollment(u, { store, tier: 'ios', now: T });
  const a = createReferenceDevice();
  await a.scanAndClaim(store, first.qr, { now: T });
  await pollEnrollment(u, { now: T + 500 });
  const oldAck = await store.inner.get(`${sid}/e/${E.parsePair(first.qr).slot}/ack.bin`);
  await cancelEnrollment(u);
  const second = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(second.qr);
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, second.qr, { now: T });
  await store.put(`${sid}/e/${pair.slot}/ack.bin`, oldAck); // replay before the desktop writes its own
  await assert.rejects(dev.readAck(store), (e) => e instanceof S.SyncCryptoError);
  const evilSig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keys = E.enrollKeys(Buffer.from(pair.es, 'base64url'), pair.sid, pair.slot);
  const forged = E.sealAck({ userId: 'x', pair, tier: 'ios', claim: { deviceId: dev.deviceId, ecdhSpki: dev.ecdhSpki, signingSpki: dev.signingSpki, name: dev.name },
    nD: Buffer.alloc(16, 1), keys, signingKey: evilSig.privateKey, seq: 1, issuedAt: T });
  await store.put(`${sid}/e/${pair.slot}/ack.bin`, B(forged)); // even with es, storage lacks the desktop key
  await assert.rejects(dev.readAck(store), (e) => e.code === 'bad_signature');
  await cancelEnrollment(u);
  registryEmpty(u);
});

test('storage swaps wrap.bin (forged, or another device's): the device takes no keys', async () => {
  const { u, store, sid } = setup();
  const enroll = async (name) => {
    const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
    const dev = createReferenceDevice({ name });
    await dev.scanAndClaim(store, qr, { now: T });
    await pollEnrollment(u, { now: T + 500 });
    await dev.readAck(store);
    await confirmEnrollment(u, { now: T + 1000 });
    return dev;
  };
  const a = await enroll('A');
  const b = await enroll('B');
  const aWrap = await store.inner.get(`${sid}/d/${a.pair.dir}/wrap.bin`);
  store.onGet = (p, x) => (p === `${sid}/d/${b.pair.dir}/wrap.bin` ? aWrap : x);
  await assert.rejects(b.readWrap(store), (e) => e instanceof S.SyncCryptoError, 'A\'s wrap is not for B');
  const evilSig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const real = J(await store.inner.get(`${sid}/d/${b.pair.dir}/wrap.bin`));
  const forged = S.makeSyncWrap({ ids: { userId: real.userId, desktopId: sid, deviceId: b.deviceId }, epoch: real.epoch + 5, tier: 'ios', deviceEcdhSpki: b.ecdhSpki,
    desktopSigningSpki: b.desktop.spki, keys: { request: Buffer.alloc(32), reply: Buffer.alloc(32), snapshot: Buffer.alloc(32), manifest: Buffer.alloc(32) },
    signingKey: evilSig.privateKey, seq: 1, issuedAt: T });
  store.onGet = (p, x) => (p === `${sid}/d/${b.pair.dir}/wrap.bin` ? B(forged) : x);
  await assert.rejects(b.readWrap(store), (e) => e.code === 'bad_signature');
  assert.equal(b.wrapKeys, null);
});

test('tier is the desktop\'s: a browser answering an iPhone slot is refused; storage cannot edit the ack tier', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice({ tier: 'web' });
  await dev.scanAndClaim(store, qr, { now: T });
  assert.equal((await pollEnrollment(u, { now: T + 500 })).code, 'claim_invalid');
  registryEmpty(u);
  const second = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(second.qr);
  const ok = createReferenceDevice({ tier: 'ios' });
  await ok.scanAndClaim(store, second.qr, { now: T });
  await pollEnrollment(u, { now: T + 500 });
  const ack = J(await store.inner.get(`${sid}/e/${pair.slot}/ack.bin`));
  store.onGet = (p, x) => (p.endsWith('/ack.bin') ? B({ ...ack, tier: 'web' }) : x);
  await assert.rejects(ok.readAck(store), (e) => e instanceof S.SyncCryptoError);
  await cancelEnrollment(u);
  registryEmpty(u);
});

test('storage hides the claim until the window closes: expired, nothing registered', async () => {
  const { u, store } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  store.onList = (dir, l) => (dir.includes('/e/') ? [] : l);
  await createReferenceDevice().scanAndClaim(store, qr, { now: T });
  assert.equal((await pollEnrollment(u, { now: T + ENROLL.claimMs + 1 })).phase, 'expired');
  registryEmpty(u);
});
```

- [ ] **Step 3: Run the tests**

Run: `cd extension && node --test tests/sync-enroll-malicious.test.mjs`
Expected: PASS. If a case fails, it is a real hole. Fix it in `routes/sync/enroll.mjs` or `core/sync-enroll.mjs` (never by weakening the test), re-run Task 1 and 2 tests, and say in the commit body what the fix was.

- [ ] **Step 4: Commit**

```bash
git add extension/tests/helpers/tamper-store.mjs extension/tests/sync-enroll-malicious.test.mjs
git commit -m "test(sync): malicious storage at every enrollment step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Key rotation and `stale_epoch` replies

**Files:**
- Modify: `extension/server/vault.mjs` (`ALLOWED_KEYS` list near line 145, `INTERNAL_KEYS` at line 210)
- Modify: `extension/routes/sync/keys.mjs`
- Modify: `extension/routes/sync/scheduler.mjs` (`syncCycle`, new `rotateNow`, `rotationPending`)
- Modify: `extension/routes/sync/consumer.mjs` (`drainOnce`)
- Test: `extension/tests/sync-rotate.test.mjs`

**Interfaces:**
- Consumes: `getSecret`/`setSecret` (vault), `setEpoch`, `getSyncState` (kb), `publishOnce` (producer), `withUserLock` (scheduler), the reference device (Task 2).
- Produces:
  - `PREV_KEY_MS = 86_400_000`, `rotateKeys(userId, now?): number` (returns the new epoch, durable and transactional), `previousRoot(userId, now?): { epoch, root: Buffer } | null` (keys.mjs)
  - `rotateNow(userId, { store?, now? }): Promise<'done'|'pending'>`, `rotationPending(userId): boolean` (scheduler.mjs)
  - `drainOnce` answers an old-epoch request (within 24 h) with `{ ok:false, code:'stale_epoch' }` sealed under the **old** reply key with header epoch = old epoch; it runs no turn and records the request once.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/sync-rotate.test.mjs`. It has the same preamble as `tests/sync-enroll.test.mjs`, with DB `_sync-rotate-test.db` and the same `setup()`/`kinds()`, plus an `enrolled()` helper:

```js
const { rotateKeys, previousRoot, PREV_KEY_MS, ensureSyncKeys } = await import('../routes/sync/keys.mjs');
const { rotateNow, rotationPending, withUserLock, syncCycle } = await import('../routes/sync/scheduler.mjs');
const { drainOnce } = await import('../routes/sync/consumer.mjs');
const vault = await import('../server/vault.mjs');
async function enrolled(u, store, name = 'Phone') {
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice({ name });
  await dev.scanAndClaim(store, qr, { now: T });
  await pollEnrollment(u, { now: T + 1 });
  await dev.readAck(store);
  await confirmEnrollment(u, { now: T + 2 });
  await dev.readWrap(store);
  return dev;
}
const noTurn = { phoneChatId: async () => 'c', cancel: () => {}, turn: async () => { throw new Error('no turn may run'); } };

test('rotateKeys: epoch + 1, new root, previous root kept 24 h, never a client-visible vault key', () => {
  const { u } = setup();
  ensureSyncKeys(u); // creates sync.rootKey
  const before = st.getSyncState(u).epoch;
  const oldRoot = vault.getSecret(kb.getDb(), u, 'sync.rootKey');
  assert.equal(rotateKeys(u, T), before + 1);
  assert.equal(st.getSyncState(u).epoch, before + 1);
  assert.notEqual(vault.getSecret(kb.getDb(), u, 'sync.rootKey'), oldRoot);
  const prev = previousRoot(u, T + 1);
  assert.equal(prev.epoch, before); assert.equal(prev.root.toString('base64url'), oldRoot);
  assert.equal(previousRoot(u, T + PREV_KEY_MS + 1), null);
  assert.ok(!vault.listSecretKeys(kb.getDb(), u).some((r) => r.secret_key === 'sync.prevRootKey'));
});

test('rotateNow: every device gets a new wrap, a full republish, old blobs deleted; the device follows', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  const oldBlobs = (await store.list(`${sid}/d/${a.pair.dir}/s`)).map((f) => f.name).sort();
  const e0 = a.epoch;
  // loadKinds is the producer default here; inject it by publishing first, then rotate with the same data.
  assert.equal(await rotateNow(u, { store, now: T + 20 }), 'done');
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  await publishOnce({ userId: u, store, now: T + 30, loadKinds: kinds });
  const snap = await a.readSnapshot(store);
  assert.equal(a.epoch, e0 + 1, 'the device unwrapped the new epoch from the manifest hint');
  assert.equal(snap.manifest.epoch, e0 + 1);
  const newBlobs = (await store.list(`${sid}/d/${a.pair.dir}/s`)).map((f) => f.name);
  assert.ok(newBlobs.every((x) => !oldBlobs.includes(x)), 'old-epoch blobs are gone');
});

test('a busy lock makes rotation pending; the next cycle runs it', async () => {
  const { u, store } = setup();
  await enrolled(u, store);
  const e0 = st.getSyncState(u).epoch;
  let release;
  const held = withUserLock(u, () => new Promise((r) => { release = r; }));
  assert.equal(await rotateNow(u, { store, now: T }), 'pending');
  assert.equal(rotationPending(u), true);
  release(); await held;
  await syncCycle(u, { now: T + 5, produce: false, store });
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  assert.equal(rotationPending(u), false);
});

test('an old-epoch request within 24 h gets stale_epoch under the old reply key; after 24 h it is refused', async () => {
  const { u, store, sid } = setup();
  const dev = await enrolled(u, store);
  const oldEpoch = dev.epoch; const oldRequest = dev.wrapKeys.request;
  await rotateNow(u, { store, now: T + 10 });
  const id = await dev.sendRequest(store, 'hello', { now: T + 20, epoch: oldEpoch, key: oldRequest });
  const out = await drainOnce({ userId: u, store, now: T + 30, deps: noTurn });
  assert.equal(out.ran, 0);
  assert.deepEqual(await dev.readReply(store, id), { v: 1, requestId: id, ok: false, code: 'stale_epoch' });
  const again = await dev.sendRequest(store, 'late', { now: T + PREV_KEY_MS + 20, epoch: oldEpoch, key: oldRequest });
  const late = await drainOnce({ userId: u, store, now: T + PREV_KEY_MS + 30, deps: noTurn });
  assert.equal(late.refused, 1);
  assert.equal(await store.get(`${sid}/d/${dev.pair.dir}/out/${again}.bin`), null);
});
```

Note on the `rotateNow` test: `rotateNow` calls `publishOnce` with the default `loadKinds`, which reads the real (empty) DB for this user. That is fine; the explicit `publishOnce(... loadKinds: kinds)` afterwards makes the device's view deterministic.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-rotate.test.mjs`
Expected: FAIL with `rotateKeys is not a function` (SyntaxError on the missing export).

- [ ] **Step 3: Vault key**

In `extension/server/vault.mjs` add `'sync.prevRootKey',` after `'sync.megaPassword',` in the allowed list (line ~148). Add `'sync.prevRootKey'` to the `INTERNAL_KEYS` set at line 210.

- [ ] **Step 4: `keys.mjs`**

Change the imports to add `setEpoch`:

```js
import { getSyncState, setEpoch } from '../../kb/sync-state.mjs';
```

Append:

```js
export const PREV_KEY_MS = 86_400_000;

/** Design 5.3 rotate: new K_root, epoch + 1. The previous root is kept 24 h only to answer old-epoch requests with
 *  stale_epoch. The caller holds the per-user lock and republishes (wraps are rewritten because wrapEpoch != epoch). */
export function rotateKeys(userId, now = Date.now()) {
  const db = getDb();
  const state = getSyncState(userId);
  if (!state) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  const old = getSecret(db, userId, 'sync.rootKey');
  db.transaction(() => {
    if (old) setSecret(db, userId, 'sync.prevRootKey', JSON.stringify({ epoch: state.epoch, key: old, until: now + PREV_KEY_MS }));
    setSecret(db, userId, 'sync.rootKey', randomBytes(32).toString('base64url'));
    setEpoch(userId, state.epoch + 1);
  })();
  return state.epoch + 1;
}

export function previousRoot(userId, now = Date.now()) {
  const raw = getSecret(getDb(), userId, 'sync.prevRootKey');
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return Number.isSafeInteger(p.epoch) && p.until > now ? { epoch: p.epoch, root: Buffer.from(p.key, 'base64url') } : null;
  } catch { return null; }
}
```

- [ ] **Step 5: Scheduler**

In `scheduler.mjs` add `import { rotateKeys } from './keys.mjs';`, add `const rotateDue = new Set(); // users whose rotation waits for the lock` next to `busy`, and add:

```js
export const rotationPending = (userId) => rotateDue.has(userId);

/** Rotate now under the per-user lock, or mark it pending for the next cycle when a cycle holds the lock. */
export async function rotateNow(userId, { store = storeFor(userId), now = Date.now() } = {}) {
  try {
    return await withUserLock(userId, async () => {
      rotateDue.delete(userId);
      rotateKeys(userId, now);
      if (store) await publishOnce({ userId, store, now });
      return 'done';
    });
  } catch (e) {
    if (e?.code !== 'SYNC_BUSY') throw e;
    rotateDue.add(userId);
    return 'pending';
  }
}
```

Replace `syncCycle` with:

```js
export async function syncCycle(userId, { now = Date.now(), produce = true, store = storeFor(userId) } = {}) {
  if (!store) throw Object.assign(new Error('Sync is not set up'), { code: 'SYNC_NOT_SET_UP' });
  let doPublish = produce;
  if (rotateDue.delete(userId)) { rotateKeys(userId, now); doPublish = true; }
  const publish = doPublish ? await publishOnce({ userId, store, now }) : null;
  const drain = await drainOnce({ userId, store, now });
  return { publish, drain };
}
```

`syncCycle` is called by the tick with `busy` already held (see `tick`), and the test calls it directly with no lock held. Both are fine.

- [ ] **Step 6: Consumer `stale_epoch`**

In `consumer.mjs`, change the keys import to `import { ensureSyncKeys, previousRoot } from './keys.mjs';`. In `drainOnce`, after `const keys = ensureSyncKeys(userId);`, add `const prev = previousRoot(userId, now);`. Inside the device loop, after `const dk = …`, add:

```js
    const prevDk = prev && deviceKeys(prev.root, { userId, desktopId: state.syncId, deviceId: dev.deviceId }, prev.epoch);
```

Change `writeReply` so it can seal under the old epoch:

```js
    const writeReply = async (requestId, body, { key = dk.reply, epoch = keys.epoch } = {}) => {
      const env = seal({ header: { purpose: 'reply', userId, desktopId: state.syncId, from: state.syncId, to: dev.deviceId, epoch, session: '', seq: nextSeq(userId, now), issuedAt: now, tier: '' },
        key, plaintext: Buffer.from(JSON.stringify({ v: 1, requestId, ...body })), signingKey: keys.signingKey });
      await store.put(`${base}/out/${requestId}.bin`, Buffer.from(JSON.stringify(env)));
      out.replied += 1;
    };
```

Replace the parse/open block (`let env; let req = null; try { … } catch { req = null; }`) with:

```js
      let env; let req = null; let stale = false;
      try {
        env = JSON.parse(Buffer.from(bytes).toString('utf8'));
        stale = !!prevDk && env?.epoch === prev.epoch;
        req = parseRequest(open({ env, key: stale ? prevDk.request : dk.request, verifyKey,
          expect: { purpose: 'request', userId, desktopId: state.syncId, from: dev.deviceId, to: state.syncId, epoch: stale ? prev.epoch : keys.epoch } }));
      } catch { req = null; }
```

After `taken += 1;` add:

```js
      if (stale) { await writeReply(req.requestId, { ok: false, code: 'stale_epoch' }, { key: prevDk.reply, epoch: prev.epoch }); finishRequest(userId, dev.deviceId, req.requestId, 'failed'); continue; }
```

- [ ] **Step 7: Run the tests**

Run: `cd extension && node --test tests/sync-rotate.test.mjs tests/sync-consumer.test.mjs tests/sync-routes.test.mjs tests/sync-state.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add extension/server/vault.mjs extension/routes/sync/keys.mjs extension/routes/sync/scheduler.mjs extension/routes/sync/consumer.mjs extension/tests/sync-rotate.test.mjs
git commit -m "feat(sync): key rotation with stale_epoch replies for 24 hours

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Device registry: revoke, desktop-off revoke, no folder recreation

**Files:**
- Modify: `extension/kb/sync-state.mjs` (add `deleteSyncDevice`)
- Modify: `extension/kb/activity.mjs:12-24` (add kind `sync_device_removed`)
- Create: `extension/routes/sync/registry.mjs`
- Modify: `extension/routes/sync/producer.mjs` (top of `publishOnce`)
- Modify: `extension/routes/sync/consumer.mjs` (`writeReply` guard)
- Test: `extension/tests/sync-registry.test.mjs`

**Interfaces:**
- Consumes: Task 4 `rotateKeys`; `recordActivity` (`kb/activity.mjs`); `listSyncDevices` (kb).
- Produces:
  - `deleteSyncDevice(userId, deviceId): boolean` (kb; transaction: the device row + its `sync_published` rows)
  - `folderPresent(store, base): Promise<boolean>` (true when `key.bin` is listed in `base`)
  - `revokeDevice(userId, deviceId, { store }): Promise<boolean>` (false = unknown device; `removeTree` first, then the registry row; the caller rotates)
  - `pruneMissingDevices(userId, { store }): Promise<{ dropped: string[] }>` (names of the dropped devices)
  - `publishOnce` prunes first, and rotates when anything was dropped. `writeReply` skips a device whose folder is gone.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/sync-registry.test.mjs`. It has the same preamble, `setup()`, `kinds()` and `enrolled()` as `tests/sync-rotate.test.mjs`, with DB `_sync-registry-test.db`, plus:

```js
const { revokeDevice, pruneMissingDevices } = await import('../routes/sync/registry.mjs');
const { rotateNow } = await import('../routes/sync/scheduler.mjs');
const { drainOnce } = await import('../routes/sync/consumer.mjs');
const { listActivity } = await import('../kb/activity.mjs');
const under = (store, prefix) => [...store.dump().keys()].filter((p) => p.startsWith(prefix));

test('revoke from Settings: folder gone, row gone, epoch rotated, the other device keeps reading', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  const b = await enrolled(u, store, 'B');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  const e0 = st.getSyncState(u).epoch;
  assert.equal(await revokeDevice(u, a.deviceId, { store }), true);
  await rotateNow(u, { store, now: T + 20 });
  assert.deepEqual(under(store, `${sid}/d/${a.pair.dir}/`), []);
  assert.deepEqual(st.listSyncDevices(u).map((d) => d.name), ['B']);
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  await publishOnce({ userId: u, store, now: T + 30, loadKinds: kinds });
  assert.equal((await b.readSnapshot(store)).manifest.epoch, e0 + 1);
  assert.equal(await revokeDevice(u, a.deviceId, { store }), false, 'unknown device');
});

test('revoked device: a request it plants in a recreated folder is never read', async () => {
  const { u, store } = setup();
  const a = await enrolled(u, store, 'A');
  await revokeDevice(u, a.deviceId, { store });
  await a.sendRequest(store, 'still here?', { now: T + 40 });
  const out = await drainOnce({ userId: u, store, now: T + 50, deps: { phoneChatId: async () => 'c', cancel: () => {}, turn: async () => { throw new Error('no'); } } });
  assert.deepEqual(out, { ran: 0, refused: 0, replied: 0 });
});

test('desktop-off revoke: a deleted folder drops the device, rotates, records a notice, and is never recreated', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'Lost phone');
  const b = await enrolled(u, store, 'B');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  const e0 = st.getSyncState(u).epoch;
  await store.removeTree(`${sid}/d/${a.pair.dir}`); // the user deletes it in the MEGA web app
  await publishOnce({ userId: u, store, now: T + 20, loadKinds: kinds });
  assert.deepEqual(st.listSyncDevices(u).map((d) => d.name), ['B']);
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  assert.deepEqual(under(store, `${sid}/d/${a.pair.dir}/`), [], 'never recreated');
  assert.ok(listActivity(u, {}).some((r) => r.kind === 'sync_device_removed' && r.title.includes('Lost phone')));
  assert.equal((await b.readSnapshot(store)).manifest.epoch, e0 + 1);
});

test('a reset location (wrapEpoch 0, SP1 store change) is republished, not pruned', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  st.resetSyncPublish(u);
  const fresh = (await import('../connectors/sync-store/index.mjs')).createMemoryStore();
  assert.deepEqual(await pruneMissingDevices(u, { store: fresh }), { dropped: [] });
  await publishOnce({ userId: u, store: fresh, now: T + 10, loadKinds: kinds });
  assert.ok(await fresh.get(`${sid}/d/${a.pair.dir}/wrap.bin`));
  assert.equal(st.listSyncDevices(u).length, 1);
});

test('a folder deleted during a turn gets no reply written into it', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  await a.sendRequest(store, 'hi', { now: T + 20 });
  const deps = { phoneChatId: async () => 'c', cancel: () => {},
    turn: async (args) => { await store.removeTree(`${sid}/d/${a.pair.dir}`); args.onEvent({ type: 'delta', text: 'answer' }); } };
  await drainOnce({ userId: u, store, now: T + 30, deps });
  assert.deepEqual(under(store, `${sid}/d/${a.pair.dir}/`), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/sync-registry.test.mjs`
Expected: FAIL with `Cannot find module '../routes/sync/registry.mjs'`.

- [ ] **Step 3: kb helpers**

Append to `extension/kb/sync-state.mjs`:

```js
/** Revoke (design 5.3): the device row and its published-blob records go together; its request history stays. */
export function deleteSyncDevice(userId, deviceId) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    db.prepare('DELETE FROM sync_published WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
    return db.prepare('DELETE FROM sync_devices WHERE user_id = ? AND device_id = ?').run(userId, deviceId).changes === 1;
  })();
}
```

In `extension/kb/activity.mjs` add `'sync_device_removed',` after `'model_fallback',` in `ACTIVITY_KINDS`. The Mac's `ActivityKind` decodes an unknown kind as nil (`mac/Sources/LlmIdeMac/Core/Platform/ActivityStore.swift:27-28`), so no Mac change is needed.

- [ ] **Step 4: `extension/routes/sync/registry.mjs`**

```js
// The desktop's local device registry is the only registry (design 5.2 step 4). Revoke = delete the device folder, then
// the row (the caller rotates). A registered device whose wrap was written at this location (wrapEpoch > 0) and whose
// folder has no key.bin was deleted on the storage with the desktop off (spec Q10): drop it, say so, never recreate it.
import { getSyncState, listSyncDevices, deleteSyncDevice } from '../../kb/sync-state.mjs';
import { recordActivity } from '../../kb/activity.mjs';

export const folderPresent = async (store, base) => (await store.list(base)).some((f) => f.name === 'key.bin');

export async function revokeDevice(userId, deviceId, { store }) {
  const state = getSyncState(userId);
  const dev = state && listSyncDevices(userId).find((d) => d.deviceId === deviceId);
  if (!dev) return false;
  if (store) await store.removeTree(`${state.syncId}/d/${dev.dir}`); // a failure leaves the row: the user can retry
  return deleteSyncDevice(userId, deviceId);
}

export async function pruneMissingDevices(userId, { store }) {
  const state = getSyncState(userId);
  const dropped = [];
  if (!state) return { dropped };
  for (const dev of listSyncDevices(userId)) {
    if (dev.wrapEpoch === 0 || await folderPresent(store, `${state.syncId}/d/${dev.dir}`)) continue;
    if (deleteSyncDevice(userId, dev.deviceId)) {
      dropped.push(dev.name);
      recordActivity({ userId, kind: 'sync_device_removed', title: `Sync: removed "${dev.name}" because its folder was deleted`, detail: { deviceId: dev.deviceId } });
    }
  }
  return { dropped };
}
```

- [ ] **Step 5: Hook into the producer and the consumer**

In `producer.mjs` add `import { pruneMissingDevices } from './registry.mjs';` and `rotateKeys` to the keys import (`import { ensureSyncKeys, syncIdsFor, rotateKeys } from './keys.mjs';`). In `publishOnce`, right after `if (!state?.enabled) return out;`, insert:

```js
  // Before any write: a device folder deleted on the storage must never be recreated by a put (design 12).
  if ((await pruneMissingDevices(userId, { store })).dropped.length) rotateKeys(userId, now);
```

(`ensureSyncKeys(userId)` on the next line re-reads the epoch, so the publish that follows rewraps at the new epoch.)

In `consumer.mjs` add `import { folderPresent } from './registry.mjs';`. Make the first line of `writeReply`'s body:

```js
      if (!(await folderPresent(store, base))) return; // revoked or deleted during the turn: never recreate the folder
```

Apply the same guard in `sweepStuckRequests`, right before its `store.put`:

```js
      const base = `${state.syncId}/d/${dev.dir}`;
      if (!(await folderPresent(store, base))) { finishRequest(row.user_id, row.device_id, row.request_id, 'failed'); continue; }
```

Then change that function's put path to `` `${base}/out/${row.request_id}.bin` ``.

- [ ] **Step 6: Run the tests**

Run: `cd extension && node --test tests/sync-registry.test.mjs tests/sync-rotate.test.mjs tests/sync-producer.test.mjs tests/sync-consumer.test.mjs tests/activity.test.mjs`
Expected: PASS. `sync-consumer.test.mjs` registers devices with `wrapEpoch 0` and may not write `key.bin`. If a consumer test now gets no reply because its fixture folder has no `key.bin`, change that fixture so it writes `key.bin` (as the producer does); do not weaken the guard.

- [ ] **Step 7: Commit**

```bash
git add extension/kb/sync-state.mjs extension/kb/activity.mjs extension/routes/sync/registry.mjs extension/routes/sync/producer.mjs extension/routes/sync/consumer.mjs extension/tests/sync-registry.test.mjs extension/tests/sync-consumer.test.mjs
git commit -m "feat(sync): revoke and desktop-off revoke by missing folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `/kb/sync/devices/*` and `/kb/sync/rotate` routes, contract and docs (API 113)

**Files:**
- Modify: `extension/routes/sync/http-routes.mjs`
- Modify: `extension/server.mjs`: `SERVER_API_VERSION` (line 327) + a `v113` comment after the `v112` line (line 320), and `ALL_ENDPOINTS` (after `'/kb/sync/publish',` at line 514)
- Modify: `schema/http/sync.schema.json`
- Regenerate: `schema/http/INVENTORY.md`, `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml`
- Modify: `docs/spec/api-server.md` (line 54 version, kbWrite row line 241), `docs/spec/cross-cutting.md:185`, `extension/CLAUDE.md` ("Sync (desktop producer)" section, line 74 on)
- Test: `extension/tests/sync-routes.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 4, 5 (exact names above); `storeFor` (`deps.storeFor` in tests).
- Produces (HTTP; JWT + bus host proof first, as for every `/kb/sync/*` route; all ride the `kbWrite` bucket through the existing prefix rule):
  - `POST /kb/sync/devices/enroll { tier: 'web'|'ios' }` → `200 { qr, expiresAt, tier }`; `400 VALIDATION_FAILED (field tier)`; `409 SYNC_NOT_SET_UP | SYNC_OFF`
  - `POST /kb/sync/devices/enroll/poll {}` → `200 { phase, sas, name, tier, code }`
  - `POST /kb/sync/devices/enroll/confirm {}` → `200 EncryptedSyncStatus`; `409 ENROLL_NOT_READY | ENROLL_FAILED | SYNC_OFF`
  - `POST /kb/sync/devices/enroll/cancel {}` → `200 { ok: true }`
  - `DELETE /kb/sync/devices/:id` → `200 EncryptedSyncStatus` (removes the folder, then the row, then rotates); `404 NOT_FOUND`
  - `POST /kb/sync/rotate {}` → `200 EncryptedSyncStatus`
  - `EncryptedSyncStatus` gains `rotationPending: boolean` and `devices[].folderHint: string` (the first 6 chars of `dir`).
  - Store errors → `502 SYNC_*` codes, as in SP1.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/sync-routes.test.mjs`. It uses that file's existing `call`, `user` and `MEGA` helpers and imports. Add `const { createReferenceDevice } = await import('./helpers/sync-device.mjs');`, `const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');` and `const { _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');` at the top with the other imports.

```js
test('device enrollment over the routes: QR, SAS, confirm, list, revoke, rotate', async () => {
  _resetEnrollmentsForTest();
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const store = createMemoryStore();
  const deps = { storeFor: () => store };
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'android' }, deps })).body.error.details.field, 'tier');
  const start = await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' }, deps });
  assert.equal(start.status, 200); assert.ok(start.body.qr.startsWith('llmide://pair?'));
  assert.equal((await call('POST', '/kb/sync/devices/enroll/confirm', { userId: u, body: {}, deps })).body.error.code, 'ENROLL_NOT_READY');
  const dev = createReferenceDevice({ name: 'Route phone' });
  await dev.scanAndClaim(store, start.body.qr);
  const poll = await call('POST', '/kb/sync/devices/enroll/poll', { userId: u, body: {}, deps });
  assert.equal(poll.body.phase, 'confirm');
  assert.equal(await dev.readAck(store), poll.body.sas);
  const done = await call('POST', '/kb/sync/devices/enroll/confirm', { userId: u, body: {}, deps });
  assert.equal(done.status, 200);
  assert.equal(done.body.devices[0].name, 'Route phone');
  assert.equal(done.body.devices[0].folderHint.length, 6);
  assert.equal(done.body.rotationPending, false);
  const raw = JSON.stringify(done.body);
  assert.ok(!raw.includes(dev.pair.dir) && !raw.includes(start.body.qr.match(/es=([^&]+)/)[1]), 'no folder capability or es in status');
  const e0 = done.body.epoch;
  const rot = await call('POST', '/kb/sync/rotate', { userId: u, body: {}, deps });
  assert.equal(rot.body.epoch, e0 + 1);
  assert.equal((await call('DELETE', '/kb/sync/devices/AAAAAAAAAAAAAAAAAAAAAA', { userId: u, deps })).status, 404);
  const rev = await call('DELETE', `/kb/sync/devices/${dev.deviceId}`, { userId: u, deps });
  assert.equal(rev.status, 200); assert.deepEqual(rev.body.devices, []); assert.equal(rev.body.epoch, e0 + 2);
  assert.equal((await call('POST', '/kb/sync/devices/enroll/cancel', { userId: u, body: {}, deps })).body.ok, true);
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' }, proof: false, deps })).status, 403);
});

test('enrollment needs a store and sync on', async () => {
  const u = user();
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' } })).body.error.code, 'SYNC_NOT_SET_UP');
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  const store = createMemoryStore();
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' }, deps: { storeFor: () => store } })).body.error.code, 'SYNC_OFF');
});
```

If `call` in that file passes `deps` only when given (it does: `handleSyncRoute(req, res, deps ? { deps } : {})`), the second test's first call uses the real `storeFor`, which returns `null` for a user without state → `SYNC_NOT_SET_UP`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && node --test tests/sync-routes.test.mjs`
Expected: FAIL (404 `NOT_FOUND` for the new paths).

- [ ] **Step 3: Implement the routes in `http-routes.mjs`**

Add the imports:

```js
import { startEnrollment, pollEnrollment, confirmEnrollment, cancelEnrollment } from './enroll.mjs';
import { revokeDevice } from './registry.mjs';
```

and extend the scheduler import to `import { storeFor as defaultStoreFor, dropStore, publishNow, rotateNow, rotationPending } from './scheduler.mjs';`. Add `const DEVICE_RE = /^\/kb\/sync\/devices\/([A-Za-z0-9_-]{22})$/;` below `fail`.

In `status(userId)`, change the devices mapping and add `rotationPending`:

```js
    devices: listSyncDevices(userId).map((d) => ({ deviceId: d.deviceId, name: d.name, tier: d.tier, addedAt: d.addedAt, folderHint: d.dir.slice(0, 6) })),
    rotationPending: rotationPending(userId),
```

Add `rotationPending: false` to the not-configured object as well.

Change the `handleSyncRoute` signature to keep `env` (it already has `{ deps = {}, env = process.env } = {}`). Insert the block below just before the final `return fail(res, 404, 'NOT_FOUND', …)` inside the outer `try`:

```js
    if (path.startsWith('/kb/sync/devices') || path === '/kb/sync/rotate') {
      const body = req.method === 'POST' ? await readJson(req, 1024) : {};
      if (req.method === 'POST' && path === '/kb/sync/devices/enroll' && body.tier !== 'web' && body.tier !== 'ios') {
        return fail(res, 400, 'VALIDATION_FAILED', 'tier must be web or ios', { field: 'tier' });
      }
      const store = getSyncState(userId) ? storeFor(userId) : null;
      if (!store) return fail(res, 409, 'SYNC_NOT_SET_UP', 'Set up a sync store first');
      const m = DEVICE_RE.exec(path);
      try {
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll') { send(res, 200, await startEnrollment(userId, { store, tier: body.tier, env })); return true; }
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll/poll') { send(res, 200, await pollEnrollment(userId)); return true; }
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll/confirm') {
          await confirmEnrollment(userId);
          await publishNow(userId, { store }).catch(() => {}); // SYNC_BUSY or a store error: the scheduler publishes
          send(res, 200, status(userId)); return true;
        }
        if (req.method === 'POST' && path === '/kb/sync/devices/enroll/cancel') { await cancelEnrollment(userId); send(res, 200, { ok: true }); return true; }
        if (req.method === 'DELETE' && m) {
          if (!(await revokeDevice(userId, m[1], { store }))) return fail(res, 404, 'NOT_FOUND', 'No such device');
          await rotateNow(userId, { store });
          send(res, 200, status(userId)); return true;
        }
        if (req.method === 'POST' && path === '/kb/sync/rotate') { await rotateNow(userId, { store }); send(res, 200, status(userId)); return true; }
      } catch (e) {
        const code = String(e?.code || '');
        if (code === 'SYNC_OFF' || code.startsWith('ENROLL_')) return fail(res, 409, code, 'Enrollment is not possible now');
        return fail(res, 502, code.startsWith('SYNC_') ? code : 'SYNC_IO', 'Sync store error');
      }
    }
```

`readJson` stays outside the inner `try`, so a bad body still reaches the outer catch (400/413), as in SP1.

- [ ] **Step 4: Server wiring**

In `extension/server.mjs`:
- Line 327: `const SERVER_API_VERSION = 113;`
- After the `//   v112 — …` comment line add:
  `//   v113 — sync device enrollment and registry, additive: POST /kb/sync/devices/enroll { tier } → { qr, expiresAt, tier } (the QR carries the one-time enrollment secret; nothing else returns it), POST /kb/sync/devices/enroll/poll|confirm|cancel, DELETE /kb/sync/devices/:id (folder, row, then key rotation), POST /kb/sync/rotate. Status gains rotationPending and devices[].folderHint (first 6 chars of the folder). JWT + bus host proof; 'kbWrite' bucket.`
- In `ALL_ENDPOINTS` after `'/kb/sync/publish',` add:

```js
  '/kb/sync/devices/enroll',
  '/kb/sync/devices/enroll/poll',
  '/kb/sync/devices/enroll/confirm',
  '/kb/sync/devices/enroll/cancel',
  '/kb/sync/devices/:id',
  '/kb/sync/rotate',
```

No rate-bucket edit: both bucket functions already map every other `/kb/sync/` path to `kbWrite` (lines 562 and 620).

- [ ] **Step 5: Contract schema**

In `schema/http/sync.schema.json`:
- Add `"rotationPending": { "type": "boolean" }` to `$defs.EncryptedSyncStatus.properties`.
- Add `"folderHint": { "type": "string", "description": "first 6 characters of the device folder, for desktop-off revoke" }` to the device item properties. If `devices` has no item schema yet, add `"items": { "type": "object", "properties": { "deviceId": {"type":"string"}, "name": {"type":"string"}, "tier": {"type":"string"}, "addedAt": {"type":"integer"}, "folderHint": {"type":"string"} } }`.
- Add these endpoints next to the existing ones, same style:

```json
"POST /kb/sync/devices/enroll": { "request": { "body": { "type": "object", "required": ["tier"], "properties": { "tier": { "type": "string", "enum": ["web", "ios"] } } } },
  "responses": { "200": { "type": "object", "properties": { "qr": { "type": "string" }, "expiresAt": { "type": "integer" }, "tier": { "type": "string" } } } } },
"POST /kb/sync/devices/enroll/poll": { "responses": { "200": { "type": "object", "properties": { "phase": { "type": "string", "enum": ["none", "waiting", "confirm", "failed", "expired"] }, "sas": { "type": ["string", "null"] }, "name": { "type": ["string", "null"] }, "tier": { "type": ["string", "null"] }, "code": { "type": ["string", "null"] } } } } },
"POST /kb/sync/devices/enroll/confirm": { "responses": { "200": { "$ref": "#/$defs/EncryptedSyncStatus" } } },
"POST /kb/sync/devices/enroll/cancel": { "responses": { "200": { "type": "object", "properties": { "ok": { "type": "boolean" } } } } },
"DELETE /kb/sync/devices/:id": { "responses": { "200": { "$ref": "#/$defs/EncryptedSyncStatus" } } },
"POST /kb/sync/rotate": { "responses": { "200": { "$ref": "#/$defs/EncryptedSyncStatus" } } }
```

Extend the top-level `description` error list with `409 SYNC_OFF|ENROLL_NOT_READY|ENROLL_FAILED, 404 NOT_FOUND (revoke)`.

- [ ] **Step 6: Regenerate and run the gates**

Run: `node scripts/http-inventory.mjs && node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && make contract-gates`
Expected: all pass. Inventory shows the six new paths.

- [ ] **Step 7: Docs**

- `docs/spec/api-server.md:54` and `docs/spec/cross-cutting.md:185`: `SERVER_API_VERSION = 113`.
- `docs/spec/api-server.md` kbWrite row (line 241): replace `/kb/sync/ (status, MEGA setup and the enable toggle)` with `/kb/sync/ (status, MEGA setup, the enable toggle, device enrollment, revoke and rotate)`.
- `extension/CLAUDE.md`, "Sync (desktop producer)" section: change `sync.megaPassword` in the **Vault** bullet to `sync.megaPassword`, `sync.prevRootKey` (24 h, for `stale_epoch`), and add:

```markdown
- **Enrollment** (SP2): `core/sync-enroll.mjs` (QR payload, claim, signed ack, SAS; vectors `enroll` in `schema/sync/v1`) and `routes/sync/enroll.mjs` (one pending enrollment per user, in memory; `es` is never stored or logged; the claim is pinned once and never re-fetched; the tier is the desktop's choice). Device contract: `schema/sync/v1/README.md` "Enrollment"; Node reference device `tests/helpers/sync-device.mjs`; malicious-storage suite `tests/sync-enroll-malicious.test.mjs`.
- **Registry**: `sync_devices` is the only registry. Revoke = `removeTree(d/<dir>)`, row delete, rotation (`routes/sync/registry.mjs`, `rotateNow` in the scheduler). A registered device with `wrapEpoch > 0` whose folder lost `key.bin` is dropped, rotated and noted (`sync_device_removed`) at the next publish; puts never recreate a deleted folder.
```

Run: `make docs-check`
Expected: pass.

- [ ] **Step 8: Run the tests**

Run: `cd extension && node --test tests/sync-routes.test.mjs tests/lazy-engine.test.mjs`
Expected: PASS (the lazy-engine test still shows `megajs` off the boot path, because the new modules load only through `http-routes.mjs`).

- [ ] **Step 9: Commit**

```bash
git add extension/routes/sync/http-routes.mjs extension/server.mjs schema/http docs/spec/api-server.md docs/spec/cross-cutting.md extension/CLAUDE.md extension/tests/sync-routes.test.mjs
git add docs/reference/api/openapi.yaml extension/src/lib/api-types.ts   # regenerated by gen-openapi / gen-api-types
git commit -m "feat(server): sync device enrollment, revoke and rotate routes (API v113)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Settings "Add a phone or browser" and full verification

**Files:**
- Modify: `ui/screens/settings/sync-model.ts`
- Create: `ui/screens/settings/sections/SyncDevices.tsx`
- Modify: `ui/screens/settings/sections/SyncSection.tsx` (render `<SyncDevices … />` inside the `status?.store &&` block, after the "Publish now" row)
- Modify: `ui/screens/settings/sections/HostApiPairing.tsx` (change `function PairingQr` to `export function PairingQr`; nothing else)
- Test: `ui/screens/settings/tests/sync-section.test.mjs`

**Interfaces:**
- Consumes: the Task 6 routes; `call`, `ApiError`, `CoreClient` (`ui/screens/settings/core-api.ts`); `PairingQr`; `Button`, `ErrorText` (`ui/screens/settings/ui.tsx`); `useEnv` (`../context.tsx`); `describeError` (`../errors.ts`).
- Produces (`sync-model.ts`):
  - `SyncDevice` gains `folderHint: string`; `SyncStatus` gains `rotationPending: boolean`
  - `interface EnrollStart { qr: string; expiresAt: number; tier: "web" | "ios" }`, `interface EnrollPoll { phase: "none"|"waiting"|"confirm"|"failed"|"expired"; sas: string | null; name: string | null; code: string | null }`
  - `decodeEnrollStart(v)`, `decodeEnrollPoll(v)`, `startEnroll(client, tier)`, `pollEnroll(client)`, `confirmEnroll(client): Promise<SyncStatus>`, `cancelEnroll(client)`, `revokeSyncDevice(client, deviceId): Promise<SyncStatus>`, `rotateSyncKeys(client): Promise<SyncStatus>`, `enrollFailureText(code): string`

- [ ] **Step 1: Write the failing tests**

Append to `ui/screens/settings/tests/sync-section.test.mjs`:

```js
test('enrollment decoders are strict and the calls hit the device routes', async () => {
  assert.deepEqual(m.decodeEnrollStart({ qr: "llmide://pair?sv=1", expiresAt: 5, tier: "ios" }), { qr: "llmide://pair?sv=1", expiresAt: 5, tier: "ios" });
  assert.throws(() => m.decodeEnrollStart({ qr: "x", expiresAt: 5, tier: "android" }));
  assert.throws(() => m.decodeEnrollStart({ qr: "javascript:alert(1)", expiresAt: 5, tier: "web" }), "only llmide:// or http(s) links render as a QR");
  assert.equal(m.decodeEnrollPoll({ phase: "confirm", sas: "012345", name: "P", tier: "ios", code: null }).sas, "012345");
  assert.throws(() => m.decodeEnrollPoll({ phase: "confirm", sas: "12a", name: null, tier: null, code: null }));
  const s = m.decodeSyncStatus({ ...STATUS, rotationPending: true, devices: [{ deviceId: "d", name: "n", tier: "web", addedAt: 1, folderHint: "Ab3xQz" }] });
  assert.equal(s.devices[0].folderHint, "Ab3xQz"); assert.equal(s.rotationPending, true);
  assert.equal(m.decodeSyncStatus(STATUS).rotationPending, false, "an older core decodes");
  const c = fake({ "POST /kb/sync/devices/enroll": { status: 200, body: { qr: "llmide://pair?sv=1", expiresAt: 1, tier: "ios" } },
    "DELETE /kb/sync/devices/d1": { status: 200, body: STATUS }, "POST /kb/sync/rotate": { status: 200, body: STATUS } });
  await m.startEnroll(c, "ios"); await m.revokeSyncDevice(c, "d1"); await m.rotateSyncKeys(c);
  assert.deepEqual(c.calls, ['POST /kb/sync/devices/enroll {"tier":"ios"}', "DELETE /kb/sync/devices/d1", "POST /kb/sync/rotate {}"]);
  assert.match(m.enrollFailureText("contested"), /Two devices/);
  assert.match(m.enrollFailureText("claim_invalid"), /could not be verified/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs`
Expected: FAIL (`m.decodeEnrollStart is not a function`).

- [ ] **Step 3: Extend `sync-model.ts`**

Change the two interfaces:

```ts
export interface SyncDevice { deviceId: string; name: string; tier: "web" | "ios"; addedAt: number; folderHint: string }
```

and add `rotationPending: boolean;` to `SyncStatus`. In `decodeSyncStatus`, map the devices to add `folderHint: typeof d.folderHint === "string" ? d.folderHint : ""`. Do it by changing the `.filter(...)` result with `.map((d) => ({ deviceId: d.deviceId, name: d.name, tier: d.tier, addedAt: d.addedAt, folderHint: typeof (d as { folderHint?: unknown }).folderHint === "string" ? (d as { folderHint: string }).folderHint : "" }))`. Add `rotationPending: v.rotationPending === true` to the returned object. Append:

```ts
export interface EnrollStart { qr: string; expiresAt: number; tier: "web" | "ios" }
export interface EnrollPoll { phase: "none" | "waiting" | "confirm" | "failed" | "expired"; sas: string | null; name: string | null; code: string | null }
const PHASES = new Set(["none", "waiting", "confirm", "failed", "expired"]);

export function decodeEnrollStart(v: unknown): EnrollStart {
  if (isRecord(v) && typeof v.qr === "string" && /^(llmide:\/\/pair\?|https?:\/\/)/.test(v.qr) && Number.isInteger(v.expiresAt) && (v.tier === "web" || v.tier === "ios")) {
    return { qr: v.qr, expiresAt: v.expiresAt as number, tier: v.tier };
  }
  throw new ApiError(0, "BAD_RESPONSE");
}
export function decodeEnrollPoll(v: unknown): EnrollPoll {
  if (isRecord(v) && typeof v.phase === "string" && PHASES.has(v.phase) && (v.sas === null || (typeof v.sas === "string" && /^[0-9]{6}$/.test(v.sas)))
    && strOrNull(v.name) && strOrNull(v.code)) {
    return { phase: v.phase as EnrollPoll["phase"], sas: v.sas as string | null, name: v.name as string | null, code: v.code as string | null };
  }
  throw new ApiError(0, "BAD_RESPONSE");
}
const ENROLL_FAILURES: Record<string, string> = {
  contested: "Two devices answered this code, so someone else may have seen it. Nothing was added. Start again, with the screen out of view of others.",
  claim_invalid: "The device's answer could not be verified, or it is a different kind of device (iPhone app vs browser). Nothing was added.",
  expired: "The code expired. Nothing was added. Start again.",
  store: "The sync storage could not be reached. Nothing was added.",
};
export const enrollFailureText = (code: string | null): string => ENROLL_FAILURES[code ?? ""] ?? "Adding the device stopped. Nothing was added.";
export const startEnroll = async (client: CoreClient, tier: "web" | "ios") => decodeEnrollStart(await call(client, "POST", "/kb/sync/devices/enroll", { tier }));
export const pollEnroll = async (client: CoreClient) => decodeEnrollPoll(await call(client, "POST", "/kb/sync/devices/enroll/poll", {}));
export const confirmEnroll = async (client: CoreClient) => decodeSyncStatus(await call(client, "POST", "/kb/sync/devices/enroll/confirm", {}));
export const cancelEnroll = async (client: CoreClient) => { await call(client, "POST", "/kb/sync/devices/enroll/cancel", {}); };
export const revokeSyncDevice = async (client: CoreClient, deviceId: string) => decodeSyncStatus(await call(client, "DELETE", `/kb/sync/devices/${encodeURIComponent(deviceId)}`));
export const rotateSyncKeys = async (client: CoreClient) => decodeSyncStatus(await call(client, "POST", "/kb/sync/rotate", {}));
```

- [ ] **Step 4: Run the model test**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write `SyncDevices.tsx`**

```tsx
// Settings → Phone and web sync → "Add a phone or browser": QR (sync fields; the one-time secret lives only in this
// component's state and the QR), the 6-digit code to compare, the device list with revoke, and key rotation.
// Polls every 2 s while adding; leaving the card cancels the enrollment.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useEnv } from "../context.tsx";
import { describeError } from "../errors.ts";
import { Button, ErrorText } from "../ui.tsx";
import { PairingQr } from "./HostApiPairing.tsx";
import { startEnroll, pollEnroll, confirmEnroll, cancelEnroll, revokeSyncDevice, rotateSyncKeys, enrollFailureText, describeSyncError,
  type EnrollStart, type EnrollPoll, type SyncStatus } from "../sync-model.ts";

export default function SyncDevices({ status, onStatus }: { status: SyncStatus; onStatus: (s: SyncStatus) => void }): ReactNode {
  const { client } = useEnv();
  const [start, setStart] = useState<EnrollStart | null>(null);
  const [poll, setPoll] = useState<EnrollPoll | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  active.current = start !== null && (poll === null || poll.phase === "waiting" || poll.phase === "confirm");

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(describeSyncError(e) ?? describeError(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    if (!start) return;
    const t = window.setInterval(() => { void pollEnroll(client).then(setPoll, (e) => setError(describeError(e))); }, 2000);
    return () => window.clearInterval(t);
  }, [client, start]);
  useEffect(() => () => { if (active.current) void cancelEnroll(client).catch(() => {}); }, [client]);
  const stop = () => { setStart(null); setPoll(null); };
  const begin = (tier: "web" | "ios") => run(async () => { setPoll(null); setStart(await startEnroll(client, tier)); });

  return (
    <div className="st-stack" role="group" aria-label="Sync devices">
      <span className="st-label">Add a phone or browser</span>
      {!start ? (
        <div className="st-row">
          <Button tone="primary" disabled={busy} onClick={() => void begin("ios")}>iPhone app</Button>
          <Button disabled={busy} onClick={() => void begin("web")}>Browser</Button>
        </div>
      ) : poll?.phase === "confirm" ? (
        <div className="st-stack" role="status">
          <p className="st-hint">Does <strong>{poll.name}</strong> show this code?</p>
          <p className="st-pre" aria-label="Code to compare"><strong>{poll.sas}</strong></p>
          <p className="st-hint">Confirm only if the code is the same on the device in your hand. If the device shows an error, or no code, choose "Codes differ".</p>
          <div className="st-row">
            <Button tone="primary" disabled={busy} onClick={() => void run(async () => { onStatus(await confirmEnroll(client)); stop(); })}>Codes match</Button>
            <Button tone="danger" disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); stop(); })}>Codes differ</Button>
          </div>
        </div>
      ) : poll?.phase === "failed" || poll?.phase === "expired" ? (
        <div className="st-stack" role="alert">
          <p className="st-hint">{enrollFailureText(poll.code)}</p>
          <div className="st-row"><Button onClick={stop}>OK</Button></div>
        </div>
      ) : (
        <div className="st-stack" role="status">
          <PairingQr payload={start.qr} />
          <p className="st-hint">{start.tier === "ios" ? "Scan with the LLM-IDE iPhone app." : "Open this link in the browser you want to add."} The code works for 2 minutes and once only. Keep this screen out of view of others.</p>
          <p className="st-pre" aria-label="Sync pairing link" style={{ userSelect: "text", wordBreak: "break-all" }}>{start.qr}</p>
          <div className="st-row"><Button disabled={busy} onClick={() => void run(async () => { await cancelEnroll(client); stop(); })}>Cancel</Button></div>
        </div>
      )}
      <span className="st-label">Sync devices</span>
      {status.devices.length === 0 ? <p className="st-hint">No devices yet.</p> : (
        <ul className="st-stack" aria-label="Sync devices">
          {status.devices.map((d) => (
            <li key={d.deviceId} className="st-stack">
              <div className="st-row">
                <span className="st-grow">{d.name} · {d.tier === "ios" ? "iPhone app" : "browser"}</span>
                <span className="st-hint">added {new Date(d.addedAt).toLocaleString()} · folder {d.folderHint}…</span>
                <Button tone="danger" label={`Revoke ${d.name}`} disabled={busy || confirming !== null} onClick={() => setConfirming(d.deviceId)}>Revoke…</Button>
              </div>
              {confirming === d.deviceId ? (
                <div className="st-dialog" role="alertdialog" aria-label={`Revoke ${d.name}`}>
                  <strong>Revoke {d.name}?</strong>
                  <p className="st-hint">Its sync folder is deleted and the keys of every other device are replaced. It must be added again to sync.</p>
                  <div className="st-row">
                    <button type="button" className="st-btn" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
                    <Button tone="danger" disabled={busy} onClick={() => void run(async () => { onStatus(await revokeSyncDevice(client, d.deviceId)); setConfirming(null); })}>Revoke</Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="st-hint">Lost a device while this computer is off? Delete its folder (it starts with the letters shown above) inside the sync folder in the MEGA web app. This desktop removes the device when it next starts.</p>
      <div className="st-row">
        <Button disabled={busy} onClick={() => void run(async () => { onStatus(await rotateSyncKeys(client)); })}>Rotate keys</Button>
        {status.rotationPending ? <span className="st-hint" aria-live="polite">Key rotation runs after the current sync cycle.</span> : null}
      </div>
      <ErrorText text={error} />
    </div>
  );
}
```

In `SyncSection.tsx`, import `SyncDevices from "./SyncDevices.tsx"` and render it inside the `status?.store && (…)` block, after the "Publish now" row and only when sync is on:

```tsx
          {status.enabled ? <SyncDevices status={status} onStatus={setStatus} /> : <p className="st-hint">Turn sync on to add a phone or browser.</p>}
```

In `HostApiPairing.tsx` change `function PairingQr(` to `export function PairingQr(`.

- [ ] **Step 6: Typecheck and UI tests**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/sync-section.test.mjs ../ui/screens/settings/tests/host-api-pairing.test.mjs && npm run typecheck --if-present`
Expected: PASS, no type errors.

- [ ] **Step 7: Full verification**

Run, in order. Each must pass, and failures that show up only here must be fixed:
1. `node scripts/sync-vectors.mjs`
2. `cd extension && npm test`
3. `make contract-gates`
4. `make docs-check`
5. `cd desktop && npm test`
6. `make regression`. Per CLAUDE.md the Mac suite runs only with full Xcode; that is fine.

Then grep for leaks: `grep -rn "console\.\(log\|info\)" extension/routes/sync extension/core/sync-enroll.mjs`. Expected: no hits that print `es`, `dir`, keys or claim names.

- [ ] **Step 8: Commit**

```bash
git add ui/screens/settings/sync-model.ts ui/screens/settings/sections/SyncDevices.tsx ui/screens/settings/sections/SyncSection.tsx ui/screens/settings/sections/HostApiPairing.tsx ui/screens/settings/tests/sync-section.test.mjs
git commit -m "feat(ui): add a phone or browser to sync with QR and code check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Decisions for the user (defaults applied)

| # | Decision | Default in this plan |
|---|---|---|
| D1 | Spec §5.2 adds a signed ack with a desktop nonce `nD` and a derived `deviceId`. Without the ack, a QR photographer who also controls storage could grind keys to match the phone's SAS. | Amend the spec (Task 1 Step 9). |
| D2 | Revoke also rotates the epoch (your brief); spec §5.3 says it is not needed. | Rotate on every revoke and on every desktop-off drop. |
| D3 | One QR for Host API and sync (spec) or a separate sync QR in the sync card. | Separate sync QR now. The field names do not collide, so a merged QR later needs no device change. |
| D4 | `st` for MEGA: the spec says the root node handle; the plan uses the folder name. | `mega:<folder>` (the device logs in to the same dedicated account). |
| D5 | Showing the first 6 characters of each device folder (`folderHint`) in Settings, so a lost device can be found and deleted with the desktop off. | Shown; the full name is never returned. |
| D6 | The web pairing origin. | `https://llm-ide.com`; `LLMIDE_SYNC_WEB_ORIGIN` may set an https origin or `http://localhost:<port>` for the localhost web app. |
| D7 | The window is excluded from screen capture during the QR (spec 5.2 step 1). It needs a Tauri change in `desktop/src-tauri`, which another workstream owns. | Not done in SP2; the UI warns "keep this screen out of view". |
| D8 | A leftover slot after a desktop crash mid-enrollment (`e/<slot>/`, `d/<dir>/key.bin`, no secrets) is not swept, because `list` cannot enumerate folders. | Left on storage; harmless ciphertext and public key. |
