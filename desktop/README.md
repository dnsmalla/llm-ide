# LLM-IDE Desktop PoC (throwaway)

Tauri 2 + React 19 + Vite + TypeScript spike for the Phase 0 measurements in
`docs/superpowers/plans/2026-10-25-tauri-phase0-implementation.md`. Not a
product; nothing here is wired to the Node core yet (that is T2).

## Run

```bash
cd desktop
npm install            # exact-pinned deps; Tauri CLI is a dev dependency
npm run dev            # frontend only, http://localhost:5173
npm run tauri dev      # full app window (starts Vite via beforeDevCommand)
npm run tauri build    # release bundle (LLM-IDE Desktop PoC.app on macOS)
npm run tauri build -- --debug --bundles app   # faster debug .app
```

Requirements: Node 20.19+ (tested on 22), Rust 1.84+ (tested on 1.84.1, Homebrew).
The Rust lockfile (`src-tauri/Cargo.lock`) is resolved for Rust 1.84.
