# Phase 3: Apply & Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click in Settings → Workspace rebuilds the app with only the enabled features compiled in, replaces the installed .app (one `.bak` rollback slot), and relaunches — on Macs that have the source checkout + Swift toolchain; everywhere else the button is absent and Phase 1 runtime stopping remains the behavior.

**Architecture:** Three layers. (1) `mac/Scripts/` gains env-overridable staging in the existing build/sign phases plus a new `rebuild-features.sh` orchestrator with `--stage-only` (build+sign into a staging dir, running app untouched) and a detached `rebuild-swap.sh` (waits for app exit → `.bak` → install → `open`). (2) A new `FeatureRebuildService` (Mac app) detects eligibility, composes the feature CSV from the registry, drives the script via `Process`, and hands off to the swap helper before terminating. (3) A Settings card shows compiled-vs-enabled drift, the button, progress, and errors.

**Tech Stack:** bash, Swift/SwiftUI, `Process`/`NSApplication`, existing `LLMIDE_FEATURES` manifest contract.

**Spec:** `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Phase 3 + extraction-order item 3)

## Global Constraints

- The running app must NEVER be killed or have its bundle mutated by a FAILED rebuild: all build/sign work happens in a staging directory; the swap runs only after a fully staged, signed bundle exists, and only after the app exits itself.
- `Scripts/build.sh` keeps working EXACTLY as today when the new env vars are unset (release pipeline unchanged); `pkill` behavior only changes when explicitly skipped.
- `#if FEATURE_*` confinement (FeatureCatalog.swift only) still holds — this phase adds no conditional compilation.
- Feature CSV = the registry's `activeFeatures ∩ compiledFeatures`... NO: the CSV must be the runtime-validated **activeFeatures** (already dependency-closed by `AppFeature.validated`) — intersecting with the CURRENT binary's `compiledFeatures` would make it impossible to re-ADD a feature that this binary excluded. Pass `activeFeatures` rawValues.
- Builds: full `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`; the stage-only rebuild run is the integration gate (see Task 1 Step 4). Sandbox off when SwiftPM manifests are blocked.
- Toolchain has NO XCTest: attempt `swift test --filter <name>`, fall back to build, say "build verified, XCTest unavailable locally".
- Comments English. Commit style: Japanese conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Verified current-state facts (do not re-derive)

- `mac/Scripts/build.sh`: `APP_DIR="$PROJ_DIR/$APP_NAME.app"` (:19); `pkill -9 -f "$APP_NAME"` early; bundles skeleton + icon + Info.plist (heredoc around :95-160, `com.llmide.macapp`); `swift build -c release --product "$APP_NAME" $SPM_OFFLINE` (:205); copies `BUILT_BIN` into `$APP_DIR/Contents/MacOS/` (:219); also stages Sparkle.framework (rpath next to executable — see `Scripts/run.sh` for the pattern).
- `mac/Scripts/sign.sh`: `APP_DIR="$PROJ_DIR/$APP_NAME.app"` (:17); signs with `LLMIDE_SIGN_IDENTITY` → `.sign-identity` file → ad-hoc `-`.
- `mac/build_app.sh` = dev shim: build → sign → dmg → `open`.
- `mac/Package.swift`: `LLMIDE_FEATURES` (five excludable keys; unknown keys ignored; unset = all); selection changes require `--manifest-cache none`.
- `FeatureRegistry.shared`: `activeFeatures` (validated), `compiledFeatures` (set at boot from `FeatureCatalog.compiledFeatures`).
- Workspace settings UI: `Views/Settings/FeatureProfileSettingsView.swift` (profile picker + toggles + menu-bar rows).
- Suffix taxonomy: long-lived orchestration = `*Service`.

---

### Task 1: Scripts — staging overrides + rebuild orchestrator + swap helper

**Files:**
- Modify: `mac/Scripts/build.sh` (env overrides + feature passthrough + source-root plist key)
- Modify: `mac/Scripts/sign.sh` (APP_DIR env override)
- Create: `mac/Scripts/rebuild-features.sh`
- Create: `mac/Scripts/rebuild-swap.sh`

