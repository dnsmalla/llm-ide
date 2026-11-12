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

## Request plaintext: v1 and v2 (project routing)

- **v1**: `{"v":1,"class":"chat.send","requestId":<22 base64url>,"text":<1..4000 chars>}`. Runs in the desktop's global phone chat.
- **v2**: the same plus `"projectId"`, exactly the keys `class, projectId, requestId, text, v` with `v` 2 and `projectId` matching
  `^[A-Za-z0-9_-]{1,128}$` (the Host API project id). The turn runs in that project's phone chat, in that project's context, after
  the same project check the Host API gateway makes for `chat.send` (team class, project grant / `max_mode`, USD cap). A client
  with no project keeps sending v1; v2 never omits `projectId`.
- Reply format is unchanged (`v` 1). New failure code `project_unavailable`: the project is unknown, or this user may not use it.
  A desktop that predates v2 answers `refused` to a v2 request, so a client falls back to v1 on `refused`.
- Snapshot, manifest and kinds are unchanged. The request plaintext is not covered by `typedNegatives` (those mutate the
  envelope); the schema is exercised by `extension/tests/sync-consumer.test.mjs`.

## Enrollment (device contract)

Adding `enroll`/`enrollack` is additive: no existing byte changes, so `v` stays 1; vectors: `enroll` in
`vectors/v1.json`; Node reference device: `extension/tests/helpers/sync-device.mjs`.

- **QR payload.** `sv=1&sid=<Id22>&sfp=<43 b64u>&dir=<Id22>&slot=<Id22>&es=<Id22>&st=<percent-encoded store descriptor>`, in that order. iPhone: `llmide://pair?<query>`; browser: `<webOrigin>/#pair=<encodeURIComponent(query)>`. `st` is `mega:<folder>` or `box:<folder>` (`[A-Za-z0-9_.-]{1,64}`), `sftp:<host>` for the user's own server (`<host>` is a lower-case DNS name, `^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`; the device reads and writes `https://<host>/sync/<path>` with plain GET and PUT, no login, and never creates a folder), or `memory:` for tests. When `st` is `box:…`, two more fields follow `st`: `&bi=<Box client id>&bs=<Box client secret>` (each `[A-Za-z0-9]{16,128}`, required for `box:`): the user's own Box app, carried only in the optical QR, never through storage; they are not part of the claim MAC or SAS. Ignore unknown parameters; reject any field outside its pattern.
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
- iPhone (SP4): `ios_app/SharedProtocol` — `SyncDeviceTests`, `SyncEnvelopeTests`, `SyncPolicyTests`.
- Two device choices, both safe under the threat model: a missing `manifest.bin` while `key.bin` is present means
  "waiting for the first snapshot" (the desktop publishes up to 60 s after confirm), not "removed"; and the device
  switches to a newer epoch's keys as soon as the newer `wrap.bin` verifies (it is desktop-signed), keeping the old
  reply key for 24 h.

## Lifetime and clock (C5)

Two rules every client executes, pinned by `vectors/v1.json` → `devicePolicy`:

- **Manifest staleness.** The desktop sets `validUntil = generatedAt + 45 min` and refreshes it on a 15 min
  heartbeat. A device reads the manifest while `validUntil` has not passed, shows "withheld" after it, and refuses
  `stale_manifest` once `validUntil + 7 days < now`. The check runs after signature, epoch and rollback
  verification and before any `kinds` blob is fetched, so a desktop that was off for a week cannot feed old keys.
  Exactly 7 days past `validUntil` still reads (`<`, not `<=`). Node reference device:
  `extension/tests/helpers/sync-device.mjs`; browser: `web/src/sync/device.ts`; iPhone:
  `SyncDevice.readSnapshot` + `SyncPolicy`.
- **Device-token lifetime (Host API v1).** A token lives at most 90 days from **pairing**, even if it stays
  active; exactly 90 days is still valid. The desktop checks it at authentication and on every frame of an open
  session, deletes the expired row and answers non-retryable `auth_failed` ("past its 90 days — pair again"). The
  phone clears the saved token and shows the pairing screen with a direct re-pair action. Rule:
  `extension/core/device-lifetime.mjs`; vector cases: `devicePolicy.deviceToken`.

Both runners execute these rows: `node scripts/sync-vectors.mjs` plus
`node --test extension/tests/sync-policy.test.mjs` (Node), and `SyncPolicyTests` (Swift). `make
test-shared-protocol` runs both sides.

## Typed negatives and device implementations

`vectors/v1.json` → `typedNegatives` lists mutations of the `snapshot`, `manifest`, `request`, `reply` and `syncwrap`
vectors with the exact `SyncCryptoError` code each must produce (`op`: `flip`, `truncate`, `set` a field, `expect` a
header value, open with another purpose's `key`, or unwrap with a `currentEpoch`). Every implementation runs the whole
list: Node `extension/tests/sync-envelope.test.mjs`, Swift `ios_app/SharedProtocol` (`SyncEnvelopeTests`, SP4), and
WebCrypto (SP3). The `request` and `reply` vectors carry the device's own direction.
