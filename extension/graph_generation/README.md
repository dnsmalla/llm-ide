# Graph generation

How LLM-IDE gets its graphs.

- **Generator.** The desktop host runs graph-kit's TypeScript CLI (`graph-kit/bin/graph-kit.js`, the
  `graph-kit/` submodule; bundled into the app by `desktop/scripts/stage-core.mjs`) from
  `desktop/src-tauri/src/graph_gen.rs`. Modes: `code` scans the project, `memory` scans `llm-doc/`, `all`
  merges both. It writes the canonical `system/graph/graph.json`.
- **Contract.** The document shape is graph-kit's
  [`schema/graph.schema.json`](../../graph-kit/schema/graph.schema.json).
- **Core side.** `extension/graphkit/` (graph model, memory writer, project paths) is what the planner and
  code sync read.
- **Layout.** The Graph screen (`ui/screens/graph/`) lays graphs out with graph-kit's Rust kernel, vendored
  as WASM in `ui/screens/graph/wasm/` (`node scripts/vendor-graph-layout-wasm.mjs`).

graph-kit is a separate repository; changing it is a commit there plus a pin bump here
([`docs/how-to/graph-kit-workflow.md`](../../docs/how-to/graph-kit-workflow.md)).

The pluggable Swift `GraphEngine` contract (engine plugins with a `graph-engine.json`, the `// UNPLUG:`
lines in the Mac app's `Package.swift`) went with the Swift Mac app on 2026-11-06; it is in git history
before that date.
