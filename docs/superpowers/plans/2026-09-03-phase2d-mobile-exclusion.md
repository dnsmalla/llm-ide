# Phase 2d: Mobile Control Build-Time Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mobile Control feature (key `mobile_sync`) excludable from the compiled binary — the final Phase 2 slice. Excluding it drops the WebSocket server, Bonjour, pairing, the two feature bridges, and the phone-explore machinery; the Mac otherwise behaves identically.

**Architecture:** FeatureCatalog pattern, final application: `bootMobile` absorbs the app-root construction/wiring; `bootAutoTask` loses its concrete `MobileControlManager` parameter (bridge wiring moves to a catalog-internal step guarded by BOTH defines); the handful of core→mobile touchpoints (KeychainStore's MobilePin cache, AutoCodeView's refresh call, SettingsView's section, the app's notify/stop calls) become catalog seams.

**Tech Stack:** Swift/SwiftUI, SPM env-driven manifest (file-level `exclude:` entries), XCTest.

**Spec:** `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Phase 2, extraction-order item 5 — Mobile last)

## Global Constraints

- `#if FEATURE_*` confined to `mac/Sources/LlmIdeMac/FeatureCatalog.swift`. Combined guards (`#if FEATURE_AUTOTASK && FEATURE_MOBILE`) are allowed there.
- Feature key `mobile_sync` → define `FEATURE_MOBILE` → excludes the 16-file unit (list in Verified facts).
- Build matrix that must ALL pass from `mac/` (sandbox off; `--manifest-cache none` whenever the selection changes):
  1. Full: `GIT_CONFIG_GLOBAL=/dev/null swift build`
  2. AutoTask-in/Mobile-out: `LLMIDE_FEATURES=agent_chat,auto_tasks swift build --manifest-cache none` — the critical new combination (bridges excluded, AutoCodeView seam, bootAutoTask without mobile)
  3. Chat-only: `LLMIDE_FEATURES=agent_chat swift build --manifest-cache none`
  4. Full again with `--manifest-cache none`.
- Full-build behavior parity: pairing, phone chat/explore, auto-task/loop bridges, push observers, settings card, PIN cache warm/clear — all identical when compiled in.
- Excluded-runtime degrade: Settings shows no Mobile Control card; presets intersect away `.mobileSync` (already generic); no crash path from notifications the app used to forward.
- Toolchain has NO XCTest; SourceKit diagnostics stale — only `swift build` verdicts count. Comments English. Commit style: Japanese conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verified current-state facts (audited 2026-09-03 — do not re-derive)

