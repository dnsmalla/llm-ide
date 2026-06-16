---
title: How to add a new vault key
applies_to: server
---

# How to add a new vault key

## Goal

Extend the credential vault's allow-list with a new key (e.g., `notion.apiKey`).

## Steps

1. **Edit the allow-list.** In `extension/server/vault.mjs`, add the new key to `ALLOWED_SECRET_KEYS`.
2. **Document it.** Add a row to the vault section in [explanation/security-model.md](../explanation/security-model.md).
3. **Add a UI input** under Settings → Secrets in `extension/src/sidepanel/`.
4. **Use it.** Read the secret via `vault.get(userId, 'notion.apiKey')`. Never log it; redact it in audit `detail` by name.

## Verification

```bash
curl -X POST http://127.0.0.1:3456/auth/me/secrets \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"key":"notion.apiKey","value":"test"}' \
  -H 'Content-Type: application/json'
```

Then check the row exists in `user_secrets` and is ciphertext, not plaintext.

## See also

- [ADR 0007 — per-user vault key via HKDF](../decisions/0007-per-user-vault-key-hkdf.md)
