# Sync SP2 and SP3 review (2026-11-06)

Independent review of SP2, device enrollment (`bc5d2400`, `a4973a1f`, `4ed727cf`, `be56c956`, `45829375`, `1c4e89f8`, `eef50b8c`; plan [`sync-sp2-enrollment`](../plans/2026-11-06-sync-sp2-enrollment.md)), and SP3 Tasks 1 to 7, the web device (`e1ea574d`, `e785b021`, `b14f19c3`, `613d5a81`, `698b0823`, `a1732fc2`, `35b79e4b`; plan [`sync-sp3-web`](../plans/2026-11-06-sync-sp3-web.md)). **SP3 and SP4 build on SP2: fix SP2 C1 first.**

## SP2: enrollment

Tests: `tests/sync*.test.mjs` 81 pass, 0 fail, 1 skipped (the opt-in live MEGA test); `scripts/sync-vectors.mjs` ok; `make contract-gates` passes; Settings tests 4/4 (model only; nothing renders `SyncDevices`).

**Verdict: not MITM-proof against malicious storage**, because of an implementation race. The crypto design holds: the SAS covers sid, slot, dir, sfp, tier, device id, both device public keys, name and nD, and nD is fresh and committed in the signed ack.

### Critical

**C1, `take()` can run twice at once, so the claim and the SAS can come from different claims** (`extension/routes/sync/enroll.mjs:59-83`). The phase stays `waiting` across the awaits; `p.claim` is set at `:73` before the ack upload at `:78`; `p.sas` at `:80` is computed from the local `claim`. Reproduced in review (an attacker who photographed the QR and controls storage, no grinding):

1. The first poll lists only the real device's claim; storage holds back that poll's ack upload.
2. The UI's 2 s timer fires a second poll; storage lists only the attacker's claim, and that ack upload completes at once.
3. Storage lets the first upload finish.
4. The desktop now holds the attacker's claim but shows the SAS computed from the real device's claim and the first nD.
5. Storage serves the first ack to the device, so both screens show the same 6 digits; the user confirms, and the registry gets the attacker's keys.

Also, `:82` sets `phase = 'confirm'` unconditionally, so an in-flight poll can revive a slot that was already killed (contested or expired, keys zeroed), which then shows a SAS made with an all-zero key and accepts confirm.

**Fix:** set a pinning phase before the first await; re-check the phase after every await; set `p.claim` and `p.sas` together only after the ack upload succeeds; run poll and confirm under the per-user lock; never move a killed slot back to `confirm`. Add a test that drives **concurrent** polls with storage delaying one upload and asserts nothing is registered.

**Enabler, `ui/screens/settings/sections/SyncDevices.tsx:28`:** `setInterval` polls every 2 s without waiting for the previous poll. The fix belongs on the server; also make the UI poll one at a time.

### Important

- **I1, revoke runs outside the per-user lock** (`routes/sync/http-routes.mjs:103`, `routes/sync/registry.mjs:13`): a publish already running (`producer.mjs:38-43`) can write `key.bin`, `wrap.bin`, the manifest and snapshots back into the folder just deleted, which breaks "never recreate the folder" and leaves an orphan folder. Run revoke under `withUserLock`. `confirmEnrollment`'s `writeDeviceWrap` (`enroll.mjs:109`) is outside the lock too; there the only effect is a stale `wrapEpoch` the next publish repairs.
- **I2, the reference device shares the implementation** (`extension/tests/helpers/sync-device.mjs:5` imports `core/sync-enroll.mjs`): the end-to-end and malicious-storage suites run the same code on both sides, so a mistake both share cannot fail a test. The vector generator (`scripts/sync-vectors.mjs` with `relay-reference.mjs`) is independent, so the byte layout is covered. Base the reference device on the independent reference, and add the concurrency tests above.

### Minor

- Storage can hide `key.bin` (or MEGA can return a transient empty listing) and get a good device dropped and the keys rotated (`registry.mjs:22`): denial of service only, acceptable here; require two missed checks in a row.
- Vector negatives miss QR parsing, `bad_from`, an ack addressed to another device, an nD of the wrong length, and a swapped ECDH key or name in the claim.
- After a backend restart (`phase: none`) the UI shows the old QR again and keeps polling (`SyncDevices.tsx:58-60`).

