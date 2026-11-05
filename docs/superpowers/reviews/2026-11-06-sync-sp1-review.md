# Sync SP1 review, Tasks 1 to 8 (2026-11-06)

Independent review of `33ee8293`..`1a82b3b9` (plan [`box-sync-desktop-producer`](../plans/2026-11-05-box-sync-desktop-producer.md), design [`box-encrypted-sync-design`](../specs/2026-11-05-box-encrypted-sync-design.md), ADR 0020). Task 9 (Settings card) was not reviewed.

Tests: `tests/sync*.test.mjs` and `tests/lazy-engine.test.mjs` 53/54 (1 skipped: the opt-in live MEGA run); `make contract-gates` passes; `scripts/sync-vectors.mjs` ok; **`make docs-check` fails** (docs say migration 63 and API 111; code is at 64 and 112).

**Verdict:** no Critical findings; the security core is sound.

- MEGA credentials live only in the vault as internal keys. Errors carry fixed codes, never the megajs error; status shows only the masked email; logs carry codes only.
- The envelope checks the signature before decrypting; keys are separated per purpose, epoch and device; the relay v1 vectors match byte for byte.
- Only the request text reaches `startHostTurn`, which hard-codes `AUTO_READ_ONLY`; nothing in SP1 enrolls a device, so the inbox trusts no one today.
- `megajs` is pinned exactly at 1.3.10, its transitive packages are MIT or ISC, and `close()` logs out.

## Important (fix before SP2)

1. **Stuck `running` requests** (`extension/routes/sync/consumer.mjs:83-85`): if the core crashes after a request is recorded, the row stays `running` forever; the replayed inbox file is then deleted with no reply, and nothing sweeps those rows at startup. Spec section 6.3 says the device gets `turn_failed`. Add a startup sweep that answers `turn_failed`.
2. **Changing the MEGA account or folder** (`routes/sync/http-routes.mjs:47`, with `producer.mjs:29`, `:54`): the device wrap epoch and published-blob records are kept, so the new folder never gets `key.bin`/`wrap.bin` or the unchanged blobs, and its manifest names missing blobs. Reset the published records and republish keys on a store change.
3. **Publish races the scheduler** (`routes/sync/http-routes.mjs:72`): `POST /kb/sync/publish` runs `syncCycle` outside the scheduler's `busy` set, so two publishes for one user can delete each other's new blob (`producer.mjs:56`) and leave the manifest pointing at a deleted blob; the request can also block for up to 5 × 10-minute turns. Run it through the same per-user lock, and return without waiting for turns.
4. **`megajs` loads at every boot** (`extension/server.mjs:23` imports `http-routes.mjs`, which imports `mega.mjs` and `scheduler.mjs`, which import `megajs`, `mega.mjs:76`): about 66 ms even when sync was never set up; the dynamic import at `server.mjs:1530` is cosmetic. Load the adapter lazily on first use, and make `tests/lazy-engine.test.mjs` assert `megajs` is off the boot path.
5. **Docs drift** not covered by the plan: update migration head 0064 and API 112 in `docs/spec/knowledge-base.md`, `docs/explanation/architecture.md`, `docs/spec/cross-cutting.md`, `docs/spec/api-server.md`, and add `make docs-check` to Task 9's verification.
6. **Vectors lack negatives** (`schema/sync/v1/vectors/v1.json`): none of spec section 13's flip, truncate, wrong purpose, wrong epoch, wrong `to` cases; and the check mode (`scripts/sync-vectors.mjs:47`) reuses stored envelopes instead of recomputing the snapshot and manifest ciphertext from the reference. SP3 (WebCrypto) and SP4 (Swift) reuse these vectors, so fix this first.

## Minor

- The `refused` and `stale_epoch` replies are never sent.
- The `setPublished` loop runs outside `db.transaction()` (`producer.mjs:54`).
- `GET /kb/sync/status` creates vault keys (`http-routes.mjs:25`); a read should not write.
- Snapshot data is loaded every 60 s even with zero devices, and the meetings query pulls full transcripts that are never sent (`kinds.mjs:63`).
- The Settings probe writes under the real `syncId` instead of a random one.
- `deps.cancel` is not awaited (`consumer.mjs:42`, `:47`).
- `onLost` drops the MEGA session without closing it (`mega.mjs:178`).
- `extension/package.json` was rewritten with `—` and `→` escapes in `description`; restore the plain characters.
- Missing tests: the scheduler tick and shutdown logout, `loadKinds` against real DB rows, and consumer epoch, `from` and cross-user cases.
