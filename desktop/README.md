# LLM-IDE Desktop

The Tauri 2 + React 19 + Vite + TypeScript desktop app ([ADR 0018](../docs/decisions/0018-tauri-desktop-node-core-relay.md)).
The Rust host (`src-tauri/`) spawns and supervises the Node core (`../extension`); the screens live in `../ui/screens`.
Packaging: [PACKAGING.md](PACKAGING.md). Releases: [desktop-release.md](../docs/how-to/desktop-release.md).

## Run

```bash
cd desktop
npm install            # exact-pinned deps; Tauri CLI is a dev dependency
npm run dev            # frontend only, http://localhost:5173
npm run tauri dev      # full app window (starts Vite via beforeDevCommand)
node scripts/stage-core.mjs && npm run tauri build   # release bundle (LLM-IDE.app on macOS); build.rs refuses a release build without resources/core/STAGE.json
                       # (macOS: ../scripts/build-desktop-mac.sh stages and builds)
npm run tauri build -- --debug --bundles app   # faster debug .app
npm run tauri dev -- --features spike          # + the Phase-0 spike/bench host commands (autobench, parity screenshots)
```

The spike/bench commands (`ping`, `bench*`, `autobench_mode`, `*_override`, `sse_replay_*`, `ax_probe`) and
`capabilities/spike.json` exist only with the `spike` cargo feature, which is off by default and never in a release
build (`npm run check:security:product`, run by `npm run build` and `scripts/build-desktop-mac.sh`, enforces it).

Requirements: Node 22+, Rust 1.90+ (required by `tauri` 2.12; tested on stable 1.99).
