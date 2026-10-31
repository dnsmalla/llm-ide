# Desktop secret store (Tauri host)

The desktop host keeps the two secrets the Node core needs in the operating
system's credential store and hands them to the sidecar through its environment.
Code: `desktop/src-tauri/src/secrets.rs`.

| Secret | Env var for the sidecar | Stored account |
|---|---|---|
| JWT signing secret | `LLMIDE_JWT_SECRET` | `jwt-secret` |
| Vault master key | `LLMIDE_VAULT_KEY` | `vault-key` |

Service name: `com.llmide.desktop`. Each value is 32 random bytes from the OS
CSPRNG, hex encoded (64 chars; the server requires at least 32).

## Behaviour

- First start generates and stores both; every later start reads them. Only a
  definite "no entry" generates. Any read error (locked store, denied access)
  stops the core start with a clear error and writes nothing, because
  regenerating would make existing vault contents undecryptable.
- A stored value that is too short or not text is reported, never overwritten.
  To reset, delete the `com.llmide.desktop` entries in the OS credential manager.
- The secrets reach the sidecar via `Command::env` only: never argv, never logged
  (`Secrets` has a redacted `Debug`; errors never include values).
- The webview gets one command, `secrets_status`, returning booleans
  (`backend`, `available`, `jwt_secret`, `vault_key`). No command returns a value.
  It is declared in `build.rs`, granted as `allow-secrets-status` in
  `capabilities/default.json`, and covered by `npm run check:security`.
- An adopted server on :3456 keeps its own environment; the host only supplies
  secrets to a sidecar it spawns.

## Per-OS stores

| OS | Store | Notes |
|---|---|---|
| macOS | Keychain (login keychain) | first access may prompt; a locked keychain fails closed |
| Windows | Credential Manager | |
| Linux | Secret Service over D-Bus (gnome-keyring, KWallet) | needs libdbus-1 (dev package to build) and a running service |

Linux without a Secret Service is **unsupported**: the host reports the error and
does not start the sidecar. There is deliberately no plaintext or encrypted-file
fallback (an encrypted file needs its own key, which just moves the problem).

## Dependency

`keyring` 3.6.3 (MIT OR Apache-2.0), exact pin, `default-features = false`, one
backend per OS via target-specific dependency tables, so each build links only its
own store. `getrandom` 0.3.4 (already in the lockfile) provides the randomness.
macOS adds `security-framework` + `core-foundation`; Windows adds `windows-sys`;
Linux adds `dbus-secret-service` and RustCrypto (`crypto-rust`, no OpenSSL).
`Cargo.lock` lists the union (about 80 crates) because it resolves every target.

## Tests

`LLMIDE_KEYCHAIN_BACKEND=memory` selects an in-process store (same convention as
the Mac app); `cargo test --lib` uses the trait directly with the memory backend
and never touches a real keychain.

## Migration from the Mac app

The desktop app uses its own service and accounts. It never reads the Mac app's
keychain items, so a user moving over starts with fresh secrets: stored provider
keys in the old vault are not carried over and must be re-entered (or imported
with an explicit user action in a later task).

## Not yet verified

Real Windows Credential Manager and Linux Secret Service runs (CI compile and
`cargo test --lib` only use the memory backend); macOS Keychain prompt behaviour
in a signed app (the sidecar start path was not run end to end).
