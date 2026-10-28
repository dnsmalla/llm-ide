# Where the server keeps its global data, and how to roll back

The server's per-install data (shared by every user and project on the machine)
lives in one directory. Set it with `LLMIDE_DATA_DIR`:

| File | Default (no `LLMIDE_DATA_DIR`) | With `LLMIDE_DATA_DIR=<dir>` |
|---|---|---|
| `data.db` (+ `-wal`, `-shm`) | `<repo>/kb/data.db` | `<dir>/data.db` |
| `agent.db` (agent history) | beside `data.db` | `<dir>/agent.db` |
| `.dev-secrets.json` (JWT and vault keys) | `<repo>/kb/` | `<dir>/` |
| `backups/data-<unix>.db` (newest 2 kept) | beside `data.db` | `<dir>/backups/` |
| `agent-sdk/<userId>/` | beside `data.db` | `<dir>/agent-sdk/` |
| `server.log` (+ `.old`) | `extension/kb/server.log` | `<dir>/server.log` |

Individual variables still win: `LLMIDE_DB_PATH`, `LLMIDE_AGENT_DB_PATH`,
`LLMIDE_BACKUP_DIR`, `LLMIDE_LOG_FILE`. Under the Node test runner
`LLMIDE_DATA_DIR` is ignored, and tests keep their temp database.

**An explicit `LLMIDE_DB_PATH` puts the companions beside that DB.** `agent.db`,
`backups/` and `agent-sdk/` are then derived from its directory, not from
`LLMIDE_DATA_DIR`. The location reports `custom`.

## The Mac app

A backend the app spawns gets `LLMIDE_DATA_DIR=~/Library/Application Support/llm-ide/system`
(created `0700`). The inherited `LLMIDE_DATA_DIR`, `LLMIDE_DB_PATH` and
`LLMIDE_AGENT_DB_PATH` are dropped. A server the app *adopts* (one already
listening on the port) keeps its own environment.

`LLMIDE_USE_REPO_KB=1` keeps the old location for development: no data dir is
passed, and the backend uses `<repo>/kb/`.

## The one-time MOVE

On boot, before the server listens, the server **moves** the repo's `kb/` data
into the data dir. It runs only when `LLMIDE_DATA_DIR` is set, `LLMIDE_DB_PATH`
is not, `<dir>/data.db` does not exist yet, and `<repo>/kb/data.db` does.

1. **The legacy DB is locked first.** The move takes an EXCLUSIVE lock on
   `kb/data.db`. That fails while *any* other connection has the file open,
   idle server connections included. If the lock fails, nothing moves: the run
   uses `<repo>/kb/` and the boot log says `legacy-in-use`.
2. `data.db` and `agent.db` are snapshotted with `VACUUM INTO`, which includes
   rows still in the WAL. The new copy must pass `PRAGMA integrity_check` and
   match the per-table row counts of the locked source.
3. The dev secrets (the vault key) are staged byte-for-byte with mode `0600`.
   Without them every vault-encrypted secret (API keys, connector tokens) is lost.
   If the legacy vault holds secrets but the key file is missing and
   `LLMIDE_VAULT_KEY` is not set, the move refuses.
4. `agent-sdk/` is moved only up to **200 MB**. Above that it stays in
   `<repo>/kb/agent-sdk/`, with a log line and a `storage.notes` entry.
5. The staged files are committed by rename, `data.db` last. The committed
   `data.db` is re-opened and its row counts are compared again.
6. **Only then are the legacy copies deleted**, while the legacy DB is still locked:
   `data.db`, `data.db-wal`, `data.db-shm`, `agent.db` (and its `-wal`/`-shm`),
   `.dev-secrets.json` (only when its bytes match the new copy), and `agent-sdk/`
   (when it was moved).
7. `<repo>/kb/MOVED-TO-APP-SUPPORT.txt` is written, saying what moved and that
   there is no automatic rollback.

**`backups/` is never moved and never deleted.** Old backups stay in
`<repo>/kb/backups/`. Delete them by hand once you have checked the new location.
`/health` lists this in `storage.notes`.

Any failure before step 6 rolls the commit back, keeps every legacy file, and
uses the legacy location for this run. A failure during step 6 keeps the new,
verified copy. `storage.notes` then says which legacy files remain.

The outcome is logged as `data_location` at boot. `GET /health` reports
`storage: {location, migration, legacyDiverged, notes}`, with no paths.

## Backups and retention

The server backs up the live DB every 24 hours (`LLMIDE_BACKUP_INTERVAL_HOURS`),
and on `POST /admin/backup`. It keeps the **newest 2** backups
(`LLMIDE_BACKUP_KEEP`, default 2, minimum 1) and deletes older ones. Retention
only deletes regular files named `data-<unix>.db` in the backup directory. Other
files and subdirectories are never touched.

`npm run backup` (in `extension/`) makes a one-off copy of the live DB. Its output
names the location: `source=<path> (location: system|repo-kb|custom)`. Those
copies are not subject to the keep-2 rule.

## Forks

The move removes the legacy DB, so a legacy `data.db` that exists again after the
move means something recreated it: an older server, or a dev server on the legacy
kb that was adopted by the app. Its writes never reach the data dir, and the data
dir's writes never reach it. Each boot checks for this: `/health` reports
`storage.legacyDiverged: true` and the boot logs `legacy_kb_diverged` once.

If you see that, stop the server that uses the legacy kb, and decide which copy holds
the data you want. Then follow the rollback steps below.

## Rolling back (manual, not automatic)

The move **deletes the legacy database**. There is no automatic way back. To go
back, restore a backup:

1. **Stop every server** using either location. Check that nothing answers on
   port 3456 (`lsof -i :3456`), and quit the Mac app.
2. **Pick a backup.** The newest two are in `<dir>/backups/data-<unix>.db`. Older
   ones may remain in `<repo>/kb/backups/`. Anything written after the backup you
   pick is lost, unless it is still in `<dir>/data.db`.
3. **Put it in place** (keep the current file so you can undo this):

   ```sh
   cd "<dir>"
   mv data.db data.db.before-restore
   rm -f data.db-wal data.db-shm            # they belong to the old file
   cp "backups/data-<unix>.db" data.db
   sqlite3 data.db "PRAGMA integrity_check"   # must print: ok
   ```

4. **To run the old layout instead**, put the file at `<repo>/kb/data.db` (remove
   its `-wal`/`-shm` first) and start the server with `LLMIDE_USE_REPO_KB=1`.

Copying raw `-wal` or `-shm` files from another location is not safe: a stale
WAL is replayed onto the new file. Always remove them first, as above.

## Tests

- `extension/tests/data-dir.test.mjs`: precedence (individual vars, test isolation,
  `LLMIDE_DATA_DIR`, `LLMIDE_DB_PATH` companions, defaults, migration decision).
- `extension/tests/data-dir-migration.test.mjs`: the move (WAL rows, legacy files
  removed, backups left), refusals (idle and write-lock holders), failed
  verification or post-commit check (nothing deleted), dev secrets (a vault value
  decrypts after the move), the agent-sdk cap, forks, interrupted runs.
  Temp dirs only.
- `extension/tests/backup-retention.test.mjs`: keep-2, matching-files-only, minimum 1.
- `extension/tests/dev-secrets.test.mjs`: fallback to the legacy file, and refusal
  to regenerate over an unreadable one.
- `mac/Tests/LlmIdeMacTests/BackendChildEnvironmentTests.swift` and
  `BackendReadinessBudgetTests.swift`: child environment, `0700` dir, and the 90 s
  first-launch budget.
