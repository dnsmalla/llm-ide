---
title: Maintain the database and restore a backup
applies_to: desktop, server
---

# Maintain the database and restore a backup

Two operations that used to be implicit are now explicit and bounded:

- **maintenance** — FTS5 segment merging (and a full optimize only on a small
  index) plus incremental vacuum for `data.db`;
- **restore** — putting a verified `data.db` + `agent.db` backup pair back,
  with a pre-restore snapshot and a rollback if anything fails.

Neither runs on a request path or at boot. The server's own backups now always
include `agent.db`.

## Backups are a pair

| What | Where |
|---|---|
| Main database | `<data dir>/data.db` |
| Agent history | `<data dir>/agent.db` |
| Automatic backup | `<data dir>/backups/data-<unix>.db` + `data-<unix>.agent.db` |
| `POST /admin/backup` | same pair (JSON reports `path`, `agentPath`, bytes) |
| `npm run backup` | `<out>` + `<out>.agent.db` when the sibling `agent.db` exists |

`LLMIDE_BACKUP_KEEP` (default 2) counts **pairs**. Retention matches
`data-<unix>(.agent)?.db`, groups the two files by the unix stamp, keeps the
newest N groups and deletes both files of an older group together. It still
refuses to prune a directory that holds any other file.

The desktop app's data dir is
`~/Library/Application Support/llm-ide-desktop/core`; the repository layout is
`<repo>/kb/`. Old backups made before this change have only `data-<unix>.db`;
restore them with `--backup` and no `--agent` (agent history stays as it is).

## Maintenance (bounded, explicit)

`extension/kb/maintenance.mjs` owns both operations:

- **FTS5**: the `search` index is merged with FTS5's `'merge'` command in
  batches (`--merge-pages`, default 500), up to `--pages` (default 4000) and
  `--ms` (default 5000). FTS5's merge leaves at most two segments; when the
  database is small (`optimizeMaxPages`, default 8000 pages) a full
  `'optimize'` runs to reach one segment. A large index keeps the bounded merge
  result — a full optimize of a huge index is not run behind the user's back.
- **Incremental vacuum**: `PRAGMA incremental_vacuum(N)` in slices, only when
  the database is already in `auto_vacuum = INCREMENTAL` mode. The pass never
  runs a full `VACUUM`.
- Every batch is its own short write transaction, and the pass yields to the
  event loop between batches. A chat/Loop/meeting run in flight stops the pass
  between batches (`409`-style `busy` in the report, not a failed request).
- Running it twice is safe: one segment and an empty freelist make it a no-op.

**While the desktop app/server runs** (admin only, same process, no second
writer):

```sh
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:3456/admin/maintenance?pages=4000&ms=5000'
```

The response is the report (`ok`, `fts.segmentsBefore/After`, `fts.pagesMerged`,
`vacuum.pagesFreed`, `bounded`, `notes`). `pages`, `mergePages`,
`vacuumPages` and `ms` can only lower the built-in caps.

**With the core stopped** (a second Node process must not write a live DB):

```sh
cd extension
LLMIDE_DATA_DIR="$HOME/Library/Application Support/llm-ide-desktop/core" \
  npm run maintain -- --pages 8000 --ms 15000
```

The CLI refuses while any other process has a write lock on the file. It prints
a human report, or one JSON object with `--json`. The desktop core's data dir is
the path above; from a checkout with no data dir, the repo `kb/` is used.

### Enabling incremental vacuum on an older database

New databases are created with `PRAGMA auto_vacuum = INCREMENTAL`. A database
created before that (including a database imported from the old Mac app) keeps
`auto_vacuum = 0`; the maintenance report says `vacuum.skipped:
"not-incremental"`. Switching needs a one-time full `VACUUM`, which is
deliberately not run automatically — it takes a long exclusive lock:

```sh
# Server/desktop core stopped, and after a fresh backup:
sqlite3 "$HOME/Library/Application Support/llm-ide-desktop/core/data.db" \
  "PRAGMA auto_vacuum = INCREMENTAL; VACUUM;"
```

Then `npm run maintain` can reclaim free pages incrementally.

## Restore a backup (verify, then replace)

Restoring replaces the live files, so **stop the desktop core first** (Settings
→ Server & Backend → Stop backend, or quit the app). The command refuses while
the database is held by another process.

```sh
cd extension
export LLMIDE_DATA_DIR="$HOME/Library/Application Support/llm-ide-desktop/core"
# 1. Verified dry run: prints the rows, schema versions and live paths; changes nothing.
npm run restore -- --backup "$LLMIDE_DATA_DIR/backups/data-<unix>.db" \
                  --agent  "$LLMIDE_DATA_DIR/backups/data-<unix>.agent.db"
# 2. The same with --yes actually restores.
npm run restore -- --backup "$LLMIDE_DATA_DIR/backups/data-<unix>.db" \
                  --agent  "$LLMIDE_DATA_DIR/backups/data-<unix>.agent.db" --yes
```

`--db` and `--agent-db` override the live paths (defaults: `config.dbPath` and
`config.agentDbPath`). `--json` prints one report.

What happens:

1. **Both** backups are verified before anything live moves: `integrity_check`
   and `quick_check`, at least one table, an applied `schema_migrations` version
   for `data.db`, and an `agent_runs` table for `agent.db`. An invalid backup is
   a refusal; the live files are untouched (including when only one half of the
   pair is bad).
2. The live files must be quiescent (`BEGIN IMMEDIATE`); a running core refuses
   with `live-in-use`.
3. Each live file is snapshotted to `<name>.pre-restore-<stamp>.db` and that copy
   is verified. Both backups are copied to staging files and verified again.
4. Only then do the live files move aside (`<name>.restore-replaced-<stamp>`,
   not deleted) and the staged copies are renamed in. Both are verified again.
5. Any failure removes the new files and moves the old ones back **for both
   halves**. The `pre-restore` snapshots stay as the safety net.

If only `--backup` is given, `agent.db` is not touched. To restore an older
backup that predates paired backups, restore `data.db` alone (agent history
from the newer install remains), or restore a separate `agent.db` snapshot.

## Tests

- `extension/tests/maintenance.test.mjs`: FTS segments merge to one on a small
  index, the page budget bounds a pass, a large index skips the full optimize,
  incremental vacuum frees pages and is repeatable, a non-INCREMENTAL DB
  reports the offline step, an in-flight run stops between batches.
- `extension/tests/backup-databases.test.mjs`: the pair is written and both
  files read back.
- `extension/tests/backup-retention.test.mjs`: the newest N pairs are kept and
  older pairs are deleted together.
- `extension/tests/restore-backup.test.mjs`: pair restore, corrupt data /
  corrupt agent refusal, pair-wide rollback after a replace, data-only restore,
  live-in-use refusal, and the CLI dry run.
- `extension/tests/scripts-backup.test.mjs`: `npm run backup` includes the
  sibling `agent.db`.
