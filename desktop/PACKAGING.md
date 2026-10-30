# Packaging the Node core (Phase 0, T6)

Measured 2026-10-26 on macOS arm64, Node 22.23.1, release build
(`npm run tauri build -- --bundles app,dmg`).

## Result

The core ships as Tauri resources: an official, stripped, ad-hoc-signed `node`
binary plus a pruned copy of `extension/` (`scripts/stage-core.mjs` →
`resources/core`, mapped to `Contents/Resources/core`). `core_host.rs`
(`resolve_runtime`) uses it when running from a `.app` or with
`LLMIDE_POC_BUNDLED=1`, otherwise the repo checkout.

Verified with the release `.app` launched through Launch Services and
`LLMIDE_POC_FORCE_SPAWN=1`: the bundled server answered `/health` on :3457 in
**604 ms** (`core_ms_to_healthy`, `adopted:false`) and was gone after the app
quit.

## Sizes

| Build | `.app` | `.dmg` (UDZO) |
|---|---|---|
| Self-contained (bundled node + server + the Agent SDK's `claude` binary) | 386 MB | **160 MB** |
| Same, without the SDK's bundled `claude` binary | 147 MB | **67 MB** |
| Swift app today (`mac/LlmIdeMac.app`, no node/server inside) | 37 MB | — |

Breakdown of the self-contained `.app`: `@anthropic-ai/claude-agent-sdk-darwin-arm64`
(the bundled `claude` CLI) 239 MB, `node` 86 MB, rest of `node_modules`
~45 MB (better-sqlite3 27 MB with all-platform prebuilds, @anthropic-ai/sdk
10 MB, @modelcontextprotocol/sdk 8 MB, …), server code 2.7 MB, Rust binary
12 MB, frontend assets included in the binary.

Plan §6 target is ≤ 150 MB per installer: the self-contained build misses it
(160 MB); the build that uses the user's installed `claude` meets it (67 MB).

## Node single-executable (SEA) — works, small win

`scripts/sea-spike.mjs`: esbuild bundles `server.mjs` to one CommonJS file,
`postject` injects it into the official node binary, ad-hoc signed. The server
answered `/health` and prewarmed the engine. Blockers worked around:

- SEA accepts CommonJS only; ESM entry rejected.
- Top-level `await` (server.mjs:1118 and three handler self-test guards) must
  be rewritten in the build copy.
- `zod` must stay external (bundled copy fails: "Class2 is not a constructor").
- `better-sqlite3` (native addon), the Agent SDK and `zod` load from disk via
  `createRequire` on the runtime root.
- Homebrew `node` cannot be used (links `libnode.dylib`); use the official
  tarball.

The bundle is 6.4 MB, but node (86 MB) and the SDK's `claude` binary still
ship, so SEA saves little. Not recommended for Phase 1.

## Recommendation for Phase 1

1. Ship node + pruned server as resources (this PoC's approach).
2. Do not bundle the SDK's platform `claude` binary; point the Agent SDK at
   the user's installed CLI (`pathToClaudeCodeExecutable`), which users have
   anyway for `claude login`. Fall back to downloading it on first run if
   missing. Installer ≈ 67 MB.
3. Prune `better-sqlite3` prebuilds to the target platform at staging time.

## Risks

- Developer ID signing + notarization of every nested executable (node,
  `better_sqlite3.node`, and the `claude` binary if bundled); hardened runtime
  entitlements for node (JIT).
- Per-arch builds (arm64 / x64) and a universal build double the size.
- Windows/Linux: same layout with `node.exe` / ELF node; better-sqlite3
  prebuilds per platform; no measurements yet.
- The `.skills` submodule is not staged; skill files the server reads at
  runtime must be added to `stage-core.mjs`.
- Updating the core means shipping a new app (no separate core updater yet).
- The `node_modules` prune in `stage-core.mjs` deletes docs/tests/`.md`/`.ts`
  files by name; only `/health` was smoke-tested here. T7 runs a real chat
  stream against the bundled core; Phase 1 should prune by allowlist.

## Enforcement of "do not bundle the SDK `claude` binary"

`scripts/stage-core.mjs` removes `@anthropic-ai/claude-agent-sdk-<platform>` after
`npm ci` and fails if any such package or a `claude` executable remains;
`scripts/check-core-deps.mjs` re-verifies the staged tree. Spike builds that still
need the bundled binary opt out with `LLMIDE_STAGE_ALLOW_SDK_BINARY=1` (never for a
release). Open gap: the server does not yet pass `pathToClaudeCodeExecutable`, so a
stage without the binary needs the user's `claude` wired in (Tauri plan T6).
