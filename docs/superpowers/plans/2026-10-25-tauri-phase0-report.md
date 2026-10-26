# Tauri Phase 0 — proof-of-concept report

**Date:** 2026-10-26
**Branch:** `spike/tauri-phase0` (code stays on the branch; only this report is for `main`)
**Plans:** [parent §6](2026-10-24-tauri-desktop-and-relay.md) ·
[implementation](2026-10-25-tauri-phase0-implementation.md)
**Machine:** MacBook (Apple Silicon, arm64), macOS 26.6.2, 60 Hz display
(measured 16–17 ms frame), Rust 1.84.1, Node 22.23.1, Tauri 2.11.6.

## Recommendation: GO, with four conditions

Every view the plan called hardest renders fast enough in Tauri on this Mac,
the existing Node core runs unchanged inside the app, and the app can match
the Swift app's look. Proceed to Phase 1 on these conditions, each already
measured below:

1. **Graph layout moves off the webview** (Rust native or WASM). Rendering is
   fine; ForceAtlas2 layout inside WKWebView is 4–7× slower than the same code
   in Node.
2. **Do not bundle the Agent SDK's `claude` binary.** Use the user's installed
   CLI. Installer drops from 160 MB to 67 MB.
3. **Chat renders incrementally** (finished markdown blocks memoised, commits
   time-sliced) — already implemented in the PoC; keep it.
4. **Monaco's vendored DOMPurify** (critical advisories) is patched or Monaco
   upgraded before any untrusted markdown is shown in the editor.

Windows and Linux were not measured; Phase 1 should include one Windows run of
the same autobench before the Swift feature freeze takes effect.

## §6 go/no-go table

| Test | Target | Measured | Result |
|---|---|---|---|
| Cold start to visible window | ≤ Swift + 0.5 s | 0.26–0.37 s warm, 1.3 s first launch | ✅ (Swift not re-measured — see open items) |
| Idle memory (shell + webview + core) | ≤ 1.3 × Swift | 146 MB (app 35 + WebKit 111) vs Swift 123 MB *without* its own WebKit helpers → ≤ 1.19× | ✅ |
| Code graph 10k nodes / 30k edges | ≥ 60 fps (Mac) | 59.8 fps (display cap 60) | ✅ |
| Code graph 50k nodes / 150k edges | ≥ 30 fps (Mac) | 50.9–56.5 fps | ✅ |
| Real project graph (633 files, 894 calls) | — | 59.9 fps | ✅ |
| Monaco typing, 10k-line file | < 16 ms per keystroke | editor work 2 ms p95; next frame 18–20 ms (= one 16 ms frame + alignment) | ✅ |
| Monaco open, 10k lines | — | 134–224 ms; TS worker ready 0.8 s | ✅ |
| Terminal `yes \| head -1000000` | no freeze > 100 ms | 726–836 ms total, max stall 13–19 ms | ✅ |
| Chat streaming | no dropped/duplicated events | 0 / 0 in burst, paced (50 ev/s) and 50k-char runs; max stall 8–22 ms | ✅ |
| Node core packaging | starts, survives quit/restart | bundled server ready in 604 ms, killed on quit | ✅ |
| Installer size | ≤ 150 MB | 160 MB self-contained; **67 MB** without the SDK's `claude` binary | ⚠️ → ✅ with condition 2 |
| Meeting capture via Rust AX | reads captions at 800 ms cadence | probe built; app has no Accessibility permission → `permission_denied` | ⏳ open |
| Windows rows | ≥ 30 fps graph etc. | not measured | ⏳ open |

## Findings

### Graph layout is the one weak spot
ForceAtlas2 (graphology worker, Barnes-Hut) per iteration at 10k nodes:
plain Node 38–44 ms; webview main thread 152–160 ms; webview worker 272–318 ms
(50k: 2.8–6 s per iteration). Rendering the same graphs is at or near the
display rate, so the cost is layout compute in WebKit's JS, not drawing.
Phase 1: run layout in Rust (native, streamed positions) or as WASM, and keep
graph-kit's TypeScript implementation for the data model. Never prune edges
(repo invariant) — all edges were drawn in every run.

### Packaging
Details in [`desktop/PACKAGING.md`](../../../desktop/PACKAGING.md). Node SEA works
(CJS bundle, top-level-await rewrites, zod/better-sqlite3/SDK external) but
saves little; ship node + pruned server as resources. The 239 MB platform
`claude` binary dominates the size.

### Background throttling skews unattended benchmarks
WKWebView throttles timers and rAF while its window is not frontmost. Several
autobench runs (started by an agent while the user worked in another app)
waited ~30 s with the page `hidden` before measuring, and one graph camera
run took 36 s for 5 s of animation (6.8 fps). The bench now records focus
loss per step and marks such results "not valid". Whether a user-started
launch ever shows the 30 s hidden phase is the first open item below.

### Security notes for Phase 1
- Monaco 0.57 vendors DOMPurify ≤ 3.4.16 (critical advisories); not reachable
  in the PoC (no untrusted markdown), must be fixed before it is.
- Custom Tauri commands (pty, graph file, replay) are not yet declared in an
  AppManifest/capability; Phase 1 must add scoped permissions.
- `read_graph_file` accepts any file named `graph.json`; restrict to the
  project root.
- Terminal output has no end-to-end flow control.
- The staging script once copied `kb/.dev-secrets.json` into a local build;
  every copy was deleted, the script now excludes secrets/.claude/keys/DBs and
  verifies the node binary. Nothing left the machine.

### Found on the first user-started launch (2026-10-26)
- **File access (TCC):** a Finder-launched app was silently denied
  `~/Desktop` ("read failed: Operation not permitted") — agent runs inherited
  the terminal's grant, so this never showed before. Fixed in the PoC with
  `NS{Desktop,Documents,Downloads}FolderUsageDescription` (macOS now asks).
  Phase 1: open projects through a file dialog (security-scoped access) and
  keep the usage strings.
- **Navigation parity:** the PoC copies the Mac look but not its behaviour —
  in the Mac app the sections live in the top toolbar and **Home** returns to
  the normal IDE view. Tracked for the screen-by-screen parity check
  (Phase 3); the user accepted deferring it.

## Open items (need the user)

1. Launch the PoC yourself (Finder), keep it frontmost, press **Bench → Run
   all** (~5 min): confirms the numbers with no throttling and whether the
   ~30 s hidden phase appears on a normal launch.
2. Optional: grant Accessibility to the PoC and re-run the `ax` step to
   measure caption-read timing.
3. Optional: allow one quit + relaunch of the Swift app to measure its cold
   start and idle memory like-for-like.
4. One Windows machine run of the autobench (Phase 1, before the freeze).

## Raw data

All numbers come from `BENCH` lines printed by the app's autobench modes
(`LLMIDE_POC_AUTOBENCH=graph|editor|terminal|chat|ax|all`); see
`desktop/README.md` and the commit history on `spike/tauri-phase0`
(c2f23a38 → 23ff0813).
