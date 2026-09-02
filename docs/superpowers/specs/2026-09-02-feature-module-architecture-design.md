# Feature Module Architecture — Design

**Date:** 2026-09-02
**Status:** Proposed
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
| `fileExplorer` | `LibraryItemStore` scans + `AppEnvironment` index watching | FS scans/watchers |
| `ganttIssues` | issue/Gantt refresh work (view-driven today; module is a thin no-op until background work exists) | ~0 |
| `docGen` | `DocTemplateStore` project reload (thin) | ~0 |
| `terminal` | none (sessions are user-opened) | ~0 |

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

## Phase 2 — SPM targets per feature (build-time exclusion)

### Target layout

```
mac/Sources/
├── LlmIdeCore/        # config, session, API client, ProjectStore, theme,
│                      # AppFeature, FeatureRegistry, shared UI primitives
├── FeatureAutoTask/   # today's AutoTask/ folder
├── FeatureLoopEngine/ # today's LoopEngine/ (dependency of FeatureAutoTask)
├── FeatureGraph/      # today's Graph/
├── FeatureExplorer/
├── FeatureGantt/
├── FeatureDocGen/
├── FeatureTerminal/
├── FeatureChat/
├── FeatureMobile/
└── LlmIdeMacApp/      # composition root: FeatureCatalog + AppShell chrome
```

The 2026-09-02 folder consolidation (AutoTask/, LoopEngine/, Graph/) defined
these boundaries; remaining features get the same folder consolidation as
they are promoted to targets — promotion order: Mobile, Graph, AutoTask
(largest wins first), then the view-only features.

### Selection mechanism

- `Package.swift` reads `LLMIDE_FEATURES` (comma-separated rawValues;
  unset = all) via `ProcessInfo` and includes only the selected feature
  targets as dependencies of the app target, adding a
  `.define("FEATURE_<NAME>")` swift setting per included feature.
- Exactly **one** file uses those defines: `FeatureCatalog.swift` in the
  composition root — it registers the compiled-in modules and exposes their
  view factories. `#if` never spreads beyond it.
- `AppShell` stops referencing feature view types directly; it renders
  through the module's view factory (`AppModule` gains
  `func makeSidebarSections() -> …` / `func makeMainPane(section:) -> …`
  as needed per feature). This is the bulk of Phase 2's work.
- A feature compiled out is also absent from `AppFeature.settingsToggleable`
  surfaces at runtime (the catalog reports the compiled set; Settings shows
  compiled-out features as "not installed" rather than a dead toggle).

### Tests (Phase 2)

- CI matrix builds two configurations: full (`LLMIDE_FEATURES` unset) and
  lite (`core + chat + docGen`), both must compile and boot to WelcomeView.
- Conformance test: every `AppFeature` case has a registered module or is
  explicitly listed as compiled-out.

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
