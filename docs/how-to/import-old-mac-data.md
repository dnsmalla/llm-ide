---
title: Import the old Mac app's data into the desktop app
applies_to: desktop
---

# Import the old Mac app's data into the desktop app

The retired Swift Mac app kept its per-install data in
`~/Library/Application Support/llm-ide/system`. The desktop app (Tauri) deliberately uses a
different folder, `~/Library/Application Support/llm-ide-desktop/core`, so the two applications can
never open the same SQLite database or secrets. A fresh desktop install therefore starts with an
empty database, even on a machine whose old Mac app database is hundreds of megabytes.

This guide describes the **one-time, verified import** of the old folder into the desktop folder.
It is explicit: nothing imports at boot, and no silent detection changes the desktop data.

## What gets imported

| Old Mac app file | Desktop result | Notes |
|---|---|---|
| `data.db` (+ `-wal`, `-shm`) | `core/data.db` | Snapshot with `VACUUM INTO`, so rows still in the WAL are included and the result is one clean file with no sidecars. |
| `agent.db` | `core/agent.db` | Same snapshot; agent-run history. |
| `.dev-secrets.json` | `core/.dev-secrets.json` | Holds the vault master key. Without it every vault-encrypted secret (API keys, connector tokens) would be unreadable. The desktop host also moves `jwtSecret` and `vaultKey` into the OS keychain, because the core it spawns receives those two values from the keychain and the environment wins over the file. |
| `backups/` | not imported | Old DB copies stay in the old folder. |
| `agent-sdk/` | not imported | Per-user Claude logins are re-established by the desktop app. |
| `server.log`, `server.log.old` | not imported | Logs only. |

The old folder is **never changed**: it is not renamed, deleted, moved, checkpointed or edited. The
import reads it under a write lock and removes only the transient `-wal`/`-shm` files its own
read-only inspection created (and only if they did not exist before).

## The explicit action (recommended)

1. Quit anything that may still have the old `data.db` open (the Mac app was removed; an old server
   process is the usual culprit).
2. Start the desktop app.
3. Open **Settings → Server & Backend → Old Mac app data**.
4. The card shows a read-only status: the old folder, its size, rows and schema version, and the
   desktop folder it would replace.
5. Press **Import old Mac app data…**.

If the desktop data folder is **empty or initial** (no `data.db`, a zero-byte one, or one with no
tables), the import proceeds without replacing anything.

If the desktop data folder **already holds data**, the card says **Would replace the desktop data**
and the button becomes **Replace with old Mac app data…**. Pressing it opens a native,
Cancel-first confirmation that names both folders and the size. Only that click starts the
replacement. The helper writes and verifies a backup of the current `data.db`, `agent.db` and
`.dev-secrets.json` under `core/backups/pre-import-<stamp>.*` **before** the switch.

The desktop-owned core is stopped for the switch and restarted afterwards. An adopted external
server is never stopped; if it holds the target DB the import refuses with `target-in-use` and
nothing changes.

### Keychain transfer (why the app must do it)

The host spawns the core with `LLMIDE_JWT_SECRET` and `LLMIDE_VAULT_KEY` from the OS keychain
(`com.llmide.desktop`). Environment values win over `.dev-secrets.json`, so a file-only copy would
import a database whose vault cannot be decrypted. The host therefore:

1. reads the old `.dev-secrets.json` and backs up the current keychain values (owner-only, beside
   the DB backup);
2. stores the old JWT secret and vault key in the keychain;
3. runs the import;
4. restores the previous keychain values if the import does not complete.

Secrets are never logged, returned to the webview, or put in an error message.

## The command line

The same helper is a CLI (the desktop host runs this exact file from the staged core):

```sh
cd extension

# Read-only report (safe while the app runs)
node kb/legacy-import.mjs --status

# Import; refuses a non-empty desktop folder
node kb/legacy-import.mjs --import

# Replace a non-empty desktop folder (a verified backup is written first)
node kb/legacy-import.mjs --import --force

# One JSON report on stdout (the host contract)
node kb/legacy-import.mjs --status --json
```

`npm run import:legacy-data -- --status` is the same command from `extension/`.

Explicit paths (a copy of the old folder, tests, a moved library):

```sh
node kb/legacy-import.mjs --import \
  --legacy "$HOME/Library/Application Support/llm-ide/system" \
  --target "$HOME/Library/Application Support/llm-ide-desktop/core"
```

