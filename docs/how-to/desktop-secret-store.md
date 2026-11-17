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
- The webview cannot read the JWT secret or the vault key: no command returns
  them. The one other keychain entry, the local login, is covered below; the
  webview can get its refresh token but never its password.
- An adopted server on :3456 keeps its own environment; the host only supplies
  secrets to a sidecar it spawns.

## Local login (`local-login`)

Code: `desktop/src-tauri/src/local_login.rs`. The email, password and session of
the local account are kept so that the app signs in at every start. They are one
JSON entry under the account `local-login` (service `com.llmide.desktop`):

| Field | Holds |
|---|---|
| `password` | The account password, so the app can sign in again without asking |
| `refresh` | The refresh token of the local core session: set by every save from the verified sign-in, then rotated by the webview under the saved email |
| `email` | The account email (the only part Settings shows) |
| `dataDir` | The desktop data dir it was saved from; another dir reads as no login and the entry is not deleted |

**One slot.** The keychain holds one local login. Save replaces it and forget
clears it, whatever data dir saved it. A different data dir is ignored when
reading (the entry is never deleted by a read), so it reads as "no login" there.

**When it is written:** with "Keep me signed in on this computer" ticked (the
default in local mode), the login panel calls `local_login_save`. The host signs in
to the local core first and stores the login only when the core answers HTTP 200
with a refresh token. A wrong password (401/403) writes nothing. On an adopted (dev)
core the save is refused (`untrusted_core`): that sign-in goes ahead without saving,
and the panel says the login was not saved. Settings > Account > Saved login uses
the same command for "Change". Each refresh rotation updates
`refresh`, but only when the signed-in user's email matches the saved one
(case-insensitive).

**Unticking the box** forgets any saved login before that sign-in.

**When it is cleared:** only by an explicit sign-out (Sign out, Sign out and
forget this device, Sign out and disconnect all accounts) or by Forget in Settings.
An expired session or a 401 never clears it. If the keychain refuses the forget
during sign-out, the sign-out still completes and the Saved login row shows the
login with a warning. A rejected saved password keeps the entry, so the user can
update it, and the login panel says so.

**Trust rule (MUST):** the password and the refresh token are sent only to the
local core that this host spawned and verified right now. Every command re-probes
`/health` for this launch's nonce (`CoreHost::verified_url`) inside its blocking
task, immediately before use. A busy core may miss one probe, so the check is tried
up to three times over about two seconds before it refuses. The core must be Ready, trusted as `spawned`, and at
`http://127.0.0.1:<port>`. Stopped, restarting, failed, adopted, remote and SSH
cores get `untrusted_core`. The gate is `local_login::credential_core`.

**What the webview can do:** get the refresh token (`local_login_session`); ask the
host to sign in with the saved password and return a new refresh token
(`local_login_relogin`); store a rotated token under the signed-in email
(`local_login_store_refresh`); read the saved email (`local_login_status`); send a
password in through `local_login_save` and get back the refresh token. It can
never read the password back.

**Residual risk (accepted):** a compromised webview can still save a login for
any account whose password it knows, and that login is then used at the next start.

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

`LLMIDE_KEYCHAIN_BACKEND=memory` selects an in-process store; `cargo test --lib`
uses the trait directly with the memory backend and never touches a real keychain.

## Data from the retired Mac app

The desktop app uses its own service and accounts and never reads the old Mac
app's keychain items. To bring old data and its vault over, follow
[Import the old Mac app's data](import-old-mac-data.md), which includes setting
the two keychain items by hand.

## Not yet verified

Real Windows Credential Manager and Linux Secret Service runs (CI compile and
`cargo test --lib` only use the memory backend); macOS Keychain prompt behaviour
in a signed app (the sidecar start path was not run end to end).