- **The excludable unit (16 files; every declared type's consumers are inside the set):** `Services/MobileControlManager.swift` (+`MobileLogLine`, private `ChatTurn.init(from:)` ext used only in-file), `Services/MobileWebSocketServer.swift`, `Services/MobileBonjourAdvertiser.swift`, `Services/MobilePin.swift`, `Services/MobileConnectionInfo.swift` (`LocalIPs`), `Services/MobileModule.swift`, `Services/MobileExploreBridge.swift`, `Services/MobileExploreIndexStore.swift`, `Services/MobileSkillCatalog.swift`, `Services/MobileWorkspaceSearch.swift`, `Services/PairingThrottle.swift`, `Views/Settings/MobileControlSettingsSection.swift`, `Chat/ExplorerMobileEngineResolver.swift` (misfiled under Chat/ — only consumer is the manager), `AutoTask/Services/MobileAutoTaskBridge.swift`, `LoopEngine/Services/MobileLoopBridge.swift` — plus NOTHING else. `Services/MobileFeatureBridge.swift` (the protocol) is the seam and STAYS core.
- **Chat/CodeAssistant is NOT a knot**: all Chat/LlmChatViewModel/CodeAssistantPanel/ChatComposer hits are doc comments; direction is exclusively mobile→chat. `LlmChatSheet`/`LlmChatStatusBadge` "iPhone" strings belong to the separate backend-synced LLM Chat feature — zero coupling. `Models/Config.swift`'s `mobileControlEnabled`/`mobileControlAutoStart` are plain Bools (stay).
- **Real inbound code references:**
  - `LlmIdeMacApp.swift`: :62 `extension MobileControlManager: FeatureService {}`; :86 `@State mobileControl = MobileControlManager()`; :158-161 dep wiring (.api/.config/.projectStore/.backendManager); :178-186 `FeatureCatalog.bootAutoTask(..., mobileControl: mobileControl, ...)`; :190 `installMobilePushObservers()`; :201-204 `MobileModule` registration; :245 `.environment(mobileControl)`; :357-372 `onChange`/`onReceive` → `onWorkspaceChanged()/onMacEnvironmentChanged()/onBackendReady()`; :380 `mobileControl.stop()` on willTerminate.
  - `FeatureCatalog.swift`: `bootAutoTask`'s `mobileControl: MobileControlManager` param sits OUTSIDE any `#if` (:233); bridge wiring at :303-307 inside `#if FEATURE_AUTOTASK`.
  - `Services/KeychainStore.swift`: :189 `MobilePin.warmCache()`, :207 `MobilePin.clearSessionCache()`.
  - `Views/SettingsView.swift`: :26 `MobileControlSettingsSection()` unconditional.
  - `AutoTask/Views/AutoCodeView.swift`: :30 `@Environment(MobileControlManager.self)`, :109 + :343 `mobileControl.refreshAutoTaskStateForMobile()` (method on the manager, :891).
- **Tests**: cleanly excludable: `MobilePairingFrameTests`, `MobileWebSocketServerBindTests`, `MobileWebSocketServerRebindTests`, `MobileWebSocketServerRoutingTests`, `MobileControlPortTests`, `MobileFeatureBridgeTests` (tests manager routing), `PairingThrottleTests`, `MobileExploreIndexStoreTests`, `MobileLoopStateTests` (also in the auto_tasks list — overlap OK, dedupe). NOT cleanly excludable, need splits first: `ChatEngineRegistryTests.swift` embeds `ExplorerMobileEngineResolverTests` (~15 lines constructing the resolver); `FeatureModulesTests.swift` embeds `testMobileModuleRespectsControlEnabledAndAutoStart`. `FeatureRegistryTests`' `.mobileSync` uses are bare enum cases (fine).
- `ios_app/SharedProtocol` is a separate SPM package product — unaffected (mac target links it unconditionally; if nothing imports it in a mobile-less build the product link COULD be gated like SwiftTerm — check who imports SharedProtocol outside the unit and gate the product if clean).
- Precedents in place: catalog statics + boot functions (graph/autoTask/mobile-analogous), `installXEnvironment` wrappers, `.bak`-style TEMP define pattern (`// TEMP(Phase2d-Task3)`), buildTimeExcludable + pinned CSV test (currently six keys), Makefile `build-mac-lite`/`build-mac-min` + `regression`.

---

### Task 1: FeatureCatalog bootMobile + composition/seam decoupling

**Files:**
- Modify: `mac/Sources/LlmIdeMac/FeatureCatalog.swift`
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/KeychainStore.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/SettingsView.swift`
- Modify: `mac/Sources/LlmIdeMac/AutoTask/Views/AutoCodeView.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/MobileModule.swift` or the manager file (receives the `FeatureService` conformance — put it next to `MobileModule` like the other features)
- Modify: `mac/Package.swift` (TEMP unconditional `.define("FEATURE_MOBILE")` marked `// TEMP(Phase2d-Task3)`)

**Interfaces (produced; Task 3 relies on them):**
- `FeatureCatalog.bootMobile(config:api:projectStore:backend:registry:)` — constructs `MobileControlManager`, wires `.api/.config/.projectStore/.backendManager`, registers `MobileModule(manager:controlEnabled:autoStart:)`, stores the manager in a private static; no-op when compiled out.
- `FeatureCatalog.installMobileEnvironment(_ view: AnyView) -> AnyView` (replaces `.environment(mobileControl)`).
- `FeatureCatalog.installMobilePushObservers()`, `stopMobile()`, `notifyMobileWorkspaceChanged()`, `notifyMobileMacEnvironmentChanged()`, `notifyMobileBackendReady()` — thin forwards to the stored manager; no-ops when off.
- `FeatureCatalog.mobileControlSettingsSection() -> AnyView?` (nil when off).
- `FeatureCatalog.refreshAutoTaskStateForMobile()` — no-op when mobile off; forwards to the stored manager otherwise. AutoCodeView calls THIS (its `@Environment(MobileControlManager.self)` property is deleted).
- `FeatureCatalog.warmMobilePinCache()` / `clearMobilePinSessionCache()` — KeychainStore calls these instead of `MobilePin` directly (precedent: `invalidateGraphEngineCache` from Phase 2a).
- `bootAutoTask` signature CHANGE: the `mobileControl:` parameter is REMOVED. Bridge wiring moves to a new catalog-internal `wireMobileFeatureBridges()` guarded `#if FEATURE_AUTOTASK && FEATURE_MOBILE`, reading both features' stored statics; call it from `bootMobile` AND from `bootAutoTask` (whichever runs second wins — make it idempotent, wiring only when both statics exist and bridges are nil).

- [ ] **Step 1:** Read LlmIdeMacApp's mobile block + FeatureCatalog fully; implement `bootMobile` + all seam functions above; move the `FeatureService` conformance; change `bootAutoTask`'s signature and add `wireMobileFeatureBridges()`; update the app root: delete the `@State`, replace every direct call with the catalog seam (construction order: bootMobile BEFORE bootAutoTask, both before `FeatureCatalog.installMobilePushObservers()`; willTerminate uses `FeatureCatalog.stopMobile()`; keep `backend.stop()` direct).
- [ ] **Step 2:** KeychainStore/AutoCodeView/SettingsView seams per the interface list. AutoCodeView's two call sites use `FeatureCatalog.refreshAutoTaskStateForMobile()`.
- [ ] **Step 3:** TEMP define in Package.swift. Build: full → green. Grep gate: `grep -rn "MobileControlManager\|MobileWebSocketServer\|MobileBonjourAdvertiser\|MobilePin\|MobileModule\|MobileConnectionInfo\|MobileExploreBridge\|MobileSkillCatalog\|MobileWorkspaceSearch\|PairingThrottle\|MobileControlSettingsSection\|ExplorerMobileEngineResolver\|MobileAutoTaskBridge\|MobileLoopBridge\|MobileLogLine" mac/Sources/LlmIdeMac --include="*.swift"` filtered to exclude the 16 unit files + FeatureCatalog.swift + the core protocol file → comments only (record verbatim).
- [ ] **Step 4:** `swift test --filter FeatureRegistryTests` attempt (XCTest caveat). Commit: `feat(mac): Mobile Control の合成と横断参照を FeatureCatalog 経由に分離`

---

### Task 2: Test splits

**Files:**
- Modify: `mac/Tests/LlmIdeMacTests/ChatEngineRegistryTests.swift` (remove the embedded ExplorerMobileEngineResolver tests)
- Create: `mac/Tests/LlmIdeMacTests/ExplorerMobileEngineResolverTests.swift` (verbatim move)
- Modify: `mac/Tests/LlmIdeMacTests/FeatureModulesTests.swift` (remove the MobileModule test)
- Create: `mac/Tests/LlmIdeMacTests/MobileModuleTests.swift` (verbatim move, own private SpyService — GraphModuleTests/AutoTaskModuleTests pattern)

- [ ] **Step 1:** Verbatim moves; each remaining file compiles standalone (no dangling helpers).
- [ ] **Step 2:** Build (test target can't compile locally — state it; library build green suffices). Commit: `test(mac): Mobile 依存テストを専用ファイルに分離`

---

### Task 3: Package.swift key + build matrix

**Files:**
- Modify: `mac/Package.swift` (key `mobile_sync` → `FEATURE_MOBILE` define replacing TEMP; libExcludes = the 16 files as file-level paths relative to the target; testExcludes = the 9 mobile test files + the 2 new split files, deduped against the auto_tasks list; unset-default gains `mobile_sync`; IF nothing outside the unit imports SharedProtocol — grep — gate that product on mobileIncluded, preserving comments)
- Modify: `mac/Sources/LlmIdeMac/Models/AppFeature.swift` (`buildTimeExcludable` gains `.mobileSync`)
- Modify: `mac/Tests/LlmIdeMacTests/FeatureRebuildServiceTests.swift` (pinned CSV → `auto_tasks,code_graph_3d,doc_gen,file_explorer,gantt_issues,mobile_sync,terminal`)
- Modify: `Makefile` (`build-mac-min` becomes `LLMIDE_FEATURES=agent_chat` — the true minimum now — with updated help text; keep it in `regression`)

- [ ] **Step 1:** Manifest changes; verify FeatureCatalog `compiledFeatures` gains the `#if !FEATURE_MOBILE` removal (add if Task 1 didn't).
- [ ] **Step 2:** Build matrix per Global Constraints (full / agent_chat,auto_tasks / agent_chat / full), tails recorded. nm gate right after build 3: `nm mac/.build/debug/LlmIdeMac | grep -c "MobileControlManager\|MobileWebSocketServer"` → 0; after final full build → nonzero baseline. Also `nm` after build 2 (auto_tasks in, mobile out) → 0 for the same symbols AND nonzero for `AutoCodeUpdateService` (proves the combination).
- [ ] **Step 3:** A failure names remaining coupling — fix via catalog seam or file move, never stray `#if`. Commit: `feat(mac): mobile_sync キーで Mobile Control をビルド時除外可能にする`

---

### Task 4: Docs + gates

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Status: 2d implemented — Phase 2 COMPLETE; extraction order item 5 DONE)
- Modify: `docs/spec/macos-app.md` (seven excludable keys; mobile unit contents; SharedProtocol gating if done; build-mac-min now chat-only)
- Modify: `CLAUDE.md` (Mobile Control section: excludable; build-mac-min description)

- [ ] **Step 1:** Run + record VERBATIM: the `#if FEATURE_` confinement grep; Task 1 Step 3's reference grep; `grep -rn "import SharedProtocol" mac/Sources/LlmIdeMac --include="*.swift"` classified against the unit (supports the product-gating claim if made).
- [ ] **Step 2:** Facts-only doc edits (verify every sentence against code — this project's docs tasks have a 2-fix-round history).
- [ ] **Step 3:** Full build; commit: `docs: Mobile Control のビルド時除外(Phase 2d)を文書化`
