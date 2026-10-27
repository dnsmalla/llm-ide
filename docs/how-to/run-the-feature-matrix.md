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

**Mac** (only with `--mac`, slow): `swift build --manifest-cache none` with the
row's `LLMIDE_FEATURES` and its own `--scratch-path mac/.build-fm-<row>`, or
`make build-mac-<quadrant>` for the three quadrants. Each full build takes
minutes; the first run per row is a cold build.

Routes owned by `doc_gen` (`/generate-doc`, `/generate-docx`) are not gated:
the Chrome extension calls them. So `doc_gen` off leaves the server's routes
unchanged, and only its Mac build changes.

## Commands

```bash
make feature-matrix                                  # every row, server side (~40 s)
node scripts/feature-matrix.mjs --key doc_gen        # one row, server side
node scripts/feature-matrix.mjs --key doc_gen --mac  # one row, plus its Mac build
make feature-matrix FM_ARGS="--all --mac"            # everything, including Mac builds
```

With no `--key`, the script runs every row. Exit status is 1 when any row fails.
The summary table names the failing rows, and the per-row lines above it give
the first problems. A failing Mac build writes its full log to the system temp
directory and names the path.

Run the server rows with local listen permission (the sandbox must allow
`127.0.0.1` binding).

## When it runs

- **Nightly**: `.github/workflows/feature-matrix.yml` runs the server rows on
  Ubuntu at 03:23 UTC.
- **Manually**: `workflow_dispatch` with `mac: true` also runs every Mac row on
  `macos-15`.
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
