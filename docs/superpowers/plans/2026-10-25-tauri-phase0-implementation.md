# Implementation plan: Tauri Phase 0 proof of concept

**Date:** 2026-10-25
**Branch:** `spike/tauri-phase0` (throwaway — only the report merges to `main`)
**Parent plan:** [2026-10-24-tauri-desktop-and-relay.md](2026-10-24-tauri-desktop-and-relay.md) §6
**Execution:** Haiku 5.5 implements each task; Sonnet 5.5 reviews it; the
orchestrating session runs the final measurements and writes the report.

## Goal

A throwaway Tauri 2 app in `desktop/` that hosts the **existing** Node core and
the three hardest views (code graph, Monaco editor, terminal), plus a chat
streaming test, so §6's go/no-go table can be filled with measured numbers
against the Swift app on this Mac.

## Ground rules (every task)

- All new code lives under `desktop/`. Do **not** modify `extension/`, `mac/`,
  `ios_app/`, or any root config, except adding `desktop/` entries to the root
  `.gitignore` if needed.
- Tauri **2.x**, Rust stable (system rustc 1.84 via Homebrew), React 19 + Vite +
  TypeScript. The Tauri CLI is a **dev dependency** of `desktop/`
  (`@tauri-apps/cli`), never installed globally.
- Pin every dependency to an exact version.
- The Node core is started from the repo's `extension/server.mjs` with the
  system `node` (packaging is Task 6). The app must **never** start a second
  server writing the same DB: if `127.0.0.1:3456` already answers `/health`,
  adopt it (same rule as the Swift `BackendManager`); otherwise spawn with
  `LLMIDE_PORT=3457` and `LLMIDE_DB_PATH` pointing at a temp DB so the live
  `kb/data.db` is never touched.
- Each task ends with: `cd desktop && npm run build` (frontend) and
  `cargo build --manifest-path desktop/src-tauri/Cargo.toml` both green,
  `cargo clippy -- -D warnings` clean, plus the task's own check.
- Measurements a task adds print as one JSON line prefixed `BENCH ` to stdout
  (e.g. `BENCH {"name":"graph_fps_10k","value":61.2,"unit":"fps"}`), so the
  report task can collect them.

## Tasks

### T1 — Scaffold
`desktop/` with Tauri 2 + React + Vite + TS: `package.json` (scripts `dev`,
`build`, `tauri`), `vite.config.ts`, `src/main.tsx` with a tab bar
(Graph · Editor · Terminal · Chat · Bench), `src-tauri/` (Cargo.toml,
`tauri.conf.json`, `src/main.rs`, capabilities). `README.md` with run steps.
**Check:** `npm run tauri build -- --debug --bundles app` produces
`LLM-IDE Desktop PoC.app`.

### T2 — Node core host
Rust: on startup probe `http://127.0.0.1:3456/health` (2 s). Healthy → adopt.
Else spawn `node extension/server.mjs` (repo root resolved from the
executable's location or `LLMIDE_REPO_ROOT`) with `LLMIDE_PORT=3457`,
`LLMIDE_DB_PATH=<tmp>/poc.db`, `LLMIDE_ENGINE_PREWARM=0`; wait for `/health`
(20 s); kill the child on app exit (window close and quit). Expose a Tauri
command `core_status() -> {url, adopted, pid, ms_to_healthy}`. Status bar in
the UI.
**Check:** quit + relaunch leaves no orphan `node` (`pgrep -f poc.db` empty
after quit); `BENCH core_ms_to_healthy`.

### T3 — Code graph view (WebGL)
Load a graph JSON (`graph.schema.json` shape from
`mac/LocalPackages/graph-kit/schema/`) from a file picker or a generated
synthetic graph (10k nodes / 30k edges and 50k nodes / 150k edges, seeded).
Render with a WebGL library (sigma.js + graphology, exact versions). Layout:
use graph-kit's TypeScript implementation if it builds from
`mac/LocalPackages/graph-kit/typescript/`, else a ForceAtlas2 worker; layout
runs off the main thread. **Never prune edges.** FPS meter during a scripted
5 s pan/zoom.
**Check:** `BENCH graph_fps_10k`, `BENCH graph_fps_50k`, `BENCH graph_layout_ms_10k`.

### T4 — Editor view (Monaco)
Monaco (exact version) opening a generated 10k-line TypeScript file. Scripted
typing of 200 keystrokes; measure keystroke-to-paint latency
(`performance.now()` around `executeEdits` + `requestAnimationFrame`).
**Check:** `BENCH editor_keystroke_p50_ms`, `BENCH editor_keystroke_p95_ms`.

### T5 — Terminal view
xterm.js (exact version) + Rust `portable-pty`: Tauri commands to spawn the
user's shell, write input, resize; output streamed to the webview via a Tauri
`Channel` in batches. Scripted run of `yes | head -1000000`; measure total
time and the longest main-thread stall (long-task observer).
**Check:** `BENCH term_1m_lines_ms`, `BENCH term_max_stall_ms` (target < 100).

### T6 — Node sidecar packaging
Try packaging the core as a sidecar (`externalBin`): Node single-executable
application (SEA) of `extension/server.mjs`. Record exactly what works and
what blocks (ESM entry, the native `better-sqlite3` addon, lazy SDK import).
If SEA cannot work, fall back to bundling the `node` binary + `extension/`
as resources and document the size.
**Check:** a written result in `desktop/PACKAGING.md`; `BENCH bundle_bytes`.

### T7 — Chat streaming
A local SSE replay server (Rust or Node, in `desktop/`) that replays a fixed
recorded v2 event sequence (init, 2 000 deltas, tool events, usage, result)
at full speed; the Chat tab renders it and counts events.
**Check:** `BENCH chat_events_dropped` (= 0), `BENCH chat_events_duplicated`
(= 0), `BENCH chat_render_ms`.

### T8 — Bench tab + macOS accessibility probe
Bench tab runs T3–T5, T7 in sequence and shows the table. Rust probe (macOS
only): read the focused window's accessibility tree via the AX API at the
800 ms cadence and report read time; needs Accessibility permission, so it
reports `permission_denied` instead of failing.
**Check:** `BENCH ax_read_ms` or `{"ax":"permission_denied"}`.

### T9 — Report (orchestrator)
Measure cold start, idle memory (app + webview + node), installer size against
the Swift app; collect BENCH lines; write
`docs/superpowers/plans/2026-10-25-tauri-phase0-report.md` with the §6 table,
pass/fail per row, the rows that could not be measured here (Windows) and the
go/no-go recommendation.
