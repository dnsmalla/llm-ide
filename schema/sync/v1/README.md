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
