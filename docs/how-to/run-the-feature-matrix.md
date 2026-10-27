# Run the feature matrix

The feature matrix checks that every removable Mac feature can be switched off
without breaking the server or the Mac build. It runs each excludable feature
key off on its own, plus the closure row and the three reduced builds.

## Rows

| Row | `LLMIDE_FEATURES` is every key minus | Also off by closure |
|---|---|---|
| `code_graph_3d`, `gantt_issues`, `terminal`, `doc_gen`, `mobile_sync`, `auto_tasks` | that key | — |
| `closure:file_explorer` | `file_explorer` | `code_graph_3d`, `gantt_issues`, `doc_gen` |
| `lite`, `min`, `mobile-only` | the `build-mac-*` quadrant selections | as the closure requires |

`file_explorer` cannot be switched off alone without its three dependents, so
`closure:file_explorer` is its row. `agent_chat` is always on.

## What each row checks

**Server** (every row, Linux or macOS): the script starts `extension/server.mjs`
on a free port with a temp DB (never `kb/data.db`) and `LLMIDE_FEATURES` set to
the row's list, then asserts:

1. `/health` `features` equals the closed enabled set.
2. `/health` `endpoints` equals `ALL_ENDPOINTS` minus the disabled groups'
   routes (groups from `extension/routes/feature-routes.mjs`).
3. Every route of a disabled group answers `404 {"error":"feature_disabled","feature":<key>}`
   to an authenticated request.
4. Every path in the extension's `REQUIRED_ENDPOINTS` (`src/sidepanel/App.tsx`)
   is advertised. This holds for every row: no endpoint the side panel calls is
   feature-owned, so the panel never reports a pruned server as stale.
5. The live contract test passes in assert mode. `extension/tests/http-contract-live.test.mjs`
   with `CONTRACT_EXPECT_DISABLED=1` and `CONTRACT_FEATURES=<list>` expects
   `404 feature_disabled` for fixtures of disabled routes instead of skipping them.

**Mac** (only with `--mac` or `--mac-only`, slow): `swift build --manifest-cache none`
with the row's `LLMIDE_FEATURES` and its own `--scratch-path mac/.build-fm-<row>`, or
`make build-mac-<quadrant>` for the three quadrants. The `swift build` rows get
the same `DEVELOPER_DIR` and `SDKROOT` the Makefile pins (the system-selected
Xcode and its macOS SDK), so they use the same toolchain as `make regression`.
Each full build takes minutes; the first run per row is a cold build.
`--mac-only` runs only this side (no server or live rows).

`doc_gen` owns `/generate-doc` (the Mac's Doc Gen is its only caller), so with
`doc_gen` off that path answers `404 feature_disabled` and `/health` omits it.
`/generate-docx` is not gated: the Chrome extension's ExportMenu calls it, so
it stays on whatever the feature set.

## Commands

```bash
make feature-matrix                                  # every row, server side (~30 s)
node scripts/feature-matrix.mjs --key doc_gen        # one row, server side
node scripts/feature-matrix.mjs --key doc_gen --mac  # one row, plus its Mac build
make feature-matrix FM_ARGS="--all --mac-only"       # every Mac build, no server rows
make feature-matrix FM_ARGS="--all --mac"            # everything, including Mac builds
```

With no `--key`, the script runs every row. Exit status is 1 when any row fails.
The summary table names the failing rows, and the per-row lines above it give
the first problems. A failing Mac build writes its full log to the system temp
directory and names the path.

A server that fails to boot fails only its own row: the reason (the child's
output tail) is printed, the row is marked failed, and the remaining rows still
run. Each server is stopped with SIGTERM and SIGKILLed after 5 seconds, and its
temp directory is removed on every path. Ctrl-C (SIGINT/SIGTERM) stops any
running servers and removes their temp directories too.

The server environment is built from the operator's environment with every
`LLMIDE_*`, `ANTHROPIC_*`, `NODE_TEST_CONTEXT` and `NODE_ENV` variable removed,
then the matrix's own settings are added. The live contract test gets the same
cleaned environment, so a developer's shell settings cannot change a row.

Run the server rows with local listen permission (the sandbox must allow
`127.0.0.1` binding).

The pure logic (the closure, the row table, the quadrant selections checked
against the Makefile's `build-mac-*` lines, the environments, argument parsing)
is unit-tested in `extension/tests/feature-matrix.test.mjs`, which `make test`
runs. It boots no servers.

Test hook: `FM_SERVER_ENTRY=<file>` replaces `server.mjs` as the booted entry.
Point it at a missing file to force every row's boot to fail and check the
boot-failure summary and cleanup.

## When it runs

- **Nightly**: `.github/workflows/feature-matrix.yml` runs the server rows on
  Ubuntu at 03:23 UTC, with a 15-minute timeout. The workflow has
  `permissions: contents: read`.
- **Manually**: `workflow_dispatch` with `mac: true` also runs every Mac row on
  `macos-15` (`--mac-only`, 120-minute timeout). No SwiftPM cache is used.
- **Failures**: a failed scheduled run triggers GitHub's default
  workflow-failure email. The workflow opens no issue and needs no
  `issues: write`.
- **Per change**: not in `make regression` (it boots about ten servers and the
  Mac rows are slow). When a change touches a feature's routes or closure, run
  `--key <row>` for that row. That covers the kit-local check.

## Adding a feature key

1. Add the key to `FEATURE_KEYS` in `extension/core/config.mjs` and to
   `EXCLUDABLE` in `scripts/feature-matrix.mjs`.
2. If it owns a route group, add the group in `extension/routes/feature-routes.mjs`.
   The matrix then covers its routes automatically. A group whose prefix matches
   no `ALL_ENDPOINTS` entry fails the row.
3. Add the `REQUIRES` entry in both `config.mjs` (`FEATURE_REQUIRES`) and
   `scripts/feature-matrix.mjs` if the key needs another feature.
4. Add the key's `build-mac-*` quadrant row only if a new reduced build is added to the Makefile.

See also [run the token bench](run-the-token-bench.md) for the other nightly gate.
