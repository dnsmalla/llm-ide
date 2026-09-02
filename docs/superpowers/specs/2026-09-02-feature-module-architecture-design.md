# Feature Module Architecture — Design

**Date:** 2026-09-02
**Status:** Phase 1 implemented; Phase 2a (Graph exclusion) implemented; Phase 2b (view features) implemented; Phase 3, 2c–d pending
**Goal:** The Workspace settings toggles (Settings → Workspace) currently hide
menus and views only. This design makes a disabled feature actually leave the
system: first its background work stops entirely (Phase 1), then its code is
excluded from the binary at build time (Phase 2), driven by a one-click
"Apply & Rebuild" from Settings (Phase 3). A non-engineer profile (no
Explorer, Gantt, Issues, …) then runs a genuinely lighter app.

## Current state (verified 2026-09-02)

- `Models/AppFeature.swift` — 8 feature flags, dependency validation
  (`validated()`), presets. Sound; kept as-is.
- `Services/FeatureRegistry.swift` — defines `protocol AppModule`
  (`start`/`stop`) and `register(module:)`, but **nothing registers a
  module**: the start/stop loops iterate an empty dictionary.
- `Services/AppEnvironment.swift` `syncServiceLifecycles()` — explicit no-op
  stub, never called.
- `LlmIdeMacApp.init()` builds and wires every service unconditionally:
  the AutoCode stack (`AutoCodeUpdateService`, registry, run history,
  `TaskLogStore`, template store), `GraphAutoUpdater`, `MobileControlManager`,
  `CaptionOrchestrator`/`AutoCaptureService`, `LiveSessionMirror`;
  `ActivityStore.start()` even runs inside init.
- Feature toggles gate rendering only, in `AppShell` / `StatusBar`.

So "menu removal works, app stays heavy" is by construction: the lifecycle
layer was designed but never wired.

## Phase 1 — Runtime feature modules (no rebuild required)

### Rule

**Init is free; `start()` does the work; `stop()` undoes it.**
A feature service's initializer allocates the ObservableObject shell only.
Timers, file watchers, network listeners, Bonjour advertising, disk bootstrap
IO all move into `start()`. `stop()` cancels all of it and must be safe to
call repeatedly.

### Module type per feature

Each toggleable feature gets one `<Feature>Module.swift` in its feature
folder, conforming to `AppModule`. The module owns the mapping
feature → services and is the only place that starts/stops them:

| Feature | Module owns (start/stop) | Main runtime cost today |
|---|---|---|
| `autoTasks` | `AutoCodeUpdateService` (+`ProcessedActionsRegistry`, `AutoTaskRunHistory` bootstrap), `TaskLogStore`, `AutoTaskTemplateStore` rescans, `AutoCaptureService`/`CaptionOrchestrator` polling | cron timer, capture polling, disk IO |
| `codeGraph3D` | `GraphAutoUpdater` (interval + watcher + backend upload) | timers, FS watchers, uploads |
| `mobileSync` | `MobileControlManager` (`MobileWebSocketServer` on :3006, `MobileBonjourAdvertiser`) | network listener, Bonjour |
| `agentChat` | `LiveSessionMirror` polling | polling |
| `fileExplorer` | none in Phase 1 (PassiveModule) | - |
| `ganttIssues` | issue/Gantt refresh work (view-driven today; module is a thin no-op until background work exists) | ~0 |
| `docGen` | `DocTemplateStore` project reload (thin) | ~0 |
| `terminal` | none (sessions are user-opened) | ~0 |

`fileExplorer` is passive in Phase 1: `LibraryItemStore` scanning and index
watching are project-lifecycle-driven and shared by Library/meetings
surfaces, so feature-gating them would break non-explorer consumers.
Revisit when Phase 2 separates those consumers.

Thin modules are still created: uniformity is what makes Phase 2 mechanical.

### Wiring

- `LlmIdeMacApp.init()` keeps constructing the shells (StateObjects must
  exist for SwiftUI environment injection — views are already gated, but a
  present-but-idle object is crash-proof and diff-small). It **stops calling
  any start-like work** in init.
- On first `AppShell.task`: `FeatureRegistry` gets all modules registered,
  then starts exactly the enabled set.
- `FeatureRegistry.updateFeatureSet` already computes enabled/disabled deltas
  and calls `stop`/`start` — it begins working the moment modules register.
- `AppEnvironment.syncServiceLifecycles()` stub is deleted (registry owns
  lifecycle; keeping two entry points invites drift).
- `ActivityStore` stays always-on (activity bell is core chrome, not a
  toggleable feature).

### Tests (Phase 1)

- Spy `AppModule` registered under each feature: disabled at launch →
  `start` never called; toggle off → `stop` called once; toggle on →
  `start` called once; idempotent `stop`.
- `MobileControlManager`: after `stop`, port :3006 no longer accepts
  connections.
- `AutoCodeUpdateService`: after `stop`, no scheduled run fires (existing
  cron tests extended).

