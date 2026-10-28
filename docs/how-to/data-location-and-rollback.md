# Where the server keeps its global data, and how to roll back

The server's per-install data (shared by every user and project on the machine)
lives in one directory. Set it with `LLMIDE_DATA_DIR`:

| File | Default with no `LLMIDE_DATA_DIR` | With `LLMIDE_DATA_DIR=<dir>` |
|---|---|---|
| `data.db` (+ `-wal`, `-shm`) | `<repo>/kb/data.db` | `<dir>/data.db` |
| `agent.db` (agent history) | beside `data.db` | `<dir>/agent.db` |
| `backups/` | beside `data.db` | `<dir>/backups/` |
| `agent-sdk/<userId>/` | beside `data.db` | `<dir>/agent-sdk/` |
| `server.log` (+ `.old`) | `extension/kb/server.log` | `<dir>/server.log` |

Each individual variable still wins over `LLMIDE_DATA_DIR`: `LLMIDE_DB_PATH`,
`LLMIDE_AGENT_DB_PATH`, `LLMIDE_BACKUP_DIR`, `LLMIDE_LOG_FILE`. Under the Node
test runner `LLMIDE_DATA_DIR` is ignored and tests keep their temp database.

## The Mac app

A backend the app spawns gets `LLMIDE_DATA_DIR=~/Library/Application Support/llm-ide/system`
(created `0700`). Any `LLMIDE_DATA_DIR`, `LLMIDE_DB_PATH` or `LLMIDE_AGENT_DB_PATH`
inherited from the app's launch environment is dropped. A server the app
*adopts* (one already listening on the port) keeps its own environment.

Developers who want the old checkout location launch the app with
`LLMIDE_USE_REPO_KB=1`. Then no data dir is passed and the backend uses `<repo>/kb/`.

## The one-time copy

On boot the server copies the repo's `kb/` into the data dir when all of these hold:
`LLMIDE_DATA_DIR` is set, `LLMIDE_DB_PATH` is not, `<dir>/data.db` does not exist yet,
and `<repo>/kb/data.db` does.

- `data.db` and `agent.db` are snapshotted with `VACUUM INTO`, which includes
  rows still in the WAL. The copy must pass `PRAGMA integrity_check` and match the
  source's per-table row counts.
- `backups/` and `agent-sdk/` are copied as files (skipped with a log line above 2 GB).
- The copy is staged in `<dir>/.migrating` and committed by rename, with `data.db` last.
- `<dir>/migrated-from.json` records the source, time and table counts.
- If the legacy DB is locked by another process (a running server), or any step fails,
  the partial copy is removed and this run uses `<repo>/kb/`. The next boot retries.
- **The legacy files are never moved or deleted.**

The outcome is logged as `data_location` at boot and reported as
`storage: {location, migration}` in `GET /health` (no paths).

## Rolling back to an older server

Older servers read `<repo>/kb/`. Those files are the copy made at migration time, so
data written to the system dir afterwards is not in them. To return to the repo
location, launch the app with `LLMIDE_USE_REPO_KB=1` (or run the server with no
`LLMIDE_DATA_DIR`). To keep the newer data, copy `<dir>/data.db` (and `agent.db`)
over the repo files while no server is running. Use the SQLite online backup, or
stop the server first, and keep the old files until you have checked the result.

## Tests

- `extension/tests/data-dir.test.mjs`: precedence (individual vars, test isolation,
  `LLMIDE_DATA_DIR`, defaults, migration decision).
- `extension/tests/data-dir-migration.test.mjs`: WAL rows, idempotence, partial failure
  (fallback, nothing left behind), a locked legacy DB, skip conditions. Temp dirs only.
- `mac/Tests/LlmIdeMacTests/BackendChildEnvironmentTests.swift`: the child environment
  sets `LLMIDE_DATA_DIR`, drops inherited data locations, and creates the dir `0700`.