`LLMIDE_LEGACY_DATA_DIR` overrides the source and `LLMIDE_DESKTOP_DATA_DIR` the desktop data root
(the target is always `<root>/core`). Exit codes: `0` completed or no-op, `1` failed, `2` refused.

**CLI and the keychain.** The CLI copies `.dev-secrets.json` but cannot update the macOS keychain.
If the old data holds vault-encrypted secrets, the desktop app would still pass its old keychain key
to the core and the imported vault would not open. Use the Settings action on macOS for vault-bearing
data, or set the two keychain items yourself (`security add-generic-password -U -s com.llmide.desktop
-a jwt-secret -w`, then `-a vault-key`, with the values from the old `.dev-secrets.json`) before
starting the app. The CLI is the fallback for headless machines and for verifying a copy.

## What "verified" means

Before any switch, the helper checks:

- `PRAGMA quick_check` on the locked source and `PRAGMA integrity_check` on every snapshot;
- per-table row counts and `sqlite_sequence` against the locked source;
- the `schema_migrations` version on the source and the copy (and `agent_schema_migrations` for
  `agent.db`);
- the `.dev-secrets.json` bytes after the copy.

Then it stages everything in `core/.legacy-import/`, moves the old desktop files to
`core/.legacy-import-replaced/` (not deleted), and renames the new files into place with `data.db`
**last**. It fsyncs the files and the directory, then re-runs `integrity_check`, the row-count
fingerprint, the migration version and the secrets comparison on the committed files. Only after
that does it write the `core/legacy-import.json` marker and delete the replaced copies.
`data.db` is the commit point; every failure before the final marker removes the new files and puts
the old ones back.

The marker makes the import **idempotent**: with a completed marker and a healthy target `data.db`,
a second run is a no-op and changes no byte. A marker without a healthy target, or a leftover
`legacy-import.journal.json` from an interrupted run, refuses instead of importing again. To import
again deliberately, move the marker aside yourself and run with `--import --force` (that is the
"restore an older copy" path, not the normal one).

## Rollback

**Automatic on a failed import.** The files are restored to their previous bytes and the host
restores the previous keychain secrets. The verified backups remain in `core/backups/` as the safety
net; they are the only new files a failed attempt leaves behind.

**Manual, after a successful import.** Stop the desktop app (or press Stop backend), then:

```sh
cd "$HOME/Library/Application Support/llm-ide-desktop/core"
mv data.db data.db.imported
rm -f data.db-wal data.db-shm            # they belong to the old file
cp "backups/pre-import-<stamp>.db" data.db
sqlite3 data.db "PRAGMA integrity_check"  # must print: ok
```

Restore `agent.db` the same way from `backups/pre-import-<stamp>.agent.db` (remove its `-wal`/`-shm`
first). There are two secret backups from a successful run, both JSON with `jwtSecret` and
`vaultKey`:

- `backups/pre-import-<helper-stamp>.dev-secrets.json` — the old desktop `.dev-secrets.json` bytes;
  copy it back to `core/.dev-secrets.json`.
- the path in the report's `keychainBackup` (`backups/pre-import-<host-stamp>.dev-secrets.json`) —
  the values that were in the OS keychain when the import ran.

In Keychain Access, edit the `com.llmide.desktop` items `jwt-secret` and `vault-key` to the values
from the keychain backup; or use `security add-generic-password -U -s com.llmide.desktop -a
jwt-secret -w` and paste the value when prompted. Then start the app.

Anything written to the imported database after the import is not in the backup. Copy the current
`data.db` out first if you need it.

## Tests

- `extension/tests/legacy-import.test.mjs`: a valid folder imports and verifies; a second run is a
  no-op; a non-empty destination refuses without force; force backs up and replaces; a corrupt
  source is refused; WAL-resident rows import and the legacy WAL is not checkpointed; a
  post-commit failure rolls back; a source-snapshot failure never touches the destination; a target
  held by a writer refuses; a marker without a valid DB refuses; vault rows without a key refuse; no
  free space refuses; the CLI prints one JSON report. Temp dirs only.
- `desktop/src-tauri/src/legacy_import.rs`: path resolution per OS, report parsing, and the fixed
  dialog text.
- `ui/screens/settings/tests/legacy-import-model.test.ts`: decoding and the status card's wording.
