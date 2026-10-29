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

1. **Lock.** The run takes `<dir>/.migrating-lock` (a directory created
   atomically, holding the owner's pid). A lock held by a live process makes this
   run wait, for up to 200 s, then re-check. A lock whose pid is dead is stale and
   is taken over. The "data.db exists?" check is repeated under the lock. Nothing
   is wiped while another live process holds the lock. If the wait runs out, this
   run uses the legacy location and changes nothing (`lock-timeout`).
2. **Free space.** The data dir's volume needs at least twice the bytes of the
   legacy `data.db` and `agent.db`. Otherwise nothing is written (`no-space`).
3. **Lock the legacy DB.** The move takes an EXCLUSIVE lock on `kb/data.db` and
   keeps it for the whole move. That fails while *any* other connection has the
   file open, idle server connections included. If it fails, nothing moves
   (`legacy-in-use`).
4. `data.db` and `agent.db` are snapshotted with `VACUUM INTO`, which includes
   rows still in the WAL. The new copy must pass `PRAGMA integrity_check`, and
   match the per-table row counts and `sqlite_sequence` of the locked source.
5. The dev secrets (the vault key) are staged byte-for-byte with mode `0600`.
   Without them every vault-encrypted secret (API keys, connector tokens) is lost.
   If the legacy vault holds secrets but the key file is missing and
   `LLMIDE_VAULT_KEY` is not set, the move refuses.
6. `agent-sdk/` is moved only up to **200 MB**. It is copied with verbatim
   symlinks, and its file list, sizes and link targets are checked before the
   original is touched. Above the cap it stays in `<repo>/kb/agent-sdk/`, with a
   log line and a `storage.notes` entry.
7. The staged files are committed by rename, `data.db` last. The committed files
   are fsynced and checked again: a full `integrity_check`, the same counts and
   `sqlite_sequence`, the secrets bytes, and the agent-sdk manifest. Any failure
   up to here rolls the commit back and keeps every legacy file.
8. **Grace step.** The legacy WAL is checkpointed, then the legacy files are
   renamed, not deleted: `data.db.pre-move`, `agent.db.pre-move`,
   `.dev-secrets.json.pre-move` and `agent-sdk.pre-move`, all in `<repo>/kb/`.
   `<repo>/kb/MOVED-TO-APP-SUPPORT.txt` is written last.
9. **Next boot.** The first server boot after the move that opens the new DB
   healthily deletes the `.pre-move` files and logs `data_move_grace_completed`.
   The boot that did the move never deletes them. If anything is off, the files
   are kept and the boot logs `data_move_grace_kept`.

**So the originals exist for exactly one boot.** After that boot there is one copy
(the new one) plus the backups. If that next boot looks wrong, do not start it
again: restore from the `.pre-move` files (see the rollback steps below).

**Power loss.** Node has no `F_FULLFSYNC`, so the fsync here is a plain `fsync`.
On macOS a plain fsync does not force the drive's cache out. A power cut right
after the move can therefore lose the new copy. The `.pre-move` files are the
protection: they exist until the next healthy boot.

**`backups/` is never moved and never deleted.** Old backups stay in
`<repo>/kb/backups/`. Delete them by hand once you have checked the new location.
`/health` lists this in `storage.notes`.

A failure during the grace step keeps the verified new copy and says what is left
in `storage.notes`.

The outcome is logged as `data_location` at boot. `GET /health` reports
`storage: {location, migration, legacyDiverged, notes}`, with no paths.

## The tripwire: the repo kb after a move

After a move, `<repo>/kb/MOVED-TO-APP-SUPPORT.txt` exists and `<repo>/kb/data.db`
does not. Starting the server on the repo kb then (`npm run server`, an older
build, an adopted dev server) would create an empty DB and fresh secrets there.
So the server **refuses to start** in the repo-kb layout, with a message on what to
do: run with `LLMIDE_DATA_DIR=<dir>` (the Mac app does this), or restore
`kb/data.db`. `LLMIDE_ALLOW_EMPTY_LEGACY=1` overrides it. The Mac app's
adopted-server path is unchanged.

The refusal happens before any file is written: `core/config.mjs` also applies
the tripwire before it resolves dev secrets, so any process that imports config
(not only `server.mjs`) fails without creating `kb/.dev-secrets.json`. Test runs
(`NODE_TEST_CONTEXT`) use in-memory throwaway secrets and never read or write a
secrets file. `tests/moved-repo-kb-boot.test.mjs` asserts the kb listing is
unchanged after a refused boot. A spawned server with a custom `LLMIDE_DB_PATH` and
both secrets in its environment writes nothing to the repo kb, so the tripwire
lets it through.

## Forks

After the move, a legacy `data.db` that exists again, together with the MOVED
notice, means something recreated it: an older server, or a dev server on the
legacy kb that was adopted by the app. Its writes never reach the data dir, and the
data dir's writes never reach it. Each boot checks for this: `/health` reports
`storage.legacyDiverged: true` and the boot logs `legacy_kb_diverged` once.

## Backups and retention

The server backs up the live DB every 24 hours (`LLMIDE_BACKUP_INTERVAL_HOURS`),
and on `POST /admin/backup`. It keeps the **newest 2** backups
(`LLMIDE_BACKUP_KEEP`, default 2, minimum 1) and deletes older ones.

Retention runs only where the server owns the directory:

- **system layout** (`LLMIDE_DATA_DIR`): the data dir's `backups/`.
- **custom layout** (an explicit `LLMIDE_DB_PATH`): only with both an explicit
  `LLMIDE_BACKUP_DIR` and an explicit `LLMIDE_BACKUP_KEEP`.
- **repo-kb layout** (`LLMIDE_USE_REPO_KB`, the fallbacks, `npm run server`):
  **never**. The repo's `kb/backups/` holds the old copies and anything else.

Even then, a directory holding any other regular file is not pruned, and
subdirectories are never touched. Only `data-<unix>.db` files are ever deleted.

`npm run backup` (in `extension/`) makes a one-off copy of the live DB. Its output
names the location: `source=<path> (location: system|repo-kb|custom)`. Those
copies are not subject to the keep-2 rule.

## Rolling back

The move keeps the originals for one boot only (`.pre-move`). After the next
healthy boot they are deleted. So:

- **If the first boot after the move went wrong** (before the next healthy boot):
  stop every server, then restore the `.pre-move` files:

  ```sh
  cd "<repo>/kb"
  mv data.db.pre-move data.db
  mv agent.db.pre-move agent.db 2>/dev/null
  mv .dev-secrets.json.pre-move .dev-secrets.json 2>/dev/null
  rm -rf agent-sdk && mv agent-sdk.pre-move agent-sdk 2>/dev/null
  rm -f MOVED-TO-APP-SUPPORT.txt
  ```

  Then start with `LLMIDE_USE_REPO_KB=1`. Anything written to the data dir during
  that boot is not in these files; copy `<dir>/data.db` out first if you need it.
- **After the `.pre-move` files are gone**, there is no automatic way back. Restore
  a backup: stop every server, then

  ```sh
  cd "<dir>"
  mv data.db data.db.before-restore
  rm -f data.db-wal data.db-shm            # they belong to the old file
  cp "backups/data-<unix>.db" data.db
  sqlite3 data.db "PRAGMA integrity_check"   # must print: ok
  ```

  Pick the newest backup, or one from `<repo>/kb/backups/`. Anything written after
  it is lost. Copying raw `-wal` or `-shm` files from another location is not safe:
  a stale WAL is replayed onto the new file. Always remove them first.

## Tests

- `extension/tests/data-dir.test.mjs`: precedence (individual vars, test isolation,
  `LLMIDE_DATA_DIR`, `LLMIDE_DB_PATH` companions, defaults, migration decision).
- `extension/tests/data-dir-migration.test.mjs`: the move (WAL rows, `.pre-move`
  grace and its deletion on the next boot, `sqlite_sequence`, symlinks), refusals
  (idle and write-lock holders, a live lock, no space), failed verification or
  post-commit check (rolled back, nothing deleted), a grace-step failure, the
  zero-byte `data.db`, dev secrets (a vault value decrypts after the move), the
  agent-sdk cap, forks, the tripwire, a deferred SIGTERM, interrupted runs, and two
  concurrent runs in child processes. Temp dirs only.
- `extension/tests/backup-retention.test.mjs`: keep-2, matching files only, the
  prune policy, the foreign-file refusal, minimum 1.
- `extension/tests/dev-secrets.test.mjs`: fallback to the legacy file, and refusal
  to regenerate over an unreadable one.
- `mac/Tests/LlmIdeMacTests/BackendChildEnvironmentTests.swift` and
  `BackendReadinessBudgetTests.swift`: child environment, `0700` dir, and the 240 s
  first-launch budget.
