# Device linking v1

Status: **implemented and deployed 2026-11-05**. Sub-project 2 of the accounts/device-linking design;
the relay, PWA BFF and iOS client are still open.

## Delivered

- `account-service/src/migrations/0004_link_requests.sql` — `link_requests` state machine and the unique
  client-held device-token hash index.
- `account-service/src/routes/linking.mjs`:
  - `POST /v1/link/requests` (full web session) — pending device + commitment, 10 min.
  - `GET /v1/link/requests/status?requestId=…` (full web session) — state, desktop nonce/public key, SAS.
  - `POST /v1/link/requests/keys` (full web session) — verifies commitment, stores public keys and
    token hash, moves to `keys`.
  - `GET /v1/link/requests` (desktop Bearer) — pending/approved/keys requests for the account.
  - `POST /v1/link/requests/approve` (desktop Bearer) — stores the desktop-chosen nonce.
  - `POST /v1/link/requests/deny` (desktop Bearer) — unlinks the pending device.
  - `POST /v1/link/requests/confirm` (desktop Bearer) — links the device after the user compared the SAS.
- `account-service/public/link.html` + `link.js` — browser device side: P-256 signing/ECDH keys,
  commitment, approval polling, public-key reveal, independently computed SAS, client-held token.
- `desktop/src-tauri/src/account_oauth.rs` — authenticated link list/approve/deny/confirm commands;
  commitment verification and SAS computation in Rust.
- `ui/screens/settings/sections/AccountSection.tsx` — Settings → LLM-IDE account link approval card.
- Tauri command permissions and `build.rs` allowlist.

## Crypto vectors

Both sides use raw SPKI DER and raw 32-byte nonces, not their base64url text:

```text
commit = SHA-256("llmide/link/commit/v1" || deviceSigningSPKI || deviceEcdhSPKI || nD)
SAS    = first 4 bytes of SHA-256("llmide/link/sas/v1" || deviceSigningSPKI ||
         deviceEcdhSPKI || desktopSigningSPKI || nD || nK) mod 1_000_000, zero-padded
```

The Rust test `link_commitment_and_sas_match_the_service_vector` pins the same values as
`account-service/tests/linking.test.mjs` (`954028` for the fixture).

## Security properties

- The service sees only public keys, commitments, nonces, token hashes and status.
- Keys are accepted only after desktop approval and only when they reproduce the commitment.
- The SAS is computed on both sides; the browser refuses to display a code that differs from the
  service's value and the desktop refuses to confirm without a matching commitment.
- Expiry is 10 minutes; deny/expiry marks the device `unlinked`.
- Direct sign-up is off on the live service. The fixed account service requires an explicit address
  allowlist if direct sign-up is ever turned on in production.

## Tests

- `account-service`: 95/95.
- Desktop Node: 2086/2086.
- Desktop Rust: 518/518 (including the link vector).
- TypeScript: clean.
- Live: `https://accounts.llm-ide.com/health` → `directSignup:false`; `/link.html` → 200.

## Open

- Relay transport and encrypted snapshots (sub-project 3).
- PWA on its own origin with a same-origin BFF; iOS passkey linking (sub-project 4).
- Real GUI run of the Settings approval card and a real device link.
- External security/legal review, SMTP/recovery.
