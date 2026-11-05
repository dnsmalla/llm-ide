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

## Enrollment (device contract)

Adding `enroll`/`enrollack` is additive: no existing byte changes, so `v` stays 1; vectors: `enroll` in
`vectors/v1.json`; Node reference device: `extension/tests/helpers/sync-device.mjs`.

- **QR payload.** `sv=1&sid=<Id22>&sfp=<43 b64u>&dir=<Id22>&slot=<Id22>&es=<Id22>&st=<percent-encoded store descriptor>`, in that order. iPhone: `llmide://pair?<query>`; browser: `<webOrigin>/#pair=<encodeURIComponent(query)>`. `st` is `mega:<folder>` (`[A-Za-z0-9_.-]{1,64}`) or `memory:` for tests. Ignore unknown parameters; reject any field outside its pattern.
- **Device keys.** Fresh P-256 ECDH and ECDSA pairs; `deviceId = b64u(SHA-256(signingSPKI)[0..16])`; `name` is 1–64 UTF-16 units with no control characters.
- **Derived keys.** `E(label) = HKDF-SHA-256(es, SHA-256("llmide-sync-enroll-v1"), enc([label, sid, slot]), 32)` for `enroll`, `enrollack`, `bind`, `sas`. With `B = [sid, slot, dir, sfp, tier, deviceId, ecdhSPKI, signingSPKI, name]`, `mac = HMAC(E("bind"), enc(B))`, `claimHash = SHA-256(enc(["llmide/sync-claim/v1", deviceId, ecdhSPKI, signingSPKI, name]))`, and `SAS = HMAC(E("sas"), enc(B ++ [nD]))` first 4 bytes mod 1,000,000, six digits.
- **Claim.** The device pins `key.bin` by `sfp`, writes one sealed claim under a random Id22 at `e/<slot>/<Id22>.bin` (`purpose enroll`, `extra = signingSPKI`, plaintext `[ecdhSPKI, signingSPKI, name, mac]`), signed by its new key.
- **Ack.** The desktop pins the first claim and never refetches it; a second claim kills the slot. It writes one `ack.bin` (`enrollack`, plaintext `[nD, claimHash]`, signed by the desktop key). The device opens it with the pinned key; a different `claimHash` is `ack_mismatch`.
- **Finish.** Desktop writes the registry row (tier from the desktop), then `wrap.bin`, publishes, deletes the slot. Device verifies `wrap.bin` with the pinned key (tier own, epoch > 0), unwraps, erases `es`, then reads only its own folder.
- **Rotation.** A manifest epoch above the device's means GET `wrap.bin`, unwrap (higher epoch only), reopen the manifest; keep the old reply key for 24 h for `stale_epoch` replies.
- **Revoke.** The device's folder disappears; missing `key.bin`/`wrap.bin`/`manifest.bin` means "removed from sync" and the device stops. Desktop-off revoke deletes `d/<dir>` in the storage UI; Settings shows the first six `dir` characters.
- **Why storage cannot sit in the middle.** Without `es`, storage cannot produce a claim that opens or forge the ack. Without the desktop signing key, whose fingerprint came through the QR, it cannot forge `key.bin`, `ack.bin` or `wrap.bin`. A QR photographer who controls storage can replace the real claim, but the ack is bound to the pinned claim, so the real device fails closed. `nD` is chosen after the claim is committed; the device never accepts an ack for another claim. A second claim kills the slot.

## Implementations of the device side

- Node reference device: `extension/tests/helpers/sync-device.mjs` (SP2).
- Browser (WebCrypto, SP3): `web/src/sync/` — `envelope.ts`, `enroll.ts`, `device.ts`; vectors checked by
  `web/tests/sync-envelope.test.mjs` and `web/tests/sync-enroll.test.mjs`; end to end against the real desktop in
  `web/tests/e2e/sync-desktop-e2e.test.mjs`.
- Two device choices, both safe under the threat model: a missing `manifest.bin` while `key.bin` is present means
  "waiting for the first snapshot" (the desktop publishes up to 60 s after confirm), not "removed"; and the device
  switches to a newer epoch's keys as soon as the newer `wrap.bin` verifies (it is desktop-signed), keeping the old
  reply key for 24 h.
