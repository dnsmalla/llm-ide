# CLAUDE.md (mac/)

Loaded when working under `mac/`. Moved out of the root CLAUDE.md.

## macOS App Conventions

Swift type suffixes communicate role — pick matching suffix when adding new types:

- **`*Service`** — Long-lived background work/orchestration (e.g., `BackendManager`, `CodeWorkflowService`)
- **`*Store`** — Owns persistent state, reads/writes on-disk store (e.g., `ChatSessionStore`, `DocTemplateStore`)
- **`*Client`** — Wraps external HTTP/IPC API, no state beyond URL/token (e.g., `GitLabClient`, `LlmIdeAPIClient`)
- **`*Manager`** — Controls system resource needing lifecycle management (e.g., `RepoManager`)
- **`*Mirror`** — Passive shadow of remote state, never mutates (e.g., `LiveSessionMirror`)
- **`*Router`** — Request/event dispatch, pure wiring (e.g., `DeepLinkRouter`)

### Apply & Rebuild (Settings → Workspace)

On a source checkout with a Swift toolchain, Settings → Workspace shows a **Build** card with **"Apply & Rebuild (remove disabled code)"** — an in-app rebuild that actually excludes disabled features from the compiled binary, not just hides them. Owned by `FeatureRebuildService` (`mac/Sources/LlmIdeMac/Features/Settings/Services/FeatureRebuildService.swift`); the card (`BuildRebuildSettingsCard` in `mac/Sources/LlmIdeMac/Features/Settings/Views/FeatureProfileSettingsView.swift`) renders nothing when `isEligible` is false, so it never appears on a non-engineer machine or a distributed release build (`Scripts/release.sh` sets `LLMIDE_OMIT_SOURCE_ROOT=1`, which omits the `LLMIDESourceRoot` Info.plist key eligibility depends on). Flow: confirmation dialog → `mac/Scripts/rebuild-features.sh` stages a release build + `mac/Scripts/sign.sh` off to the side (running app untouched) → "Restart & Install" spawns `mac/Scripts/rebuild-swap.sh` detached, which waits for this process to exit, keeps the previous `.app` as `<name>.app.bak` (one rollback slot), installs the staged bundle, and relaunches — logging to `<install-target-minus-.app>.rebuild.log`. See `docs/spec/macos-app.md` ("Apply & Rebuild") for the full contract.
