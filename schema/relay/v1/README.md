# Relay v1 wire and crypto (live envelopes, slice R1/R2)

Design: docs/superpowers/plans/2026-10-31-relay-design.md. Plan: docs/superpowers/plans/2026-11-05-relay.md.
Frozen for the external review (G-EXT). Any change bumps `v` and the vectors.

## Canonical encoding `enc(fields)`
Concatenation over fields of `u32be(len(b)) || b`. A field is an unsigned integer (encoded as 8-byte
big-endian u64, so `len = 8`), a UTF-8 string, or raw bytes. No other encoding is ever signed or used as AAD.

## Header (clear, routable, bound as AAD and signed)
Field order: `1 (version) | purpose | userId | desktopId | from | to | epoch | session | seq | issuedAt | tier`.
- purpose: `open` `opened` `request` `reply` `wrap` `keyconfirm`. Up (device→desktop): open, request, keyconfirm.
  Down (desktop→device): opened, reply, wrap.
- ids: account-service ids (`[A-Za-z0-9_-]{1,64}`). `from` is the sender's device id (the desktop's own `devices.id`).
- epoch, seq, issuedAt (ms): u64. session: 22-char base64url (16 bytes) or "" for open/wrap/keyconfirm.
- tier: `web` or `ios` on a wrap, "" otherwise.

## Keys
- `salt = SHA-256("llmide-relay-v1" || enc([userId, desktopId]))`.
- `subkey = HKDF-SHA-256(ikm = K_root[epoch], salt, info = enc([purpose, epoch, "", sender, recipient]), L = 32)`.
- request key: purpose `request`, sender = deviceId, recipient = desktopId. Used for open, request, keyconfirm.
- reply key: purpose `reply`, sender = desktopId, recipient = deviceId. Used for opened, reply.
- At most 2^24 messages per key; the sender refuses beyond it.

## Plaintext padding
`u32be(len(frame)) || frame || 0x00…` to the smallest bucket ≥ len+4 among 1024, 4096, 16384, 65536, 262144,
1048576 bytes. A frame over 1,048,572 bytes is refused. Unpadding rejects a non-bucket size, a length past the
end, and any non-zero pad byte.

## Seal
`nonce` = 12 random bytes. `extra` = the wrap's ephemeral SPKI DER, empty otherwise.
`AAD = enc(header ++ [extra])`. `ct = AES-256-GCM(key, nonce, pad(plaintext), AAD)` with the 16-byte tag appended.
`sig = ECDSA-P256-SHA256-P1363(sender signing key, "llmide/<purpose>/v1\0" || enc(header ++ [extra, nonce, ct]))`.
JSON: header fields by name, `v: 1`, `nonce`, `ct`, `sig` (base64url, no padding), `eph` on a wrap only.
Receivers verify the signature first, then decrypt, then unpad. Any failure drops the envelope. Unknown `v` fails closed.

## Wrap (desktop → device, signed, relay design 4.4)
- `eph` = fresh P-256 key pair; `Z` = ECDH(eph, device ECDH public) x-coordinate (32 bytes).
- `wrapKey = HKDF-SHA-256(Z, salt = SHA-256(enc([ephSPKI, deviceEcdhSPKI])), info = enc(["llmide/wrap/v1",
  epoch, deviceId, SHA-256(deviceEcdhSPKI), SHA-256(desktopSigningSPKI), tier]), 32)`.
- plaintext = `enc([requestKey, replyKey, hostApiToken])`; sealed with `wrapKey`, `extra = ephSPKI`, signed by the desktop.
- The device accepts only if the signature verifies under the desktop signing key it pinned at SAS time, `to` is its
  own id, and `epoch` > its current epoch. It then sends `keyconfirm`: plaintext = `SHA-256("llmide/keyconfirm/v1" ||
  sig bytes of the wrap)`, under the request key.

## Session
Device sends `open` (plaintext: 16 random bytes `nD`). Desktop answers `opened` with a fresh `session` and plaintext
`nD`. Within a session `seq` starts at 1 and strictly increases per direction; a receiver drops anything else.
`issuedAt` outside ±10 minutes of the receiver's clock is dropped and surfaced.

## Connection (WebSocket, JSON text)
relay → client: `{t:"challenge",nonce}` `{t:"ready",role,userId,deviceId,desktopId}` `{t:"peer",id,online}`
`{t:"err",code,ref?}` `{t:"ping"}` `{t:"env",env}`.
client → relay: `{t:"auth",token,proof}` `{t:"pong"}` `{t:"env",env}`.
`proof = ECDSA-P256-SHA256-P1363(key, "llmide/relay/auth/v1\n" + nonce + "\n" + role + "\n" + tokenHash)`.
desktop tokenHash = hex SHA-256(access token string); device tokenHash = hex SHA-256(decoded 32-byte token).
Close codes: 4001 auth, 4003 revoked, 4008 rate limited, 4009 replaced, 1008 protocol, 1001 idle.
Error codes: auth_failed, not_authenticated, invalid_message, bad_sender, bad_direction, bad_recipient,
peer_offline, rate_limited.
