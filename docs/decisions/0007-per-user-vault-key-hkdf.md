---
title: "0007. Derive per-user vault keys via HKDF, never share one DEK"
status: accepted
date: 2026-05-18
---

# 0007. Derive per-user vault keys via HKDF

## Context

The credential vault holds GitHub tokens, Slack webhook URLs, and other per-user secrets. A naive scheme would encrypt them all with one data-encryption key. That means a leak of one user's row plus the master key compromises every user.

## Decision

A per-user data key is derived: `HKDF-SHA256(masterKey, salt=userId, info='meetnotes-vault-v1', length=32)`. Each ciphertext is `version_byte || iv(12) || aes-256-gcm(plaintext) || tag(16)`. The master key is `MEETNOTES_VAULT_KEY` (env var; auto-generated and persisted in dev).

## Consequences

- **Positive:** a DB-only leak is useless without the master key.
- **Positive:** a leak of one user's ciphertext blocks does not help against any other user.
- **Positive:** the allow-list of secret keys (in `extension/server/vault.mjs`) prevents accidental storage of arbitrary fields.
- **Negative:** rotating the master key invalidates every stored secret. Acceptable; rotation is rare and intentional.
