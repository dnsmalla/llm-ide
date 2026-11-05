# Integration and app-link verification matrix

Date: 2026-11-05. Scope: every pipeline / cross-app link test that exists in this repository, run from a clean
`main`. **No desktop feature work was started.**

## Result

All available automated integration gates pass. No source fixes were needed for this run.

| Link / pipeline | Command | Result |
|---|---|---|
| Core HTTP + KB pipeline | `make test` | **4899 tests, 4895 pass, 0 fail, 4 skipped** |
| Extension production build | `cd extension && npm run build` | pass |
| Plan → risks → code → dispatch pipeline | `node --test tests/plan-pipeline.test.mjs` | **27 pass** |
| Memory round-trip through the core | `node --test tests/memory-roundtrip-e2e.test.mjs` | **7 pass** |
| Core Host API v1 | `node --test tests/host-api-e2e.test.mjs` | **3 pass** |
| MCP end-to-end | `node --test tests/mcp-e2e.test.mjs` | **1 pass** |
| Agent-v2 act/tool loop | `node --test tests/agent-v2-act-tool-e2e.test.mjs` | **4 pass** |
| DeepSeek-compatible stream | `node --test tests/deepseek-e2e-stream.test.mjs` | **4 pass** |
| Desktop UI + host + real core | `cd desktop && npm test` | **2070 pass** |
| Rust host | `cargo test --lib` | **512 pass, 4 ignored** |
| Web client | `cd web && npm test` | **67 pass** |
| Web ↔ real core Host API | `cd web && npm run test:e2e` | **3 pass** |
| Web production build + PWA stamp | `cd web && npm run build` | pass |
| Mac app ↔ core, Host API TLS, mobile bridge, index reconciler | `make test-mac` | **1077 tests in 136 suites pass** |
| Host API v1 conformance | `make host-api-check` | **12 commands, 7 events** |
| Shared Mac/iOS protocol | `make test-shared-protocol` | **85 tests in 15 suites pass** |
| iOS app compile/link | `xcodebuild ... -scheme MyApp -sdk iphonesimulator build` | **BUILD SUCCEEDED** |
| Contract labs | `make regression` | pass (API, Chat, Generation, Graph, Loop, feature gates, contract gates, Mac builds, Mac tests) |

`make regression` completed with exit 0, including the API contract lab (144 decoded fixtures, 97 routed
endpoints), chat/generation/loop contract labs, feature gates, and the two reduced Mac builds.

## What "pipeline" covers here

- capture/source ingestion and KB writes through the extension/server tests;
- plan pipeline (`generate-plan` → risks → code → dispatch → outcome-adjacent paths);
- memory round-trip;
- Agent v2 tool/act loop;
- MCP calls;
- DeepSeek-compatible streaming;
- core HTTP contract conformance and fixtures.

## App links covered

- Mac app → core (Swift test suite, Host API TLS listener).
- Desktop → core (real-core shell E2E, chat write-through/replay, first run).
- Web → desktop Host API (real core pair/chat/approval E2E).
- Mac ↔ iOS shared wire types and iOS app build.
- Host API contract (commands/events) across Mac and desktop.

## Gaps that are not automated here

These are real-window or external-environment checks, not failing tests:

1. Two Claude SDK live tests are skipped (`live: streaming query calls kb_search end-to-end`,
   `live: AskUserQuestion round-trip through the real SDK engine`) because no live SDK/API environment is configured.
2. No browser-level Chrome extension test against real Meet/Teams/Zoom caption DOM. The extension unit/render
   tests pass, but selector drift only fails in a real browser.
3. No automated PWA install/offline test.
4. No real phone pairing over the TLS/Tailscale path; only the shared protocol and iOS build are verified.
5. No desktop or Mac real-window run in this matrix.

## How to re-run

```bash
make test
make test-desktop
make test-mac
make test-shared-protocol
make host-api-check
make regression
(cd web && npm test && npm run test:e2e && npm run build)
(cd extension && npm run build)
```

The six extension E2E files can be run individually with `node --test --experimental-strip-types --test-timeout=180000 <file>`.