**Interfaces (produced; Task 2 invokes exactly these):**
- `rebuild-features.sh --features <csv> --stage-dir <dir> [--stage-only]` — exit 0 with `<dir>/LlmIdeMac.app` fully built + signed; never touches any installed app; prints progress lines to stdout (each phase prefixed `[rebuild]`).
- `rebuild-swap.sh <staged_app> <target_app> <pid>` — designed to be spawned detached; waits for `<pid>` to exit (poll `kill -0` 1s interval, 120s cap), then `rm -rf <target>.bak`, `mv <target> <target>.bak` (if target exists), `mv <staged_app> <target>`, `open <target>`. Logs to `<target>.rebuild.log`.
- `build.sh` new env contract (all optional, default = today's behavior): `LLMIDE_APP_DIR` (bundle output path), `LLMIDE_SKIP_KILL=1` (skip the pkill), `LLMIDE_FEATURES` (passed through to `swift build` env; when set, build.sh adds `--manifest-cache none` to the swift build invocation). Also NEW ALWAYS-ON behavior: Info.plist gains `<key>LLMIDESourceRoot</key><string>$PROJ_DIR</string>` and `<key>LLMIDEFeatures</key><string>${LLMIDE_FEATURES:-all}</string>`.
- `sign.sh` honors `LLMIDE_APP_DIR` the same way.

- [ ] **Step 1: build.sh + sign.sh overrides.** In both, change the fixed line to `APP_DIR="${LLMIDE_APP_DIR:-$PROJ_DIR/$APP_NAME.app}"`. In build.sh: wrap the pkill in `if [ "${LLMIDE_SKIP_KILL:-0}" != "1" ]; then …; fi`; extend the swift build line to include `--manifest-cache none` when `LLMIDE_FEATURES` is set (env var is already exported to the child automatically — verify build.sh doesn't sanitize env); add the two plist keys inside the existing heredoc.
- [ ] **Step 2: rebuild-features.sh.**

```bash
#!/bin/bash
# ============================================
# Feature-selected rebuild into a staging directory. Safe to run while
# the app is running: nothing outside --stage-dir is touched. The swap
# into place is rebuild-swap.sh's job (spawned by the app on success).
# Usage: rebuild-features.sh --features <csv> --stage-dir <dir> [--stage-only]
# ============================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FEATURES="" ; STAGE_DIR="" ; STAGE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --features) FEATURES="$2"; shift 2 ;;
    --stage-dir) STAGE_DIR="$2"; shift 2 ;;
    --stage-only) STAGE_ONLY=1; shift ;;
    *) echo "[rebuild] unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$FEATURES" ] && [ -n "$STAGE_DIR" ] || { echo "[rebuild] --features and --stage-dir required" >&2; exit 2; }
mkdir -p "$STAGE_DIR"
APP_DIR="$STAGE_DIR/LlmIdeMac.app"
echo "[rebuild] staging build (features: $FEATURES) into $APP_DIR"
LLMIDE_FEATURES="$FEATURES" LLMIDE_APP_DIR="$APP_DIR" LLMIDE_SKIP_KILL=1 "$SCRIPT_DIR/build.sh"
echo "[rebuild] signing staged bundle"
LLMIDE_APP_DIR="$APP_DIR" "$SCRIPT_DIR/sign.sh"
echo "[rebuild] staged OK: $APP_DIR"
# --stage-only stops here; the app spawns rebuild-swap.sh itself.
exit 0
```

- [ ] **Step 3: rebuild-swap.sh.**

```bash
#!/bin/bash
# ============================================
# Detached swap helper: waits for the app process to exit, keeps ONE
# rollback slot (<target>.bak), installs the staged bundle, relaunches.
# Spawned by FeatureRebuildService right before NSApp.terminate; must
# not die with its parent (the service starts it via nohup/setsid).
# Usage: rebuild-swap.sh <staged_app> <target_app> <pid>
# ============================================
set -uo pipefail
STAGED="$1"; TARGET="$2"; PID="$3"
LOG="${TARGET%.app}.rebuild.log"
exec >>"$LOG" 2>&1
echo "[swap] $(date) waiting for pid $PID"
for _ in $(seq 1 120); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "[swap] pid $PID still alive after 120s — aborting, nothing touched"
  exit 1
fi
[ -d "$STAGED" ] || { echo "[swap] staged bundle missing: $STAGED"; exit 1; }
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET.bak"
  mv "$TARGET" "$TARGET.bak"
  echo "[swap] previous app kept at $TARGET.bak"
fi
mv "$STAGED" "$TARGET"
echo "[swap] installed; relaunching"
open "$TARGET"
```

`chmod +x` both new scripts.
- [ ] **Step 4: Integration gate (run it, record tails).** From repo root:
  1. `bash mac/Scripts/rebuild-features.sh --features agent_chat,auto_tasks,mobile_sync --stage-dir "$TMPDIR/llmide-rebuild-test" --stage-only` (sandbox off if SwiftPM blocked) → exit 0, staged app exists.
  2. Symbol gate: `nm "$TMPDIR/llmide-rebuild-test/LlmIdeMac.app/Contents/MacOS/LlmIdeMac" 2>/dev/null | grep -c "GraphAutoUpdater\|TerminalSessionView"` → `0` (excluded code absent from the staged binary); run the same nm on the full `.build` binary if present to show a non-zero baseline.
  3. `defaults read "$TMPDIR/llmide-rebuild-test/LlmIdeMac.app/Contents/Info" LLMIDESourceRoot` prints the repo's mac/ path; `LLMIDEFeatures` prints the CSV.
  4. `GIT_CONFIG_GLOBAL=/dev/null swift build` (full, from mac/) still green.
  5. Clean up the staging dir.
- [ ] **Step 5: Commit** — `feat(mac): 機能選択リビルドのステージング/スワップスクリプトを追加`

---

### Task 2: FeatureRebuildService

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/FeatureRebuildService.swift`
- Test: `mac/Tests/LlmIdeMacTests/FeatureRebuildServiceTests.swift`

**Interfaces:**
- Consumes: Task 1's script contracts; `FeatureRegistry.shared.activeFeatures/compiledFeatures`; `Bundle.main` plist keys `LLMIDESourceRoot`/`LLMIDEFeatures`.
- Produces (Task 3 renders this):

```swift
@MainActor
final class FeatureRebuildService: ObservableObject {
    enum Phase: Equatable { case idle, building, readyToSwap, failed(String) }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var logTail: [String] = []   // last ~20 lines

    /// Nil when this Mac can't rebuild (no checkout / no toolchain / not
    /// running from a writable .app bundle). Non-nil = the mac/ dir.
    let sourceRoot: URL?
    /// The .app bundle to replace (Bundle.main.bundleURL when it ends in .app).
    let installTarget: URL?
    var isEligible: Bool { sourceRoot != nil && installTarget != nil }

    /// What this binary was compiled with vs what's enabled now — drives the
    /// "drift" hint in Settings.
    var compiledSet: Set<AppFeature>      // registry.compiledFeatures
    var desiredCSV: String                // registry.activeFeatures rawValues, sorted, comma-joined

    func startRebuild()                   // building → readyToSwap | failed
    func swapAndRelaunch()                // spawns rebuild-swap.sh detached, then NSApp.terminate
}
```

- [ ] **Step 1: Failing tests** for the pure logic (init takes injectable seams so tests never touch Process/Bundle):

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class FeatureRebuildServiceTests: XCTestCase {

    func testDesiredCSVIsSortedRawValuesOfActiveFeatures() {
        let csv = FeatureRebuildService.featureCSV(
            for: [.agentChat, .autoTasks, .fileExplorer])
        XCTAssertEqual(csv, "agent_chat,auto_tasks,file_explorer")
    }

    func testEligibilityRequiresSourceRootAndBundleTarget() {
        XCTAssertNil(FeatureRebuildService.detectSourceRoot(
            plistValue: nil, fileExists: { _ in true }))
        XCTAssertNil(FeatureRebuildService.detectSourceRoot(
            plistValue: "/nonexistent", fileExists: { _ in false }))
        let root = FeatureRebuildService.detectSourceRoot(
            plistValue: "/repo/mac", fileExists: { $0.hasSuffix("Package.swift") })
        XCTAssertEqual(root?.path, "/repo/mac")
        XCTAssertNil(FeatureRebuildService.detectInstallTarget(
            bundleURL: URL(fileURLWithPath: "/usr/bin")))      // not an .app
        XCTAssertEqual(FeatureRebuildService.detectInstallTarget(
            bundleURL: URL(fileURLWithPath: "/tmp/LlmIdeMac.app"))?.lastPathComponent,
            "LlmIdeMac.app")
    }

    func testDriftDetection() {
        XCTAssertTrue(FeatureRebuildService.hasDrift(
            compiled: Set(AppFeature.allCases),
            active: Set(AppFeature.allCases).subtracting([.terminal])))
        XCTAssertFalse(FeatureRebuildService.hasDrift(
            compiled: Set(AppFeature.allCases),
            active: Set(AppFeature.allCases)))
    }
}
```

- [ ] **Step 2: Implement.** Static pure helpers `featureCSV(for:)` (sorted rawValues, comma-joined), `detectSourceRoot(plistValue:fileExists:)` (plist string → URL if `<root>/Package.swift` exists), `detectInstallTarget(bundleURL:)` (bundleURL when path extension == "app"), `hasDrift(compiled:active:)` (compiled ≠ compiled-relevant view: `active.symmetricDifference(compiled)` intersected with the EXCLUDABLE set — hardcode the excludable set as `[.codeGraph3D, .fileExplorer, .ganttIssues, .docGen, .terminal]` in ONE constant `FeatureRebuildService.buildTimeExcludable` with a comment tying it to Package.swift's key list). Instance layer: init reads `Bundle.main` + checks `xcrun --find swift` (cheap, cached once, off-main via Task); `startRebuild()` runs `Process` for `rebuild-features.sh --features <desiredCSV> --stage-dir <Application Support staging dir> --stage-only`, streams stdout lines into `logTail` (cap 20), sets phase; `swapAndRelaunch()` writes nothing itself — spawns `/usr/bin/nohup bash rebuild-swap.sh <staged> <target> <pid>` detached (`Process` with `standardInput/Output/Error = FileHandle.nullDevice`, no wait) then `NSApp.terminate(nil)`. Register the staged path under Application Support (`AppIdentity.applicationSupportRoot()`), cleared on `startRebuild`.
- [ ] **Step 3:** `swift test --filter FeatureRebuildServiceTests` (expect XCTest caveat → `swift build`).
- [ ] **Step 4: Commit** — `feat(mac): FeatureRebuildService(検出/CSV/ステージング駆動/スワップ起動)を追加`

---

### Task 3: Settings card + docs

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/FeatureProfileSettingsView.swift` (new "Build" card at the bottom of the Workspace section)
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` (own the service as `@StateObject`, inject)
- Modify: `docs/superpowers/specs/2026-09-02-feature-module-architecture-design.md` (Status → `…; Phase 3 (Apply & Rebuild) implemented; 2c–d pending`)
- Modify: `docs/spec/macos-app.md` + `CLAUDE.md` (document the button, eligibility, `.bak` rollback, `.rebuild.log`)

- [ ] **Step 1: UI.** In the Workspace settings, when `rebuild.isEligible`: a card titled "Build" showing (a) this binary's compiled set (from `LLMIDEFeatures` plist string or registry.compiledFeatures names), (b) a drift line when `hasDrift` ("Disabled features are still compiled into this binary"), (c) button **"Apply & Rebuild (remove disabled code)"** → confirmation dialog (explains: rebuilds from source, replaces the app, relaunches; previous version kept as .bak) → `startRebuild()`; while `.building` show ProgressView + last log lines; on `.readyToSwap` show "Restart & Install" button → `swapAndRelaunch()`; on `.failed` show the log tail + Retry. When not eligible: render nothing (no dead UI).
- [ ] **Step 2: Wiring.** `LlmIdeMacApp`: `@StateObject private var featureRebuild = FeatureRebuildService()` injected via `.environmentObject` alongside the existing ones.
- [ ] **Step 3: Verify.** Full build green. Grep gates still hold (`#if FEATURE_` confinement). Since the button can't be clicked in this environment, the integration evidence remains Task 1's stage-only run — restate its result in the report; flag the end-to-end swap as user-verifiable (click the button on a real session).
- [ ] **Step 4: Docs + commit** — `feat(mac): Settings に Apply & Rebuild を追加し Phase 3 を文書化`