**Checked and fine:**

- The device pins `key.bin` by `sfp`; acks and wraps are verified with the pinned key and must name this device.
- The four derived keys are separate, none used twice; claims, acks and wraps cannot be replayed across slots or epochs.
- The tier is fixed by the desktop; a revoked device gets no new wrap; the old root key is internal and kept 24 h.
- Routes require JWT plus the host proof; no secret is returned except the QR; nothing is logged; the QR appears only after a click and is cleared afterwards.

## SP3: web device (Tasks 1 to 7)

Tests: `web` 136/138 (the 2 failures are `serve.test.mjs` listen EPERM in the sandbox); `tsc` clean.

**Verdict: approve with 2 Important; no Critical.**

- All keys are non-extractable; ECDH uses `deriveBits` only; no private key is exported; keys persist in IndexedDB (reload tested on a fake IndexedDB only).
- All 11 enrollment negatives are asserted with their error codes.
- Pinning matches the contract: `key.bin` is checked against the QR `sfp` before any write; the SAS uses only own, QR and signed-ack values; signatures are verified before decrypt.
- The MEGA password is never persisted; the `#pair=` fragment is stripped first.
- Only the two MEGA hosts are added to `connect-src`, and `script-src 'self'` is kept.
- The queue holds only chat prompts, at most 5.
- The malicious-storage suite covers swaps and replays, and each case fails if its check is removed.

### Important

- **Retry makes a second claim** (`web/src/sync/controller.ts:155-157`, `:172`): after a transient failure post-claim, `pair` stays set, and a retry calls `startPairing` again with new device keys and a new claim name. If the first claim landed, the desktop kills the slot as `contested`. Contract 4c says to reuse the same name and bytes: keep `Enrolling` across retries, or clear `pair` on any failure after `startPairing`.
- **A weak assertion** (`web/tests/sync-device-malicious.test.mjs:54`): the replayed-ack-from-another-slot case asserts only `code.startsWith('bad_')`; assert `bad_session`.

### Minor

- `readNewerWrap` changes `d.keys` and `d.epoch` before the new manifest verifies (`device.ts:89-93`, the documented deviation); state-unchanged-on-refusal is not tested on this path.
- The enrollment keys stay referenced in `Enrolling` until GC (contract 4e wants erase); non-extractable, so low risk.
- No malicious test for a swapped nD or a forged ack `userId`.

Not reviewed: SP3 Task 8 (screens and app switching) and Task 9 (real-desktop e2e and docs), which were uncommitted.

## Re-review after the fixes (2026-11-06)

Fixes `882d1db8` (C1: single-flight, pin-once `take()`, Settings polls one at a time), `28aa6b1b` (I1: revoke under the per-user lock), `2626889b` (I2: independent reference device), `2b68cb88` and `fd45081f` (SP3 retry and `bad_session`), `9e3d30b1` (inventory). Tests: `tests/sync*.test.mjs` 84 pass, 1 skipped; vectors ok; `web` 139/139.

**Verdict: enrollment now holds against malicious storage.** The original race and 12 variants were tried, and none registered an attacker or confirmed a killed slot:

- the original race, unchanged;
- the same race, with storage hiding the attacker file at confirm;
- storage showing the desktop only the attacker's claim;
- poll racing confirm, in both orders;
- confirm racing cancel;
- start racing an in-flight poll for the previous slot;
- a claim sealed for another slot;
- an ack upload delayed past expiry;
- a backend restart, then a replay into the new slot;
- an old ack replayed after cancel;
- storage keeping the ack but reporting a failed upload.

The new reference device imports only `node:crypto` and `scripts/relay-reference.mjs`.

**I-1, storage could block revoke forever** (delete before the row, no store timeouts): **fixed** in the commit after `9e3d30b1`. Revoke drops the row first and deletes the folder best-effort; every MEGA store call times out after 30 s (`withTimeouts`, `connectors/sync-store/index.mjs`); tests cover a refusing and a hanging delete.

Still open (Minor): `enroll.mjs:99` puts `pinning` back to `waiting` if `take()` throws after the ack upload (should kill the slot); two simultaneous `startEnrollment` calls leave an orphan pending enrollment for up to 245 s (it cannot be confirmed); a restart leaves the old slot and `key.bin` on storage.