## Phase 2 — build-time exclusion via env-driven source exclusion

> **Revised 2026-09-02 (post-Phase-1 dependency audit).** The original
> per-feature SPM target split is deferred: a target split forces `public`
> on every cross-target symbol (hundreds of sites) for no additional
> user-visible benefit, and the audit found (a) AutoTask ↔ LoopEngine is a
> genuine dependency **cycle** (`AutoCodeUpdateService+PipelineTasks` drives
> `LoopEngineRunner`; `LoopEngineView` renders `AutoCodeView`/`AutoTask`),
> and (b) `MobileControlManager` depends on AutoTask, LoopEngine, Chat, and
> Graph — Mobile must be extracted **last**, not first. The same outcome —
> disabled feature code physically absent from the binary — is reached with
> one target and `exclude:` lists.

### Selection mechanism (revised)

- `Package.swift` reads `LLMIDE_FEATURES` (comma-separated rawValues;
  unset = all) via `ProcessInfo` and appends the deselected features'
  source folders to the `LlmIdeMacLib` target's `exclude:` list (and their
  test files to the test target's), adding `.define("FEATURE_<NAME>")` for
  each **included** feature.
- Manifest caching: SwiftPM does not reliably key the manifest cache on
  env vars, so every build that changes the selection goes through the
  rebuild script, which passes `--manifest-cache none` (and the CI matrix
  does the same). A bare `swift build` without the env var always builds
  the full app.
- Exactly **one** file uses the defines: `FeatureCatalog.swift` next to the
  composition root — it registers the compiled-in modules, exposes their
  view factories, and reports the compiled feature set. `#if` never spreads
  beyond it.
- `AppShell`/Settings stop referencing excludable feature types directly;
  they render through catalog-provided factories, and remainder→feature
  service edges are re-seamed through core protocols or notifications.
  This decoupling is the bulk of Phase 2's work and is what would make a
  later true target split mechanical.
- A feature compiled out is absent from Settings toggles (the catalog
  reports the compiled set; compiled-out features show as "not installed").

### Extraction order (re-revised 2026-09-02 after Phase 2a shipped)

1. **Graph** (2a, DONE) — proved the mechanism end-to-end.
2. **View-only features** (2b): Explorer, Gantt & Issues, DocGen, Terminal
   UI. Moved ahead of AutoTask because it directly serves the product's
   stated persona (non-engineers drop Explorer/Gantt/Issues/Terminal) and
   its inbound coupling is small (audited: view construction in AppShell,
   two feature-owned ViewModels, `TerminalPanelState` promoted to core).
   Excluding `terminal` also drops the SwiftTerm product.
3. **Apply & Rebuild (Phase 3, brought forward)** — the one-click rebuild
   only needs the mechanism plus whatever is excludable so far; features
   not yet excludable simply stay compiled and keep their Phase 1 runtime
   stop behavior.
4. **AutoTask + LoopEngine as ONE excludable unit** — requires seaming
   `MobileControlManager`'s deep AutoTask/Loop coupling through core
   protocols; the cycle stays internal to the unit.
5. **Mobile** — last, because it depends on everything above; when a
   feature it needs is compiled out, the mobile surface for it degrades
   per capability flags.

### Tests (Phase 2)

- CI matrix builds two configurations: full (`LLMIDE_FEATURES` unset) and
  lite (all excludable features off), both must compile; full must pass
  the test suite.
- Conformance test: every `AppFeature` case has a registered module or is
  explicitly listed as compiled-out by the catalog.

## Phase 3 — Apply & Rebuild from Settings

- Settings → Workspace gains **"Apply & Rebuild (remove disabled code)"**,
  shown only when both are detected: a source checkout (running binary lives
  under a git worktree with `mac/Package.swift`) and a Swift toolchain.
- The button runs `scripts/mac/rebuild-app.sh --features <enabled csv>`:
  1. `LLMIDE_FEATURES=<csv> swift build -c release`
  2. bundle the .app (reuse existing packaging from `build_app.sh`)
  3. move the current .app to `<name>.app.bak` (one rollback slot)
  4. install the new .app at the same path, relaunch
- Failure at any step leaves the running app untouched and surfaces the log.
- Machines without a toolchain (non-engineers) never see the button; Phase 1
  runtime stopping is the automatic fallback. Prebuilt Full/Lite editions
  later are the same script run in CI — out of scope here.

## Scope and sequencing

Three sub-projects, each independently shippable, in order 1 → 2 → 3.
Phase 1 is the first implementation plan; Phases 2–3 get their own plans
when reached (Phase 2's plan enumerates per-feature promotion steps).

## Non-goals

- No change to the extension/server (`extension/`) — this is mac-app only.
- No dynamic plugin loading of features (dylib/bundle unloading) — rejected:
  Swift/SwiftUI type metadata cannot be safely unloaded in-process.
- No per-user licensing/entitlement gating — toggles remain a local choice.
