# Continuous integration

Every workflow runs on a push to `main` (and relevant pull requests). The push
is only trusted once the runs below are green.

| Workflow | Runner | What it proves | Typical duration |
|---|---|---|---|
| `extension-ci` | ubuntu-latest | `make test` (extension + core node tests), lint, type-check | 5-7 min |
| `desktop-ci` | ubuntu / windows / macOS | desktop node suites, `tsc`, `cargo test --lib`, capabilities/tokens checks | 10-12 min |
| `contract-ci` — `contract-gates` | ubuntu-latest | HTTP contract fixtures and coverage, Host API, relay vectors, generated types/OpenAPI/tokens | <1 min |
| `contract-ci` — `regression` | macos-latest | the full pre-push gate: graph-kit pin, contracts, desktop/ui/web node suites, agent/v2, graph-kit labs | 8-12 min |
| `docs-ci` | ubuntu-latest | `make docs-check` (spec values, citations, API coverage, user needs) | <1 min |
| `ios-ci` | macOS | `ios_app/SharedProtocol` build and tests | 2 min |
| `codeql` | ubuntu-latest | code scanning | 3-5 min |
| `skills-drift` | ubuntu-latest | the central skills submodule is installed and unchanged | 10 s |

`make regression` is the same command the pre-push hook runs locally; it needs
the Xcode toolchain (graph-kit is Swift), which is why its CI job is macOS.
Broad changes that touch only one surface still run the fast job for that
surface, so a stale generated file or a contract drift is caught in under a
minute.
