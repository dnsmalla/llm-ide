# Mac Feature Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every macOS feature its own folder under `Features/`, enforced by a boundary gate, so upgrading one feature cannot affect another.

**Architecture:** Three layers — `Core/` (leaf infrastructure), `Features/` (17 features, one folder each), `Shell/` (composition root, the only layer permitted to name every feature). The rule `Shell → Features → Core` is enforced textually by `mac/Scripts/feature-boundaries.sh`, because Swift enforces nothing inside a single target. Features are migrated and then "sealed" one at a time; a sealed feature must hold zero cross-feature references forever.

**Tech Stack:** Swift 5.9+ / SwiftUI, SwiftPM (`mac/Package.swift`), bash + perl for the gate, `make regression` as the verification harness.

**Spec:** `docs/superpowers/specs/2026-09-15-mac-feature-isolation-design.md`

## Global Constraints

- **Branch:** all work lands on `refactor/mac-feature-slices`, merged to `main` only when every feature is sealed. Never commit these to `main` directly.
- **This toolchain has no XCTest.** `swift test` never runs; `make test-mac` guards it behind `HAS_XCTEST` and `make regression` skips it. The real verification is four builds — full, lite, min, mobile-only — plus the graph and chat contract labs.
- **Never pipe `make regression`.** `make regression | tail` returns tail's exit code and has reported a red gate as green in this repo. Run it bare and read the tail of the captured output.
- **Run `make regression` before every push.** A cold `mac/.build` makes the push-time hook die with SIGPIPE, printing PASS while pushing nothing.
- **`git push` must be foreground** with a long timeout (600000 ms). A backgrounded push dies at SSH connect before the hook runs.
- **`swift build` needs `GIT_CONFIG_GLOBAL=/dev/null` and must not run sandboxed.**
- **Always grep the build log for `Invalid Exclude`.** SwiftPM treats a bad exclude path as a warning and exits 0, so a moved file silently rejoins the lite build.
- **Use `git mv`, never `mv`+`git add`.** Rename detection keeps these diffs reviewable; without it a 50-file move reads as 50 deletions and 50 additions.
- **Behavior changes are out of scope.** This plan moves files, adds two protocols, and adds one script. Anything else discovered is recorded in the task's commit message, not implemented.
- **Product naming:** user-visible **LLM-IDE**, code types **LlmIde**.
- **Commit messages:** Conventional Commits with a Japanese subject, per repo convention. End every commit with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Structure

| Path | Responsibility |
|---|---|
| `mac/Scripts/feature-boundaries.sh` | The gate. Strips comments, builds a symbol→layer map, reports and enforces cross-feature references. |
| `mac/Scripts/feature-map.txt` | `path-prefix  layer  [sealed]`. The single source of truth for which folder belongs to which layer. Grows as migration proceeds. |
| `mac/Sources/LlmIdeMac/Core/` | Leaf infrastructure: API client, project stores, keychain, theme, design system, Monaco editor, `Contracts/`. Knows nothing about any feature. |
| `mac/Sources/LlmIdeMac/Core/Contracts/` | `LoopRunning.swift`, `TaskLogWriting.swift` — the only two cross-feature protocols. |
| `mac/Sources/LlmIdeMac/Features/<Name>/{Models,Services,Views}/` | One folder per feature. 17 of them. |
| `mac/Sources/LlmIdeMac/Shell/` | Composition root: app entry, `AppShell`, `FeatureCatalog`, `FeatureRegistry`, `ShellState`. Exempt from the boundary rule by design. |
| `mac/Package.swift` | One exclude line per feature after migration, replacing Mobile's 16-entry file list. |

---

### Task 0: The boundary gate

Builds the enforcement mechanism against today's tree, before anything moves. No file moves in this task — if the gate is wrong, everything after it is built on a wrong measurement.

**Files:**
- Create: `mac/Scripts/feature-boundaries.sh`
- Create: `mac/Scripts/feature-map.txt`
- Modify: `mac/Makefile` (add `feature-gates` target; call it from `regression`)

**Interfaces:**
- Consumes: nothing.
- Produces: `mac/Scripts/feature-boundaries.sh [repo-root]` — exits 0 when every `sealed` feature has zero cross-feature references, exits 1 otherwise. Prints one line per violation as `<relative path>  ->  <owning feature>  [<symbols>]`. `mac/Scripts/feature-map.txt` — whitespace-separated `prefix layer [sealed]`, first match wins, `#` comments allowed.

- [ ] **Step 1: Create the feature map with today's five slices, none sealed yet**

`mac/Scripts/feature-map.txt`:

```
# path-prefix   layer            sealed?
# First matching prefix wins, so list most-specific prefixes first.
# Layer is: Core | Shell | Feature:<Name>
# A third column of `sealed` means the feature is enforced at ZERO
# cross-feature references. Unsealed features are reported only.
# Unlisted paths default to Shell, which is exempt — migration shrinks
# that bucket one feature at a time.

ClaudeLink/     Core
Chat/           Feature:Chat
AutoTask/       Feature:AutoTask
LoopEngine/     Feature:Loop
Graph/          Feature:CodeGraph
```

- [ ] **Step 2: Write the gate script**

`mac/Scripts/feature-boundaries.sh`:

```bash
#!/usr/bin/env bash
# Enforce the layering rule: Shell -> Features -> Core.
# A Feature may reference Core and Shell-owned symbols, but NEVER another
# Feature's. Swift has no intra-target boundary enforcement, so this is a
# textual check. See docs/superpowers/specs/2026-09-15-mac-feature-isolation-design.md
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$ROOT/Sources/LlmIdeMac"
MAP="$(dirname "$0")/feature-map.txt"
# mktemp -d alone can ignore a sandboxed TMPDIR; name the dir explicitly.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fb.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

layer_of() {
  local rel="$1" prefix lay sealed
  while read -r prefix lay sealed; do
    [[ -z "$prefix" || "$prefix" == \#* ]] && continue
    [[ "$rel" == $prefix* ]] && { echo "$lay"; return; }
  done < "$MAP"
  echo "Shell"
}

is_sealed() {
  local want="$1" prefix lay sealed
  while read -r prefix lay sealed; do
    [[ -z "$prefix" || "$prefix" == \#* ]] && continue
    [[ "$lay" == "$want" && "$sealed" == "sealed" ]] && { echo yes; return; }
  done < "$MAP"
  echo no
}

# Comments and string literals must go before ANY matching: doc-comment prose
# like "mirroring AutoCodeView's split" is not a dependency, and counting it
# produced 9 of 13 false positives when this gate was prototyped.
strip() {
  perl -0777 -pe '
    s{/\*.*?\*/}{}gs;
    s{"""[^"]*(?:"(?!"")[^"]*)*"""}{""}gs;
    s{"(?:\\.|[^"\\\n])*"}{""}g;
    s{//[^\n]*}{}g;' "$1"
}

# 1. Declaration map: symbol -> layer.
#    TOP-LEVEL declarations only (column 0). A nested `enum Error` inside a
#    Loop type otherwise claims every stdlib `Error` in the module — that one
#    bug produced 8 of the 13 false positives in the prototype.
find "$SRC" -name '*.swift' | while read -r f; do
  rel="${f#"$SRC"/}"
  strip "$f" \
    | grep -oE '^(public |internal |final |@MainActor )*(class|struct|enum|protocol|actor) [A-Z][A-Za-z0-9_]{2,}' \
    | awk -v l="$(layer_of "$rel")" '{print $NF, l}'
done | sort -u > "$WORK/decls.txt"

# Symbols declared in more than one place cannot be attributed to an owner;
# skip them rather than guess.
awk '{print $1}' "$WORK/decls.txt" | uniq -d > "$WORK/dupes.txt"
if [ -s "$WORK/dupes.txt" ]; then
  grep -vwFf "$WORK/dupes.txt" "$WORK/decls.txt" > "$WORK/owned.txt"
else
  cp "$WORK/decls.txt" "$WORK/owned.txt"
fi

awk '$2 ~ /^Feature:/ {print $2}' "$WORK/owned.txt" | sort -u > "$WORK/features.txt"

# 2. Scan every Feature-owned file for other Features' symbols.
: > "$WORK/violations.txt"
find "$SRC" -name '*.swift' | sort | while read -r f; do
  rel="${f#"$SRC"/}"
  consumer="$(layer_of "$rel")"
  [[ "$consumer" != Feature:* ]] && continue   # Core and Shell may reference anything
  body="$(strip "$f")"
  while read -r owner; do
    [[ "$owner" == "$consumer" ]] && continue
    syms="$(awk -v o="$owner" '$2==o{print $1}' "$WORK/owned.txt" | paste -sd'|' -)"
    [[ -z "$syms" ]] && continue
    hits="$(printf '%s' "$body" | grep -owE "$syms" | sort -u | paste -sd, -)"
    [[ -n "$hits" ]] && \
      echo "${consumer#Feature:}|$rel  ->  ${owner#Feature:}  [$hits]" >> "$WORK/violations.txt"
  done < "$WORK/features.txt"
done

# 3. Report everything; fail only on SEALED features.
#    A total-count ratchet would block this migration: classifying Explorer
#    makes previously-invisible Explorer<->SourceControl references countable
#    for the first time, so the total rises as a direct result of progress.
status=0
echo "=== cross-feature references ==="
sort "$WORK/violations.txt" | while IFS='|' read -r feat line; do
  if [ "$(is_sealed "Feature:$feat")" = yes ]; then
    echo "  FAIL  [sealed $feat] $line"
  else
    echo "  warn  [$feat] $line"
  fi
done
sealed_hits=0
while IFS='|' read -r feat line; do
  [ "$(is_sealed "Feature:$feat")" = yes ] && sealed_hits=$((sealed_hits+1))
done < "$WORK/violations.txt"
echo "total: $(wc -l < "$WORK/violations.txt" | tr -d ' ')  sealed violations: $sealed_hits"
[ "$sealed_hits" -gt 0 ] && { echo "FAIL: a sealed feature references another feature" >&2; status=1; }

# 4. Every Package.swift exclude path must exist. SwiftPM only WARNS on an
#    invalid exclude and exits 0, so a file moved out from under one silently
#    rejoins the lite build. This migration moves ~250 files past that hazard.
echo "=== Package.swift exclude paths ==="
missing=0
grep -oE '"[A-Za-z][^"]*\.swift"|"(Views|Services|Models|Core|Shell|Features|Graph|Chat|AutoTask|LoopEngine|Resources)[^"]*"' "$ROOT/Package.swift" \
  | tr -d '"' | sort -u | while read -r p; do
      [ -e "$SRC/$p" ] || { echo "  MISSING: $p"; }
    done > "$WORK/missing.txt"
if [ -s "$WORK/missing.txt" ]; then
  cat "$WORK/missing.txt"
  echo "FAIL: Package.swift names exclude paths that do not exist" >&2
  status=1
else
  echo "  all exclude paths exist"
fi

exit $status
```

- [ ] **Step 3: Make it executable and run it — this is the failing-test step**

```bash
chmod +x mac/Scripts/feature-boundaries.sh
cd mac && ./Scripts/feature-boundaries.sh
```

Expected output — exactly four warnings, zero sealed violations, exit 0:

```
=== cross-feature references ===
  warn  [AutoTask] AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift  ->  Loop  [AgentLoopSkillExecutor,AgentLoopStageRepairer,LoopDefinition,LoopEngineConfigStore,LoopEngineRunner,LoopRunNotifier,LoopRunTrigger,LoopStage,RegressionRunnerSweepAdapter]
  warn  [AutoTask] AutoTask/Services/AutoCodeUpdateService.swift  ->  Loop  [LoopRunTrigger]
  warn  [Loop] LoopEngine/Services/LoopRunService.swift  ->  AutoTask  [AutoTask,TaskLogStore]
  warn  [Loop] LoopEngine/Services/MobileLoopBridge.swift  ->  AutoTask  [AutoCodeUpdateService,AutoTask]
total: 4  sealed violations: 0
```

If the count is not 4, **stop and diagnose before proceeding** — every later task's ratchet depends on this number being right.

- [ ] **Step 4: Verify the two correctness properties the prototype established**

The gate must remove comment-only references and keep real ones. Check both directly:

```bash
cd mac/Sources/LlmIdeMac
STRIP='s{/\*.*?\*/}{}gs; s{"(?:\\.|[^"\\\n])*"}{""}g; s{//[^\n]*}{}g;'
# (a) comment-only reference must vanish
perl -0777 -pe "$STRIP" LoopEngine/Models/LoopEngineStatus.swift | grep -c AutoCodeUpdateService
# Expected: 0
# (b) real reference must survive
perl -0777 -pe "$STRIP" LoopEngine/Services/LoopRunService.swift | grep -n TaskLogStore
# Expected: a line "32:    weak var logStore: TaskLogStore?"
```

- [ ] **Step 5: Verify the nested-declaration rule actually matters**

Temporarily drop the `^` anchor from the declaration grep in the script, re-run, and confirm the count jumps to 13 with `Error` appearing as an owned Loop symbol. Restore the anchor. This proves the rule is load-bearing rather than decorative.

```bash
cd mac
sed -i '' "s|grep -oE '\^(public |grep -oE '(public |" Scripts/feature-boundaries.sh
./Scripts/feature-boundaries.sh | tail -3      # expect total: 13
git checkout Scripts/feature-boundaries.sh 2>/dev/null || sed -i '' "s|grep -oE '(public |grep -oE '^(public |" Scripts/feature-boundaries.sh
./Scripts/feature-boundaries.sh | tail -3      # expect total: 4
```

- [ ] **Step 6: Wire into the Makefile**

Add to `mac/Makefile`:

```make
.PHONY: feature-gates
feature-gates:
	@./Scripts/feature-boundaries.sh
```

Then add `feature-gates` to the `regression` target's prerequisites, before the build targets — it runs in ~16 s and failing fast beats failing after four Swift builds.

- [ ] **Step 7: Run the full gate**

```bash
cd mac && make feature-gates
```

Expected: the same four warnings, exit 0.

- [ ] **Step 8: Commit**

```bash
git switch -c refactor/mac-feature-slices
git add mac/Scripts/feature-boundaries.sh mac/Scripts/feature-map.txt mac/Makefile
git commit -m "$(cat <<'EOF'
chore(mac): 機能境界ゲートを追加する

Swift は単一ターゲット内の依存境界を強制できないため、
シンボル宣言とその参照をテキストで照合するゲートを追加する。

照合前にコメントと文字列リテラルを除去し、宣言はトップレベル
（カラム 0）のみを数える。この 2 点がない試作版は 13 件を報告したが、
うち 9 件は doc コメント中の記述、8 件はネストした enum Error が
stdlib の Error を巻き込んだ誤検出だった。実際の違反は 4 件である。

封印（sealed）した機能のみゼロを強制し、未封印は報告のみとする。
合計値で縛ると、Explorer を分離した時点で従来不可視だった参照が
可視化され合計が増えるため、移行作業自体が落ちてしまう。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Extract `Core/`

Establishes the layer every later task moves against. Pure file moves — Swift has one module here, so no `import` statements change and the compiler resolves everything exactly as before. That property is what makes this whole migration safe.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Core/{Networking,Project,Platform,DesignSystem,Editor,Contracts}/`
- Move: 40 files listed below
- Modify: `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: the gate from Task 0.
- Produces: the `Core` layer. Every later task may reference any symbol under `Core/` from anywhere without violating the rule. `Core/Contracts/` is created empty here and filled by Tasks 17–18.

- [ ] **Step 1: Create the directories**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Core/Networking Core/Project Core/Platform Core/DesignSystem Core/Editor Core/Contracts
```

- [ ] **Step 2: Move networking**

```bash
git mv Services/API Core/Networking/API
git mv Services/LlmIdeAPIClient.swift Core/Networking/
```

- [ ] **Step 3: Move project and platform infrastructure**

```bash
git mv Services/ProjectStore.swift Services/ProjectPaths.swift \
       Services/ProjectLayout.swift Services/WorkspaceRoot.swift Core/Project/
git mv Services/AppEnvironment.swift Services/KeychainStore.swift \
       Services/BashService.swift Services/ResourceGuard.swift Core/Platform/
git mv Models/Config.swift Models/AppIdentity.swift Models/Theme.swift \
       Models/Strings.swift Models/Date+ISO.swift Models/FileIconKit.swift Core/Platform/
```

- [ ] **Step 4: Move `RegressionRunner` to Core**

It has four feature consumers plus `FeatureCatalog`, and no feature owns it. Core membership is what makes it importable everywhere without a protocol — this is why the design dropped the `RegressionRunning` protocol it originally proposed.

```bash
git mv Services/RegressionRunner.swift Core/Platform/
```

- [ ] **Step 5: Move the design system and editor**

```bash
git mv Views/Components Core/DesignSystem
git mv Views/Shared/MonacoDiffView.swift Views/Shared/MonacoEditorView.swift \
       Views/Shared/MonacoHost.swift Views/Shared/MonacoLanguageMap.swift \
       Views/Shared/MonacoRevealGate.swift Views/Shared/HljsWebView.swift \
       Views/Shared/HtmlPreviewWebView.swift Views/Shared/Mermaid.swift Core/Editor/
git mv Services/MonacoBridge.swift Services/GitGutter.swift Core/Editor/
```

- [ ] **Step 6: Record Core in the feature map**

`ClaudeLink/` stays where it is. It is Core by role, but `CLAUDE.md` and `docs/explanation/claude-linker.md` both name its path as the place all Claude SDK knowledge lives; moving it would mean a doc migration for no compile-time benefit. The map records its layer instead.

Prepend to `mac/Scripts/feature-map.txt`, above the feature lines:

```
Core/           Core
ClaudeLink/     Core
```

(and delete the now-duplicate `ClaudeLink/ Core` line further down)

- [ ] **Step 7: Verify the gate is unchanged**

```bash
cd mac && ./Scripts/feature-boundaries.sh | tail -5
```

Expected: `total: 4  sealed violations: 0`, and `all exclude paths exist`. Moving files into Core must not change the count — Core is exempt as an owner and as a consumer.

- [ ] **Step 8: Build**

```bash
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -20
```

Expected: `Build complete`. No `Invalid Exclude` warnings.

- [ ] **Step 9: Commit**

```bash
git add -A mac/Sources/LlmIdeMac mac/Scripts/feature-map.txt
git commit -m "$(cat <<'EOF'
refactor(mac): Core レイヤを抽出する

API クライアント、プロジェクトストア、プラットフォーム基盤、
デザインシステム、Monaco エディタを Core/ に集約する。
いずれも特定機能に属さない末端の基盤であり、全機能から参照してよい。

RegressionRunner は Loop / AutoTask / Graph / CodeWorkflow と
FeatureCatalog から使われ、単一の所有機能が存在しないため Core に置く。
これによりプロトコルによる迂回が不要になる。

ClaudeLink/ は役割としては Core だが、CLAUDE.md と
docs/explanation/claude-linker.md がパスを明記しているため
移動せず feature-map.txt 上で Core と宣言するに留める。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract `Shell/`

The composition root. These files are *allowed* to name every feature — making that permission a visible directory rather than an implicit exemption is the point.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Shell/`
- Move: 19 files
- Modify: `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/` from Task 1.
- Produces: the `Shell` layer. The gate grants `Shell` a blanket exemption as both consumer and owner.

- [ ] **Step 1: Create the directory and move the composition root**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Shell
git mv LlmIdeMacApp.swift FeatureCatalog.swift Shell/
git mv Views/AppShell.swift Views/ContentView.swift Shell/
git mv Services/FeatureRegistry.swift Services/ShellState.swift \
       Services/DeepLinkRouter.swift Shell/
git mv Models/AppFeature.swift Shell/
git mv Views/Shell Shell/Chrome
```

- [ ] **Step 2: Record Shell in the feature map**

Add above the `Core/` lines in `mac/Scripts/feature-map.txt` (most specific first):

```
Shell/          Shell
```

- [ ] **Step 3: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh | tail -5
```

Expected: `total: 4  sealed violations: 0`. Unchanged — Shell is exempt.

- [ ] **Step 4: Build all four configurations**

This is the first task that moves the app entry point, so verify every feature configuration rather than just the default build.

```bash
cd mac && make regression 2>&1 | tail -40
```

Do **not** pipe this to `tail` as the command's only consumer in a way that masks the exit code — capture to a file and inspect, or run bare and read the output:

```bash
cd mac && make regression > /tmp/reg.log 2>&1; echo "exit=$?"; tail -40 /tmp/reg.log
grep -c "Invalid Exclude" /tmp/reg.log   # expected: 0
```

Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add -A mac/Sources/LlmIdeMac mac/Scripts/feature-map.txt
git commit -m "$(cat <<'EOF'
refactor(mac): Shell レイヤを抽出する

アプリ起動点、AppShell、FeatureCatalog、FeatureRegistry、ShellState、
DeepLinkRouter、およびシェル用クローム部品を Shell/ に集約する。

これらは全機能を名指しすることが許された唯一の層である。
その特権を暗黙の除外ではなくディレクトリとして可視化することが目的で、
ゲートは Shell を参照元・参照先の双方で免除する。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Tasks 3–8: the zero-edge leaves

These six features have no cross-feature references. They are sealed immediately on arrival, which is what makes them the right place to prove the ratchet works on real moves before touching anything entangled.

Every one of these tasks follows the same shape, and each states its own commands in full so it can be executed without reading its neighbours.

---

### Task 3: Search

**Files:**
- Move: `Views/Search/` (1 file), `Services/SearchEngine.swift`, `Services/SearchService.swift`
- Modify: `mac/Package.swift:61`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/` from Tasks 1–2.
- Produces: `Features/Search/` — sealed. No symbol under it may be referenced by another feature.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/Search/Services Features/Search/Views
git mv Views/Search/* Features/Search/Views/ && rmdir Views/Search
git mv Services/SearchEngine.swift Services/SearchService.swift Features/Search/Services/
```

- [ ] **Step 2: Update `Package.swift`**

Search is excluded together with Explorer (it is reached through the Explorer panel's section switcher). In the `if explorerIncluded { … } else { … }` branch, replace `"Views/Search"` with `"Features/Search"`:

```swift
libExcludes.append(contentsOf: ["Views/Explorer", "Features/Search", "Views/SourceControl"])
```

- [ ] **Step 3: Seal it in the feature map**

Add to `mac/Scripts/feature-map.txt`:

```
Features/Search/    Feature:Search    sealed
```

- [ ] **Step 4: Verify the gate — Search must show zero**

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 4  sealed violations: 0`, no line mentioning `Search`, and `all exclude paths exist`. If a `FAIL [sealed Search]` line appears, Search has a real cross-feature reference the audit missed — resolve it before sealing rather than un-sealing.

- [ ] **Step 5: Build lite and min, where the exclude actually fires**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log    # expected: 0
GIT_CONFIG_GLOBAL=/dev/null make build-mac-min > /tmp/min.log 2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/min.log     # expected: 0
```

Expected: `exit=0` for both, zero `Invalid Exclude`.

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Search を Features/Search に分離し封印する

クロス機能参照ゼロを確認のうえ sealed 指定する。
Package.swift の除外は Views/Search から Features/Search へ 1 行変更。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Review Conflicts

The smallest feature in the app — one view. Worth its own task because sealing it costs nothing and the folder is where conflict-review code goes next time.

**Files:**
- Move: `Views/ReviewView.swift`
- Modify: `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/ReviewConflicts/` — sealed.

- [ ] **Step 1: Move the file**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/ReviewConflicts/Views
git mv Views/ReviewView.swift Features/ReviewConflicts/Views/
```

- [ ] **Step 2: Seal it**

`Package.swift` needs no change — Review Conflicts is not build-excludable. Add to `mac/Scripts/feature-map.txt`:

```
Features/ReviewConflicts/    Feature:ReviewConflicts    sealed
```

- [ ] **Step 3: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh | tail -5
```

Expected: `total: 4  sealed violations: 0`.

- [ ] **Step 4: Build**

```bash
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -5
```

Expected: `Build complete`.

- [ ] **Step 5: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Review Conflicts を Features/ReviewConflicts に分離し封印する

ビュー 1 枚のみだが、次に競合レビュー用コードを追加する際の
置き場所を確定させる意味でフォルダを与える。
ビルド除外対象ではないため Package.swift の変更はない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Visual

**Files:**
- Move: `Views/Visual/` (4 files)
- Modify: `mac/Package.swift:78`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/Visual/` — sealed. Note Visual rides on the `docGen` build flag, not one of its own.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/Visual/Views
git mv Views/Visual/* Features/Visual/Views/ && rmdir Views/Visual
```

- [ ] **Step 2: Update `Package.swift`**

In the `if docGenIncluded { … } else { … }` branch, replace `"Views/Visual"`:

```swift
libExcludes.append(contentsOf: ["Views/DocGen", "Features/Visual"])
```

- [ ] **Step 3: Seal it**

```
Features/Visual/    Feature:Visual    sealed
```

- [ ] **Step 4: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh | tail -5
```

Expected: `total: 4  sealed violations: 0`, `all exclude paths exist`.

- [ ] **Step 5: Build lite (where docGen is excluded)**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log    # expected: 0
```

Expected: `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Visual を Features/Visual に分離し封印する

Visual は独自フラグを持たず doc_gen フラグに相乗りしているため、
Package.swift の除外も docGenIncluded 側の 1 行変更に留まる。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Gantt

**Files:**
- Move: `Views/Gantt/` (5 files)
- Modify: `mac/Package.swift:66`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/Gantt/` — sealed. Gantt and Issues share the `gantt` build flag but become separate folders; the shared flag stays, the shared folder does not.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/Gantt/Views
git mv Views/Gantt/* Features/Gantt/Views/ && rmdir Views/Gantt
```

- [ ] **Step 2: Update `Package.swift`**

In the `if ganttIncluded { … } else { … }` branch:

```swift
libExcludes.append(contentsOf: ["Features/Gantt", "Views/Issues"])
```

- [ ] **Step 3: Seal it**

```
Features/Gantt/    Feature:Gantt    sealed
```

- [ ] **Step 4: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 4  sealed violations: 0`. Watch specifically for a `FAIL [sealed Gantt] … -> Issues` line — Gantt and Issues are the likeliest pair in this plan to have a real edge, and sealing Gantt before Issues moves is what surfaces it.

- [ ] **Step 5: Build lite**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log    # expected: 0
```

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Gantt を Features/Gantt に分離し封印する

Gantt と Issues はビルドフラグを共有し続けるが、フォルダは分ける。
共有するのはフラグであってコードではない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Issues

**Files:**
- Move: `Views/Issues/` (4 files), `Views/ExistingIssuePicker.swift`, `Services/RecentIssuesResolver.swift`
- Modify: `mac/Package.swift:66`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/Issues/` — sealed.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/Issues/Services Features/Issues/Views
git mv Views/Issues/* Features/Issues/Views/ && rmdir Views/Issues
git mv Views/ExistingIssuePicker.swift Features/Issues/Views/
git mv Services/RecentIssuesResolver.swift Features/Issues/Services/
```

- [ ] **Step 2: Update `Package.swift`**

The `ganttIncluded` else-branch now excludes two feature folders:

```swift
libExcludes.append(contentsOf: ["Features/Gantt", "Features/Issues"])
```

- [ ] **Step 3: Seal it**

```
Features/Issues/    Feature:Issues    sealed
```

- [ ] **Step 4: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 4  sealed violations: 0`. Both Gantt and Issues are now sealed, so any reference between them fails the build here.

- [ ] **Step 5: Build lite**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log    # expected: 0
```

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Issues を Features/Issues に分離し封印する

Gantt と Issues が双方とも封印されたため、両者間の参照は
以降ビルドを落とす。ganttIncluded の除外は 2 フォルダ指定になる。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Terminal

**Files:**
- Move: `Views/Terminal/` (6 files), `Views/Shell/TerminalPanelState.swift` (now at `Shell/Chrome/TerminalPanelState.swift` after Task 2)
- Modify: `mac/Package.swift:83`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/Terminal/` — sealed.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/Terminal/Models Features/Terminal/Views
git mv Views/Terminal/* Features/Terminal/Views/ && rmdir Views/Terminal
git mv Shell/Chrome/TerminalPanelState.swift Features/Terminal/Models/
```

- [ ] **Step 2: Update `Package.swift`**

```swift
libExcludes.append("Features/Terminal")
```

- [ ] **Step 3: Seal it**

```
Features/Terminal/    Feature:Terminal    sealed
```

- [ ] **Step 4: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh | tail -5
```

Expected: `total: 4  sealed violations: 0`.

Note `TerminalPanelState` moved *out* of Shell into a sealed feature. If Shell chrome referenced it, that is still legal (Shell may reference any feature) — but if another feature did, this seals against it now.

- [ ] **Step 5: Build lite and min**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
GIT_CONFIG_GLOBAL=/dev/null make build-mac-min  > /tmp/min.log  2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log /tmp/min.log   # expected: 0 for both
```

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Terminal を Features/Terminal に分離し封印する

TerminalPanelState を Shell のクロームから機能側へ移す。
Shell から機能を参照するのは合法であり、逆方向のみを封印する。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Tasks 9–14: the medium features

Larger moves with real internal structure. From here on, a feature that owns a Settings section moves that section into its own folder and exposes it through a `FeatureCatalog` factory, following the `graphSettingsSection()` precedent already in that file. Settings stops owning other features' panels.

---

### Task 9: Live

**Files:**
- Move: `Services/CaptionScraper/` (5), `Services/AutoCaptureService.swift`, `Services/LiveSessionMirror.swift`, `Services/PermissionsService.swift`, `Models/Caption.swift`, `Models/MeetingCaptureMatrix.swift`, `Views/TranscriptView.swift`, `Views/PermissionsView.swift`, `Views/Settings/MeetingCaptureMatrixView.swift`
- Modify: `mac/Scripts/feature-map.txt`, `Shell/FeatureCatalog.swift`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/Live/` — sealed. Adds `FeatureCatalog.liveCaptureSettingsSection() -> AnyView?` returning `MeetingCaptureMatrixView`.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/Live/{Models,Services,Views}
git mv Services/CaptionScraper/* Features/Live/Services/ && rmdir Services/CaptionScraper
git mv Services/AutoCaptureService.swift Services/LiveSessionMirror.swift \
       Services/PermissionsService.swift Features/Live/Services/
git mv Models/Caption.swift Models/MeetingCaptureMatrix.swift Features/Live/Models/
git mv Views/TranscriptView.swift Views/PermissionsView.swift Features/Live/Views/
git mv Views/Settings/MeetingCaptureMatrixView.swift Features/Live/Views/
```

- [ ] **Step 2: Expose the settings section through the catalog**

Add to `Shell/FeatureCatalog.swift`, in a new `// MARK: - Live` section. Live is not build-excludable, so there is no `#if` — the factory exists to keep Settings from naming a Live type directly:

```swift
// MARK: - Live

/// Live capture's own settings panel. Settings composes contributed
/// sections rather than owning each feature's panel — same seam as
/// `graphSettingsSection()`.
static func liveCaptureSettingsSection() -> AnyView? {
    AnyView(MeetingCaptureMatrixView())
}
```

Then in `Views/SettingsView.swift`, replace the direct `MeetingCaptureMatrixView()` construction with `FeatureCatalog.liveCaptureSettingsSection()`.

- [ ] **Step 3: Seal it**

```
Features/Live/    Feature:Live    sealed
```

- [ ] **Step 4: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 4  sealed violations: 0`. `SettingsView` is still in the unclassified (Shell-exempt) bucket at this point, so it may name Live freely; the factory is preparation for Task 13, which classifies Settings.

- [ ] **Step 5: Build**

```bash
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -10
```

Expected: `Build complete`.

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Live を Features/Live に分離し封印する

キャプションスクレイパ、自動キャプチャ、セッションミラー、
権限サービスと会議キャプチャ設定を 1 フォルダに集約する。

設定パネルは FeatureCatalog.liveCaptureSettingsSection() 経由で
提供する。Settings が各機能のパネルを所有するのをやめ、
機能側が寄与する形に改める第一歩（先例は graphSettingsSection）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Explorer

**Files:**
- Move: `Views/Explorer/` (4), `Views/CodeCompletion/` (3), `Services/Explorer*.swift` (6), `Services/ExplorerTreeStore.swift`, `Services/FileSystemTree.swift`, `Services/IgnoreList.swift`, `Services/GlobMatch.swift`, `Services/GitIgnoreRules.swift`, `Views/Shared/FileTreePanel.swift`, `Views/Shared/EditorTabBar.swift`, `Views/Shared/TreeRowLabel.swift`
- Modify: `mac/Package.swift:61`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/` (notably `Core/Editor/` for Monaco), `Shell/`.
- Produces: `Features/Explorer/` — sealed.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/Explorer/{Models,Services,Views}
git mv Views/Explorer/* Features/Explorer/Views/ && rmdir Views/Explorer
git mv Views/CodeCompletion/* Features/Explorer/Views/ && rmdir Views/CodeCompletion
git mv Services/ExplorerClipboard.swift Services/ExplorerDragPayload.swift \
       Services/ExplorerFileOps.swift Services/ExplorerKeyCommand.swift \
       Services/ExplorerPaths.swift Services/ExplorerRenameName.swift \
       Services/ExplorerTreeStore.swift Features/Explorer/Services/
git mv Services/FileSystemTree.swift Services/IgnoreList.swift \
       Services/GlobMatch.swift Services/GitIgnoreRules.swift Features/Explorer/Services/
git mv Views/Shared/FileTreePanel.swift Views/Shared/EditorTabBar.swift \
       Views/Shared/TreeRowLabel.swift Features/Explorer/Views/
```

- [ ] **Step 2: Update `Package.swift`**

```swift
libExcludes.append(contentsOf: ["Features/Explorer", "Features/Search", "Views/SourceControl"])
```

- [ ] **Step 3: Seal it**

```
Features/Explorer/    Feature:Explorer    sealed
```

- [ ] **Step 4: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 4  sealed violations: 0`.

Two edges are plausible here and must be resolved rather than waived if they appear: Explorer→Source Control (via `GitIgnoreRules` or gutter state) and Explorer→Chat (`ExplorerMobileEngineResolver` lives in `Chat/Session/`, so the reference would run the other way and is Chat's problem in Task 19, not Explorer's).

- [ ] **Step 5: Build lite and min**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
GIT_CONFIG_GLOBAL=/dev/null make build-mac-min  > /tmp/min.log  2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log /tmp/min.log   # expected: 0 for both
```

Both must be `exit=0`. Explorer is excluded in both configurations, so this is the strongest exclude check in the plan.

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Explorer を Features/Explorer に分離し封印する

Views/Shared に置かれていた FileTreePanel / EditorTabBar / TreeRowLabel は
実際には Explorer 専用であり、共有部品ではなかったため取り込む。
Monaco 系は Core/Editor に残り、Explorer はそれを参照する。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Source Control

**Files:**
- Move: `Views/SourceControl/` (1), `Services/SourceControlService.swift`, `Services/SCMModels.swift`, `Services/SCMParsers.swift`, `Services/GitLog.swift`, `Services/GitTruthStore.swift`, `Services/GitHubClient.swift`, `Services/GitLabClient.swift`, `Services/GlabAuthSync.swift`, `Services/Repo/` (6), `Services/RepoManager.swift`, `Services/SavedRepoPathReconciler.swift`, `Services/IndexedReposResolver.swift`, `Models/GitHubModels.swift`, `Models/GitLabModels.swift`, `Models/RepoOperation.swift`, `Views/BranchCreationSheet.swift`, `Views/PRCreationSheet.swift`, `Views/GitOpSheet.swift`, `Views/Shared/HunkStagingList.swift`, `Views/Repo/` (1), `Views/Settings/GitHubSettingsSection.swift`, `Views/Settings/GitLabSettingsSection.swift`, `Views/Settings/RepoSettingsSection.swift`
- Modify: `mac/Package.swift:61`, `mac/Scripts/feature-map.txt`, `Shell/FeatureCatalog.swift`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/SourceControl/` — sealed. Adds `FeatureCatalog.sourceControlSettingsSections() -> [AnyView]` returning the GitHub, GitLab and Repo panels.

- [ ] **Step 1: Move services and models**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/SourceControl/{Models,Services,Views}
git mv Services/SourceControlService.swift Services/SCMModels.swift \
       Services/SCMParsers.swift Services/GitLog.swift Services/GitTruthStore.swift \
       Services/GitHubClient.swift Services/GitLabClient.swift Services/GlabAuthSync.swift \
       Services/RepoManager.swift Services/SavedRepoPathReconciler.swift \
       Services/IndexedReposResolver.swift Features/SourceControl/Services/
git mv Services/Repo/* Features/SourceControl/Services/ && rmdir Services/Repo
git mv Models/GitHubModels.swift Models/GitLabModels.swift Models/RepoOperation.swift \
       Features/SourceControl/Models/
```

- [ ] **Step 2: Move views**

```bash
git mv Views/SourceControl/* Features/SourceControl/Views/ && rmdir Views/SourceControl
git mv Views/Repo/* Features/SourceControl/Views/ && rmdir Views/Repo
git mv Views/BranchCreationSheet.swift Views/PRCreationSheet.swift Views/GitOpSheet.swift \
       Features/SourceControl/Views/
git mv Views/Shared/HunkStagingList.swift Features/SourceControl/Views/
git mv Views/Settings/GitHubSettingsSection.swift Views/Settings/GitLabSettingsSection.swift \
       Views/Settings/RepoSettingsSection.swift Features/SourceControl/Views/
```

- [ ] **Step 3: Expose the settings sections**

Add to `Shell/FeatureCatalog.swift`:

```swift
// MARK: - Source Control

/// Source Control's settings panels. Gated on the Explorer flag, which is
/// what excludes Source Control from lite/min builds.
static func sourceControlSettingsSections() -> [AnyView] {
    #if FEATURE_EXPLORER
    return [AnyView(GitHubSettingsSection()),
            AnyView(GitLabSettingsSection()),
            AnyView(RepoSettingsSection())]
    #else
    return []
    #endif
}
```

Replace the three direct constructions in `Views/SettingsView.swift` with a loop over `FeatureCatalog.sourceControlSettingsSections()`.

- [ ] **Step 4: Update `Package.swift` and seal**

```swift
libExcludes.append(contentsOf: ["Features/Explorer", "Features/Search", "Features/SourceControl"])
```

```
Features/SourceControl/    Feature:SourceControl    sealed
```

- [ ] **Step 5: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 4  sealed violations: 0`. Explorer is already sealed, so an Explorer→Source Control reference fails here — if it does, move the shared piece to `Core/` rather than un-sealing either feature.

- [ ] **Step 6: Build lite and min**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
GIT_CONFIG_GLOBAL=/dev/null make build-mac-min  > /tmp/min.log  2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log /tmp/min.log   # expected: 0 for both
```

- [ ] **Step 7: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Source Control を Features/SourceControl に分離し封印する

Git / GitHub / GitLab クライアント、SCM モデルとパーサ、リポジトリ
バックエンド、各種シートと設定パネルを 1 フォルダに集約する。

GitHub / GitLab / Repo の設定パネルは
FeatureCatalog.sourceControlSettingsSections() 経由で提供し、
Settings が Source Control の型を直接名指しするのをやめる。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Doc Gen

**Files:**
- Move: `Views/DocGen/` (4), `Services/DocCommandStore.swift`, `Services/DocGenOutputStore.swift`, `Services/DocTemplateStore.swift`, `Services/ProjectDocCommandsSeeder.swift`, `Services/ProjectDocTemplatesSeeder.swift`, `Services/GenerationLibraryStore.swift`, `Services/GenerationConformance.swift`, `Services/GenerationRegistry.swift`, `Models/DocCommand.swift`, `Models/DocGenOutputConfig.swift`, `Models/DocTemplate.swift`, `Models/TemplateSurface.swift`, `Views/Shared/Generation*.swift` (7), `Views/Shared/DocTemplateManagerSheet.swift`
- Modify: `mac/Package.swift:78`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/DocGen/` — **not sealed in this task.** Visual (Task 5, already sealed) shares the generation pipeline, so sealing Doc Gen here would likely fail. Sealing happens in Task 23 once the shared pieces are resolved.

- [ ] **Step 1: Move the files**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features/DocGen/{Models,Services,Views}
git mv Views/DocGen/* Features/DocGen/Views/ && rmdir Views/DocGen
git mv Services/DocCommandStore.swift Services/DocGenOutputStore.swift \
       Services/DocTemplateStore.swift Services/ProjectDocCommandsSeeder.swift \
       Services/ProjectDocTemplatesSeeder.swift Services/GenerationLibraryStore.swift \
       Services/GenerationConformance.swift Services/GenerationRegistry.swift \
       Features/DocGen/Services/
git mv Models/DocCommand.swift Models/DocGenOutputConfig.swift \
       Models/DocTemplate.swift Models/TemplateSurface.swift Features/DocGen/Models/
git mv Views/Shared/GenerationEditorPanel.swift Views/Shared/GenerationPromptBar.swift \
       Views/Shared/GenerationSaveChatOutputRow.swift Views/Shared/GenerationSetupSection.swift \
       Views/Shared/GenerationSourceTree.swift Views/Shared/GenerationTemplateSection.swift \
       Views/Shared/GenerationTreeSelection.swift Views/Shared/GenerationViewModel.swift \
       Views/Shared/DocTemplateManagerSheet.swift Features/DocGen/Views/
```

- [ ] **Step 2: Update `Package.swift`**

```swift
libExcludes.append(contentsOf: ["Features/DocGen", "Features/Visual"])
```

- [ ] **Step 3: Record it as UNSEALED**

```
Features/DocGen/    Feature:DocGen
```

No third column. The gate will report Visual→DocGen references as warnings; that is expected and is the input to Task 23.

- [ ] **Step 4: Run the gate and record what it finds**

```bash
cd mac && ./Scripts/feature-boundaries.sh > /tmp/gate-docgen.txt; echo "exit=$?"
grep -E "Visual|DocGen" /tmp/gate-docgen.txt
```

Expected: `exit=0` (no sealed violations), and a list of `FAIL [sealed Visual] … -> DocGen` lines **if Visual references generation types**. If such lines appear the build fails — Visual is already sealed. In that case, move the shared generation types Visual needs into `Core/` in this same task, since generation is demonstrably not Doc Gen's alone, and re-run.

- [ ] **Step 5: Build lite**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log    # expected: 0
```

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Doc Gen を Features/DocGen に分離する

Views/Shared の Generation* 7 ファイルは共有部品ではなく
Doc Gen と Visual の生成パイプラインであったため取り込む。

Visual と生成パイプラインを共有するため、本タスクでは封印しない。
Visual 側で必要な型は Core へ移し、封印は最終タスクで行う。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Settings

By this point Live and Source Control have already taken their own panels. What remains is the Settings shell plus genuinely global panels.

**Files:**
- Move: `Views/SettingsView.swift`, `Views/Settings/` remaining 12 files, `Services/UpdateService.swift`, `Services/FeatureRebuildService.swift`, `Views/HelpGuideView.swift`
- Move to Core: `Models/AICliTool.swift`, `Models/CustomProvider.swift`, `Models/ProviderCatalog.swift`
- Modify: `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`, and every `FeatureCatalog.*SettingsSection*()` factory added by Tasks 9 and 11.
- Produces: `Features/Settings/` — **not sealed in this task.** Settings legitimately composes other features' panels; it is sealed in Task 23 only once every panel arrives through a `FeatureCatalog` factory.

- [ ] **Step 1: Move provider configuration to Core first**

These three describe *which model provider is configured*, which Chat, Auto Tasks and Loop all read. They are not Settings' property even though Settings edits them.

```bash
cd mac/Sources/LlmIdeMac
git mv Models/AICliTool.swift Models/CustomProvider.swift Models/ProviderCatalog.swift \
       Core/Platform/
```

- [ ] **Step 2: Move Settings**

```bash
mkdir -p Features/Settings/{Services,Views}
git mv Views/SettingsView.swift Views/HelpGuideView.swift Features/Settings/Views/
git mv Views/Settings/* Features/Settings/Views/ && rmdir Views/Settings
git mv Services/UpdateService.swift Services/FeatureRebuildService.swift \
       Features/Settings/Services/
```

- [ ] **Step 3: Record it as UNSEALED**

```
Features/Settings/    Feature:Settings
```

- [ ] **Step 4: Run the gate and capture the remaining Settings edges**

```bash
cd mac && ./Scripts/feature-boundaries.sh > /tmp/gate-settings.txt; echo "exit=$?"
grep "\[Settings\]" /tmp/gate-settings.txt
```

Expected: `exit=0`, plus a warn line for every feature panel Settings still constructs directly. **Write that list into the commit message** — it is the exact remaining work for Task 23, and capturing it here is cheaper than rediscovering it.

- [ ] **Step 5: Build all four configurations**

Settings is reachable in every build, including min.

```bash
cd mac && make regression > /tmp/reg.log 2>&1; echo "exit=$?"; tail -30 /tmp/reg.log
grep -c "Invalid Exclude" /tmp/reg.log   # expected: 0
```

Expected: `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Settings を Features/Settings に分離する

プロバイダ設定（AICliTool / CustomProvider / ProviderCatalog）は
Chat・Auto Tasks・Loop からも読まれる横断的な設定であり、
Settings の所有物ではないため Core/Platform へ移す。

Settings は各機能のパネルを合成する立場であり、すべてのパネルが
FeatureCatalog のファクトリ経由になるまで封印しない。
残存する直接参照はゲート出力として本コミットに記録する。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Library

The largest non-Chat feature, and the hub the product is built around.

**Files:**
- Move: `Views/Library/` (25), `Views/Sources/` (5), `Services/NotesFolder/` (16), `SourceConnectors/` (5), `Sources/` (5), `Services/LibraryItemStore.swift`, `Services/NoteService.swift`, `Services/SourceIngestService.swift`, `Services/SourceLinkStore.swift`, `Services/MeetingNoteGenerator.swift`, `Services/MeetingSummarizationService.swift`, `Services/PluginMarketplace.swift`, `Services/PluginGitInstaller.swift`, `Services/LegacyExporter.swift`, `Services/ProjectExporter.swift`, `Models/LibraryItem.swift`, `Models/LibraryItem+UI.swift`, `Models/MeetingFrontmatter.swift`, `Models/MeetingSummary.swift`, `Models/MarkdownFrontmatter.swift`, `Models/NoteAction.swift`, `Models/ProjectExportBundle.swift`
- Move to Core: `Views/Library/MarkdownRenderer.swift`, `Views/Library/SelfSizingMarkdownView.swift`
- Modify: `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/Library/` — sealed. `MarkdownRenderer` and `SelfSizingMarkdownView` land in `Core/DesignSystem/` because Chat renders markdown too.

- [ ] **Step 1: Move the two markdown views to Core before anything else**

Chat's bubble rendering depends on `SelfSizingMarkdownView`. Leaving it in Library would create a Chat→Library edge the moment Chat is sealed in Task 21.

```bash
cd mac/Sources/LlmIdeMac
git mv Views/Library/MarkdownRenderer.swift Views/Library/SelfSizingMarkdownView.swift \
       Core/DesignSystem/
```

- [ ] **Step 2: Move the feature**

```bash
mkdir -p Features/Library/{Models,Services,Views}
git mv Views/Library/* Features/Library/Views/ && rmdir Views/Library
git mv Views/Sources/* Features/Library/Views/ && rmdir Views/Sources
git mv Services/NotesFolder/* Features/Library/Services/ && rmdir Services/NotesFolder
git mv SourceConnectors/* Features/Library/Services/ && rmdir SourceConnectors
git mv Sources/* Features/Library/Services/ && rmdir Sources
git mv Services/LibraryItemStore.swift Services/NoteService.swift \
       Services/SourceIngestService.swift Services/SourceLinkStore.swift \
       Services/MeetingNoteGenerator.swift Services/MeetingSummarizationService.swift \
       Services/PluginMarketplace.swift Services/PluginGitInstaller.swift \
       Services/LegacyExporter.swift Services/ProjectExporter.swift \
       Features/Library/Services/
git mv Models/LibraryItem.swift Models/LibraryItem+UI.swift \
       Models/MeetingFrontmatter.swift Models/MeetingSummary.swift \
       Models/MarkdownFrontmatter.swift Models/NoteAction.swift \
       Models/ProjectExportBundle.swift Features/Library/Models/
```

- [ ] **Step 3: Seal it**

```
Features/Library/    Feature:Library    sealed
```

- [ ] **Step 4: Verify the gate**

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 4  sealed violations: 0`. Library is sealed and Live is sealed, so a Library→Live reference (meeting notes reading capture state) fails here. If it does, the shared type belongs in `Core/`.

- [ ] **Step 5: Build all four configurations**

Library is present in every build including min, and this task moved 50+ files.

```bash
cd mac && make regression > /tmp/reg.log 2>&1; echo "exit=$?"; tail -30 /tmp/reg.log
grep -c "Invalid Exclude" /tmp/reg.log   # expected: 0
```

Expected: `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Library を Features/Library に分離し封印する

ノートフォルダ、ソースコネクタ、プラグインライブラリ、
会議ノート生成と要約を 1 フォルダに集約する。

MarkdownRenderer と SelfSizingMarkdownView は Chat も描画に使うため
Core/DesignSystem へ移す。Library に残すと Chat 封印時に
Chat→Library の参照が発生してしまう。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Mobile Control

The task that pays the clearest dividend: `Package.swift`'s 16-entry file-level exclude list collapses to one folder line, and moving `MobileLoopBridge` out of `LoopEngine/` deletes one of the four remaining cross-feature references outright.

**Files:**
- Move: `Services/Mobile*.swift` (11, **except** `MobileFeatureBridge.swift`), `Services/PairingThrottle.swift`, `Features/Settings/Views/MobileControlSettingsSection.swift`, `Chat/Session/ExplorerMobileEngineResolver.swift`, `AutoTask/Services/MobileAutoTaskBridge.swift`, `LoopEngine/Services/MobileLoopBridge.swift`
- Move to Core: `Services/MobileFeatureBridge.swift`
- Modify: `mac/Package.swift:147-190`, `mac/Scripts/feature-map.txt`, `Shell/FeatureCatalog.swift`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/MobileControl/` — **not sealed in this task**, because `MobileLoopBridge` and `MobileAutoTaskBridge` still name Loop and AutoTask types directly. Sealed in Task 23, after Tasks 17–18 give them protocols.

- [ ] **Step 1: `MobileFeatureBridge` goes to Core, not to the feature**

It is the seam *protocol*, and `CLAUDE.md` states it stays in-tree when Mobile is compiled out so other features can degrade. Core is where that requirement is satisfiable.

```bash
cd mac/Sources/LlmIdeMac
git mv Services/MobileFeatureBridge.swift Core/Contracts/
```

- [ ] **Step 2: Move the rest of the unit**

```bash
mkdir -p Features/MobileControl/{Services,Views}
git mv Services/MobileControlManager.swift Services/MobileWebSocketServer.swift \
       Services/MobileBonjourAdvertiser.swift Services/MobilePin.swift \
       Services/MobilePairedDeviceStore.swift Services/MobileConnectionInfo.swift \
       Services/MobileModule.swift Services/MobileExploreBridge.swift \
       Services/MobileExploreIndexStore.swift Services/MobileSkillCatalog.swift \
       Services/MobileWorkspaceSearch.swift Services/PairingThrottle.swift \
       Features/MobileControl/Services/
git mv Features/Settings/Views/MobileControlSettingsSection.swift Features/MobileControl/Views/
git mv Chat/Session/ExplorerMobileEngineResolver.swift Features/MobileControl/Services/
git mv AutoTask/Services/MobileAutoTaskBridge.swift Features/MobileControl/Services/
git mv LoopEngine/Services/MobileLoopBridge.swift Features/MobileControl/Services/
```

- [ ] **Step 3: Collapse the `Package.swift` exclude list**

Replace the entire `libExcludes.append(contentsOf: [...])` block of 14 file paths **and** the nested `if autoTasksIncluded { libExcludes.append(contentsOf: [...]) }` block with one line. The nested conditional existed only because two bridge files lived inside folders that `auto_tasks` already excluded wholesale; once both live under `Features/MobileControl/`, that overlap is gone.

```swift
if mobileIncluded {
    featureDefines.append(.define("FEATURE_MOBILE"))
} else {
    // One folder, one line. Was a 14-entry file list plus a nested
    // auto_tasks conditional, because the unit was scattered across
    // Services/, Views/Settings/, Chat/Session/, AutoTask/ and LoopEngine/.
    libExcludes.append("Features/MobileControl")
    let mobileTestExcludes: Set<String> = [
        // … unchanged …
    ]
    for name in mobileTestExcludes where !testExcludes.contains(name) {
        testExcludes.append(name)
    }
}
```

- [ ] **Step 4: Expose the settings section**

Add to `Shell/FeatureCatalog.swift`:

```swift
// MARK: - Mobile Control

static func mobileControlSettingsSection() -> AnyView? {
    #if FEATURE_MOBILE
    return AnyView(MobileControlSettingsSection())
    #else
    return nil
    #endif
}
```

and use it from `Features/Settings/Views/SettingsView.swift`.

- [ ] **Step 5: Record it as UNSEALED and run the gate**

```
Features/MobileControl/    Feature:MobileControl
```

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: **`total: 3`**, down from 4 — `LoopEngine/Services/MobileLoopBridge.swift -> AutoTask` is gone because the file is no longer Loop's. The two remaining AutoTask→Loop lines and the one Loop→AutoTask line stay, plus new MobileControl→AutoTask/Loop warnings (unsealed, so warnings only). `sealed violations: 0`.

- [ ] **Step 6: Build mobile-only and min**

This is the configuration the exclude change most affects.

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-mobile-only > /tmp/mob.log 2>&1; echo "exit=$?"
GIT_CONFIG_GLOBAL=/dev/null make build-mac-min         > /tmp/min.log 2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/mob.log /tmp/min.log    # expected: 0 for both
```

Both must be `exit=0`. The min build excludes Mobile entirely — if the single folder exclude is wrong, this is where it shows.

- [ ] **Step 7: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Mobile Control を Features/MobileControl に集約する

Services/、Views/Settings/、Chat/Session/、AutoTask/、LoopEngine/ に
散在していた 15 ファイルを 1 フォルダにまとめる。
Package.swift の除外はファイル単位 14 行 + auto_tasks 入れ子条件から
フォルダ 1 行になる。入れ子条件は除外フォルダの重複を避けるためだけに
存在していたため不要になる。

MobileLoopBridge が LoopEngine/ を離れたことで、クロス機能参照は
4 件から 3 件に減る。

MobileFeatureBridge はシームのプロトコル本体であり、Mobile を
ビルド除外しても他機能の degrade に必要なため Core/Contracts へ置く。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Tasks 16–17: the two protocol seams

These are the only tasks in the plan that change runtime wiring rather than file locations, and **the only ones no automated check can verify** on this toolchain. Each carries a named manual GUI check. Do not mark either complete on a green build alone.

---

### Task 16: `LoopRunning` — AutoTask → Loop

**Reading the call site first:** `AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift:940` does not merely call Loop — it *constructs Loop's collaborators*: `AgentLoopStageRepairer`, `RegressionRunnerSweepAdapter`, `AgentLoopSkillExecutor`, then a `LoopEngineRunner`, then switches on all seven `LoopEngineStatus` cases and reads `runner.iteration`.

A bare `protocol LoopRunning { func run(...) }` would not remove that coupling, because AutoTask would still need Loop's collaborator types to build the argument list. The seam therefore has two parts: a **factory** Loop registers, and a **status vocabulary** that moves to Core.

**Files:**
- Create: `Core/Contracts/LoopRunning.swift`
- Move to Core: `Features/Loop/Models/LoopEngineStatus.swift`, `Features/Loop/Models/GivenUpReason` (whichever file declares it)
- Modify: `Features/AutoTask/Services/AutoCodeUpdateService+PipelineTasks.swift:930-1010`, `Features/Loop/Services/LoopEngineRunner.swift`, `Shell/FeatureCatalog.swift`

**Interfaces:**
- Consumes: `FeatureRegistry` from `Shell/`.
- Produces:
  - `protocol LoopRunning: AnyObject` with `var iteration: Int { get }`, `var onLog: ((LoopLogLine) -> Void)? { get set }`, and `func run(config:faultsRoot:gitRoot:projectId:loopId:loopName:goal:acceptanceCriteria:scopeGlobs:) async -> LoopEngineStatus?`
  - `protocol LoopRunnerProviding: AnyObject` with `func makeRunner(trigger: LoopRunTrigger) -> LoopRunning`
  - `enum LoopEngineStatus` and `enum GivenUpReason` relocated to Core, unchanged.

- [ ] **Step 1: Move the status vocabulary to Core**

These are the words both features speak. They carry no Loop behavior.

```bash
cd mac/Sources/LlmIdeMac
git mv Features/Loop/Models/LoopEngineStatus.swift Core/Contracts/
# LoopRunTrigger and LoopLogLine likewise, if separately declared:
grep -rln "enum LoopRunTrigger\|struct LoopLogLine\|enum GivenUpReason" Features/Loop
# git mv each hit into Core/Contracts/
```

- [ ] **Step 2: Write the contract**

`Core/Contracts/LoopRunning.swift`:

```swift
import Foundation

/// What a Loop run exposes to a scheduler. AutoTask drives Loop through this
/// and never names `LoopEngineRunner` or its collaborators
/// (`AgentLoopStageRepairer`, `AgentLoopSkillExecutor`,
/// `RegressionRunnerSweepAdapter`) — those are Loop's internals and changing
/// them must not break the scheduler.
@MainActor
protocol LoopRunning: AnyObject {
    /// Iterations completed so far. Read after `run` returns for reporting.
    var iteration: Int { get }
    /// Called for every log line as it happens, so the scheduler can mirror
    /// the run into its own per-task log buffer.
    var onLog: ((LoopLogLine) -> Void)? { get set }

    /// Returns nil when the call was REJECTED because a run is already in
    /// progress for this repo. Callers must branch on the return value, not
    /// on any status property — see `LoopEngineRunner.status`'s doc comment.
    func run(config: LoopEngineConfig,
             faultsRoot: URL,
             gitRoot: URL,
             projectId: String,
             loopId: String,
             loopName: String,
             goal: String,
             acceptanceCriteria: [String],
             scopeGlobs: [String]) async -> LoopEngineStatus?
}

/// Loop registers one of these at boot; the scheduler asks it for a runner.
/// This is the half that removes the scheduler's knowledge of Loop's
/// collaborator types.
@MainActor
protocol LoopRunnerProviding: AnyObject {
    func makeRunner(trigger: LoopRunTrigger) -> LoopRunning
}
```

- [ ] **Step 3: Conform Loop and register the provider**

In `Features/Loop/Services/LoopEngineRunner.swift`, declare conformance. The protocol was written *from* this type's existing members, so the one-liner is the expected outcome:

```swift
extension LoopEngineRunner: LoopRunning {}
```

If the compiler rejects it, the mismatch is in the protocol, not the runner — **fix `LoopRunning.swift` to match `LoopEngineRunner`'s real signature.** Do not change the runner to satisfy a signature this plan guessed at; that would be a behavior change, which is out of scope.

Add a provider in `Features/Loop/Services/`:

```swift
@MainActor
final class LoopRunnerProvider: LoopRunnerProviding {
    private let api: LlmIdeAPIClient
    private let regressionSweep: RegressionRunnerSweepAdapter

    init(api: LlmIdeAPIClient, regressionSweep: RegressionRunnerSweepAdapter) {
        self.api = api
        self.regressionSweep = regressionSweep
    }

    func makeRunner(trigger: LoopRunTrigger) -> LoopRunning {
        LoopEngineRunner(stageRepairer: AgentLoopStageRepairer(api: api),
                         regressionSweep: regressionSweep,
                         skillExecutor: AgentLoopSkillExecutor(api: api),
                         trigger: trigger)
    }
}
```

- [ ] **Step 4: Register it through `FeatureCatalog`, and make the nil case loud**

Add to `Shell/FeatureCatalog.swift`:

```swift
// MARK: - Loop

private static var loopRunnerProvider: LoopRunnerProviding?

/// Nil when Loop is compiled out. A caller that gets nil must degrade
/// visibly, not silently: a scheduled Loop task that quietly no-ops is
/// indistinguishable from one that ran and found nothing.
static func loopRunnerProviding() -> LoopRunnerProviding? {
    #if FEATURE_AUTOTASK
    return loopRunnerProvider
    #else
    return nil
    #endif
}
```

- [ ] **Step 5: Rewrite the AutoTask call site**

Replace the construction at `AutoCodeUpdateService+PipelineTasks.swift:940-946` with:

```swift
guard let provider = FeatureCatalog.loopRunnerProviding() else {
    // Loop compiled out. Say so in the task log — a silent skip reads
    // as a successful empty run on the Auto Tasks card.
    logStore.append(.loopEngineering,
                    "Loop is not included in this build — skipping.", level: .error)
    return
}
var runner = provider.makeRunner(trigger: journalTrigger)
```

Everything below it — `runner.onLog`, `await runner.run(...)`, `runner.iteration`, the seven-case `switch` — compiles unchanged against `LoopRunning`, because the protocol was written from that call site.

- [ ] **Step 6: Build, then verify the seam is actually wired**

```bash
cd mac && make regression > /tmp/reg.log 2>&1; echo "exit=$?"; tail -30 /tmp/reg.log
./Scripts/feature-boundaries.sh
```

Expected: `exit=0`, and the gate drops from 3 to **1** — both AutoTask→Loop lines are gone, leaving only `LoopRunService.swift -> AutoTask`.

- [ ] **Step 7: MANUAL GUI CHECK — this cannot be automated**

A compiled-but-unregistered provider returns nil and the task logs "skipping", which looks like correct compiled-out behavior. Only the running app distinguishes them.

1. Launch the full build (`swift run LlmIdeMac`, or the built `.app`).
2. Open **Auto Tasks** and find the Loop Engineering task.
3. Trigger it manually.
4. **Confirm the task log fills with per-stage Loop lines** (`▸ <loop name> — N enabled stage(s)`, then stage progress), and the run reaches a terminal line.
5. **Confirm it does NOT log "Loop is not included in this build".**

If step 5 fails, `loopRunnerProvider` is never assigned at boot — wire it in `FeatureCatalog.bootLoop(…)` alongside the existing `bootGraph` pattern.

- [ ] **Step 8: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): AutoTask→Loop をプロトコルシームに置き換える

呼び出し側は LoopEngineRunner だけでなく、その協力オブジェクト
（AgentLoopStageRepairer / AgentLoopSkillExecutor /
RegressionRunnerSweepAdapter）まで組み立てていた。
そのため run() のみのプロトコルでは結合は解けず、Loop 側が登録する
ファクトリ（LoopRunnerProviding）を併せて導入する。

LoopEngineStatus / GivenUpReason / LoopRunTrigger / LoopLogLine は
両機能が共有する語彙であり、振る舞いを持たないため Core/Contracts へ移す。

Loop 未コンパイル時は nil を返すが、静かに no-op すると
「実行して何も無かった」と区別できないため、タスクログに
明示的なエラー行を出して degrade する。

手動確認: Auto Tasks の Loop Engineering タスクを手動実行し、
ステージごとのログが流れること、および
「Loop is not included in this build」が出ないことを確認済み。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: `TaskLogWriting` — Loop → AutoTask

The mirror image, and far smaller: one weak reference.

**Files:**
- Create: `Core/Contracts/TaskLogWriting.swift`
- Modify: `Features/Loop/Services/LoopRunService.swift:32`, `Features/AutoTask/Services/TaskLogStore.swift`

**Interfaces:**
- Consumes: nothing from Task 16.
- Produces: `protocol TaskLogWriting: AnyObject` with `func append(_ task: String, _ text: String, level: TaskLogLevel)`, and `enum TaskLogLevel { case info, error }` in Core.

- [ ] **Step 1: Check the exact existing signature before writing the protocol**

```bash
cd mac/Sources/LlmIdeMac
grep -n "func append" Features/AutoTask/Services/TaskLogStore.swift
grep -n "logStore" Features/Loop/Services/LoopRunService.swift
```

Write the protocol to match what `TaskLogStore` already declares — do not invent a signature and then change the store to fit it.

- [ ] **Step 2: Write the contract**

`Core/Contracts/TaskLogWriting.swift`:

```swift
import Foundation

/// Severity a log line carries. `TaskLogStore` has no `.warn` case; Loop's
/// runner already maps every non-success terminal status to `.error`.
enum TaskLogLevel {
    case info
    case error
}

/// A per-task log buffer a long-running job can mirror its output into.
/// Loop writes through this so it never names AutoTask's `TaskLogStore`.
@MainActor
protocol TaskLogWriting: AnyObject {
    func append(_ task: String, _ text: String, level: TaskLogLevel)
}
```

- [ ] **Step 3: Conform `TaskLogStore` and retype the Loop reference**

```swift
// Features/AutoTask/Services/TaskLogStore.swift
extension TaskLogStore: TaskLogWriting {}
```

`TaskLogStore.append` takes its own nested `TaskLogStore.Level`, not the `TaskLogLevel` declared above, so this one-liner will **not** compile as-is. Two acceptable resolutions — pick based on what Step 1's grep showed:

- **Preferred:** `TaskLogStore.Level` has exactly the two cases `.info` and `.error`, so delete the new `TaskLogLevel` enum and move `TaskLogStore.Level` itself into `Core/Contracts/` as a top-level `TaskLogLevel`, updating `TaskLogStore` to use it. One vocabulary, no adapter.
- **Fallback**, if `Level` turns out to carry cases or behavior beyond those two: keep both and add an adapter method to the extension that maps `TaskLogLevel` to `TaskLogStore.Level`.

```swift
// Features/Loop/Services/LoopRunService.swift:32
weak var logStore: (any TaskLogWriting)?
```

- [ ] **Step 4: Build and verify the gate reaches zero**

```bash
cd mac && make regression > /tmp/reg.log 2>&1; echo "exit=$?"; tail -30 /tmp/reg.log
./Scripts/feature-boundaries.sh
```

Expected: `exit=0`, and the gate reports **`total: 0`** for the AutoTask/Loop pair — the last of the original four references is gone.

- [ ] **Step 5: MANUAL GUI CHECK**

A weak protocol reference that is never assigned is silently nil, and Loop simply logs nothing — which looks exactly like a quiet run.

1. Launch the full build.
2. Open **Loop**, start a run on the active project.
3. Switch to **Auto Tasks** and open the Loop Engineering task's log.
4. **Confirm the Loop's lines appear there while the run is in progress**, not only a single terminal line at the end.

- [ ] **Step 6: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Loop→AutoTask をプロトコルシームに置き換える

LoopRunService が保持していた TaskLogStore への弱参照を
TaskLogWriting プロトコル越しに変更する。これで当初計測した
クロス機能参照 4 件がすべて解消する。

弱参照が未設定でも静かに nil になりログが出ないだけなので、
実行中に Auto Tasks 側のログへ行が流れることを手動で確認した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Tasks 18–21: the four existing slices move under `Features/`

These already have folders. Each task is a rename plus a `Package.swift` line — small, but they are what makes the layout uniform, and a uniform layout is what lets `Package.swift` stop special-casing.

---

### Task 18: Code Graph

**Files:**
- Move: `Graph/` → `Features/CodeGraph/`, `Services/RepoGraphLocator.swift`
- Modify: `mac/Package.swift:45` and the GraphCore dependency comment near line 194, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/`, `Shell/`.
- Produces: `Features/CodeGraph/` — sealed.

- [ ] **Step 1: Move**

```bash
cd mac/Sources/LlmIdeMac
mkdir -p Features
git mv Graph Features/CodeGraph
git mv Services/RepoGraphLocator.swift Features/CodeGraph/Services/
```

- [ ] **Step 2: Update `Package.swift`**

```swift
libExcludes.append("Features/CodeGraph")
```

Also update the comment near line 194, which states GraphCore/GraphKit are imported "only from within `Sources/LlmIdeMac/Graph/`" — the path is now `Sources/LlmIdeMac/Features/CodeGraph/`. Verify the claim still holds rather than only editing the prose:

```bash
cd mac && grep -rln "import GraphCore\|import GraphKit" Sources/LlmIdeMac
```

Expected: every hit under `Features/CodeGraph/`.

- [ ] **Step 3: Seal and verify**

```
Features/CodeGraph/    Feature:CodeGraph    sealed
```

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 0  sealed violations: 0`, `all exclude paths exist`.

- [ ] **Step 4: Build lite and min, plus the graph labs**

Graph is excluded in both reduced builds, and has its own contract labs.

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite > /tmp/lite.log 2>&1; echo "exit=$?"
GIT_CONFIG_GLOBAL=/dev/null make build-mac-min  > /tmp/min.log  2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log /tmp/min.log   # expected: 0 for both
make graph-gates > /tmp/graph.log 2>&1; echo "exit=$?"
```

All three must be `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Graph を Features/CodeGraph へ移し封印する

Package.swift の GraphCore / GraphKit 依存に関するコメントが
参照元を Sources/LlmIdeMac/Graph/ と明記しているため、
パス更新に加えて主張自体を grep で再確認した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Chat

**Files:**
- Move: `Chat/` → `Features/Chat/`, `Services/CodeAssistantSession.swift`, `Services/CodeWorkflowService.swift`, `Services/VoiceInputService.swift`, `Views/CodeWorkflowSheet.swift`, `Views/CodeWorkflowTarget.swift`, `Views/QuickFixSheet.swift`, `Views/Shared/FirstLaunchChat.swift`, `Views/Shared/CliProgressView.swift`
- Modify: `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/` (including `Core/DesignSystem/SelfSizingMarkdownView.swift` relocated in Task 14, and `ClaudeLink/`, which the map declares Core), `Shell/`.
- Produces: `Features/Chat/` — sealed.

- [ ] **Step 1: Move**

```bash
cd mac/Sources/LlmIdeMac
git mv Chat Features/Chat
git mv Services/CodeAssistantSession.swift Services/CodeWorkflowService.swift \
       Services/VoiceInputService.swift Features/Chat/Services/
git mv Views/CodeWorkflowSheet.swift Views/CodeWorkflowTarget.swift \
       Views/QuickFixSheet.swift Features/Chat/Views/
git mv Views/Shared/FirstLaunchChat.swift Views/Shared/CliProgressView.swift \
       Features/Chat/Views/
```

- [ ] **Step 2: Seal and verify**

```
Features/Chat/    Feature:Chat    sealed
```

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 0  sealed violations: 0`. `ExplorerMobileEngineResolver` already left `Chat/Session/` in Task 15, so the Chat↔Mobile edge is gone.

`Package.swift` needs no change — Chat is not build-excludable.

- [ ] **Step 3: Build all four, plus the chat contract lab**

`chat-contract-lab` is the executable that stands in for XCTest on this toolchain. A type it asserts must be `public` — if this move changed any access level, the lab is where it surfaces.

```bash
cd mac
make regression > /tmp/reg.log 2>&1; echo "exit=$?"; tail -30 /tmp/reg.log
make chat-gates > /tmp/chat.log 2>&1; echo "exit=$?"
```

Both must be `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Chat を Features/Chat へ移し封印する

Code Assistant セッション、コードワークフロー、音声入力と
関連シートを Chat の垂直スライスに取り込む。

ビルド除外対象ではないため Package.swift の変更はない。
chat-contract-lab は別ターゲットであり public 可視性に依存するため、
本移動後に必ず make chat-gates を通す。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Auto Tasks

**Files:**
- Move: `AutoTask/` → `Features/AutoTask/`, `Services/CronExpression.swift`
- Modify: `mac/Package.swift:88`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/Contracts/LoopRunning.swift` from Task 16.
- Produces: `Features/AutoTask/` — sealed.

- [ ] **Step 1: Move**

```bash
cd mac/Sources/LlmIdeMac
git mv AutoTask Features/AutoTask
git mv Services/CronExpression.swift Features/AutoTask/Services/
```

- [ ] **Step 2: Update `Package.swift`**

```swift
libExcludes.append(contentsOf: ["Features/AutoTask", "LoopEngine"])
```

(Loop's path changes in Task 21.)

- [ ] **Step 3: Seal and verify**

```
Features/AutoTask/    Feature:AutoTask    sealed
```

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 0  sealed violations: 0`. This is the payoff from Task 16 — AutoTask can now be sealed only because it reaches Loop through `LoopRunning`.

- [ ] **Step 4: Build lite, min and mobile-only**

```bash
cd mac
GIT_CONFIG_GLOBAL=/dev/null make build-mac-lite        > /tmp/lite.log 2>&1; echo "exit=$?"
GIT_CONFIG_GLOBAL=/dev/null make build-mac-min         > /tmp/min.log  2>&1; echo "exit=$?"
GIT_CONFIG_GLOBAL=/dev/null make build-mac-mobile-only > /tmp/mob.log  2>&1; echo "exit=$?"
grep -c "Invalid Exclude" /tmp/lite.log /tmp/min.log /tmp/mob.log   # expected: 0 for all
```

- [ ] **Step 5: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Auto Tasks を Features/AutoTask へ移し封印する

Task 16 で LoopRunning 越しの呼び出しに変えたことにより、
AutoTask を封印できるようになった。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: Loop

**Files:**
- Move: `LoopEngine/` → `Features/Loop/`, `Services/FaultRepairer.swift`, `Services/FaultVerifier.swift`, `Services/VerifyApprovalStore.swift`, `Services/Memory/` (4)
- Modify: `mac/Package.swift:88`, `mac/Scripts/feature-map.txt`

**Interfaces:**
- Consumes: `Core/Contracts/TaskLogWriting.swift` from Task 17.
- Produces: `Features/Loop/` — sealed.

- [ ] **Step 1: Check `Services/Memory/` ownership before moving it**

`CLAUDE.md` describes `Services/Memory/` as core-owned and states it "works with Graph compiled out". If anything outside Loop reads it, it belongs in Core, not in Loop.

```bash
cd mac/Sources/LlmIdeMac
grep -rln "MemoryStore\|FaultReport\|QAEntry" . | grep -v "^./Services/Memory" | sort
```

If every hit is under `Features/Loop/` or `Shell/`, move it into Loop. Otherwise move it to `Core/Platform/` and note the deviation in the commit message.

- [ ] **Step 2: Move**

```bash
git mv LoopEngine Features/Loop
git mv Services/FaultRepairer.swift Services/FaultVerifier.swift \
       Services/VerifyApprovalStore.swift Features/Loop/Services/
git mv Services/Memory Features/Loop/Services/Memory   # or Core/Platform/Memory per Step 1
```

- [ ] **Step 3: Update `Package.swift`**

```swift
libExcludes.append(contentsOf: ["Features/AutoTask", "Features/Loop"])
```

- [ ] **Step 4: Seal and verify — this should be the last violation removed**

```
Features/Loop/    Feature:Loop    sealed
```

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected: `total: 0  sealed violations: 0`.

- [ ] **Step 5: Confirm `Services/` and `Views/` are now empty or near-empty**

```bash
cd mac/Sources/LlmIdeMac
find Services Views Models -name '*.swift' 2>/dev/null | sort
```

Anything still listed is unclassified and therefore Shell-exempt — a hole in the enforcement. List whatever remains in the commit message; Task 22 places it.

- [ ] **Step 6: Build all four**

```bash
cd mac && make regression > /tmp/reg.log 2>&1; echo "exit=$?"; tail -30 /tmp/reg.log
grep -c "Invalid Exclude" /tmp/reg.log   # expected: 0
```

- [ ] **Step 7: Commit**

```bash
git add -A mac
git commit -m "$(cat <<'EOF'
refactor(mac): Loop を Features/Loop へ移し封印する

Fault 修復・検証と承認ストアを Loop に取り込む。
Services/Memory は CLAUDE.md が core-owned と記述しているため、
Loop 以外からの参照有無を grep で確認したうえで配置を決めた。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Seal the remainder, close the holes, update the docs

The migration is only real when nothing is left in the exempt bucket. Anything still unclassified can reference any feature freely, so this task is not paperwork — it is where the rule starts actually holding.

**Files:**
- Modify: `mac/Scripts/feature-map.txt`, `CLAUDE.md`, `docs/explanation/invariants.md`
- Move: whatever Task 21 Step 5 listed

**Interfaces:**
- Consumes: every feature folder from Tasks 3–21.
- Produces: a fully sealed tree — every feature in the map carries `sealed`, and the gate reports `total: 0`.

- [ ] **Step 1: Place every remaining unclassified file**

Using the list from Task 21 Step 5, move each file into the feature that owns it, or into `Core/` if more than one feature uses it. Then delete the empty directories:

```bash
cd mac/Sources/LlmIdeMac
rmdir Services Views Models 2>/dev/null; ls
```

Expected remaining top-level entries: `ClaudeLink`, `Core`, `Features`, `Resources`, `Shell`.

- [ ] **Step 2: Seal Doc Gen, Settings and Mobile Control**

These three were deliberately left unsealed. Add `sealed` to each line in `mac/Scripts/feature-map.txt`, then run the gate and resolve whatever it reports:

```bash
cd mac && ./Scripts/feature-boundaries.sh
```

Expected once resolved: `total: 0  sealed violations: 0`.

Two known cases to expect, with their fixes:
- **Settings → any feature panel.** Route it through a `FeatureCatalog.<feature>SettingsSection()` factory, as Tasks 9, 11 and 15 did.
- **MobileControl → AutoTask / Loop.** Both bridges now have contracts available (`LoopRunning` from Task 16, and `MobileFeatureBridge` already in `Core/Contracts/`). Retype the bridge properties to the protocols.

- [ ] **Step 3: Add a "no unclassified files" check to the gate**

Without this, the tree can silently drift back: a new file in a new top-level folder is exempt by default, which is right during migration and wrong afterwards.

Append to `mac/Scripts/feature-boundaries.sh`, before `exit $status`:

```bash
# Migration is complete, so an unclassified file is now a defect rather than
# work-in-progress: unclassified means Shell-exempt, i.e. free to reference
# any feature.
echo "=== unclassified files ==="
unclassified=0
while read -r f; do
  rel="${f#"$SRC"/}"
  case "$rel" in
    Core/*|Shell/*|Features/*|ClaudeLink/*|Resources/*) ;;
    *) echo "  UNCLASSIFIED: $rel"; unclassified=1 ;;
  esac
done < <(find "$SRC" -name '*.swift')
if [ "$unclassified" -eq 1 ]; then
  echo "FAIL: files outside Core/, Shell/, Features/ are exempt from the boundary rule" >&2
  status=1
else
  echo "  none"
fi
```

- [ ] **Step 4: Run the complete gate and the full regression**

```bash
cd mac
./Scripts/feature-boundaries.sh; echo "gate exit=$?"
make regression > /tmp/reg.log 2>&1; echo "regression exit=$?"; tail -40 /tmp/reg.log
grep -c "Invalid Exclude" /tmp/reg.log   # expected: 0
make graph-gates > /tmp/graph.log 2>&1; echo "graph exit=$?"
make chat-gates  > /tmp/chat.log  2>&1; echo "chat exit=$?"
```

All four must report `exit=0`, and the gate must print `total: 0`, `sealed violations: 0`, `all exclude paths exist`, and `none` unclassified.

- [ ] **Step 5: Update `CLAUDE.md`**

The Project Structure tree in `CLAUDE.md` describes the old layout in detail and will otherwise send every future agent to paths that no longer exist. Replace the `mac/Sources/LlmIdeMac/` subtree with the three-layer shape, and add a rule next to the extension's module-boundary section:

```markdown
### Module Boundaries (macOS app)

`Shell → Features → Core`. A feature may import Core. A feature may **never**
reference another feature, and never Shell. Enforced by
`mac/Scripts/feature-boundaries.sh` (run by `make regression`) at **zero**
violations — never un-seal a feature to land a change; move the shared piece
to `Core/` or add a protocol to `Core/Contracts/` instead.

Cross-feature protocols live in `Core/Contracts/`: `LoopRunning`,
`TaskLogWriting`, `MobileFeatureBridge`.
```

- [ ] **Step 6: Add the invariant**

Append to `docs/explanation/invariants.md`, matching the file's existing "each invariant maps to a previous regression" style:

```markdown
### Mac feature boundaries (`mac/Scripts/feature-boundaries.sh`)
- **Zero cross-feature references** — a sealed feature referencing another
  fails the build. Previously Mobile Control was scattered across five
  folders, needing a 16-entry file-level exclude list in `Package.swift`.
- **Never un-seal a feature** — move the shared type to `Core/`, or add a
  protocol to `Core/Contracts/`.
- **Every `Package.swift` exclude path must exist** — SwiftPM only *warns* on
  an invalid exclude and exits 0, so a moved file silently rejoins the lite
  build. The gate checks this.
- **Strip comments before matching** — doc-comment prose is not a dependency.
  The un-stripped prototype reported 13 violations where 4 existed.
```

- [ ] **Step 7: Commit and open the merge**

```bash
git add -A mac CLAUDE.md docs/explanation/invariants.md
git commit -m "$(cat <<'EOF'
refactor(mac): 全機能を封印し境界ルールを文書化する

未分類ファイルを解消し、Doc Gen / Settings / Mobile Control を封印する。
未分類は Shell 扱いで免除されるため、移行完了後は欠陥とみなし
ゲートで検出するようにした。

CLAUDE.md の構成ツリーと docs/explanation/invariants.md を更新する。
不変条件として「封印を解いて変更を通さない。共有物は Core へ、
必要なら Core/Contracts にプロトコルを足す」を明記した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"

# Foreground push with a long timeout; a backgrounded push dies at SSH connect.
git push -u origin refactor/mac-feature-slices
```

---

## Appendix: verification quick reference

| Command | What it proves |
|---|---|
| `./Scripts/feature-boundaries.sh` | No sealed feature references another; all `Package.swift` exclude paths exist |
| `make regression` (never piped) | All four builds — full, lite, min, mobile-only |
| `grep -c "Invalid Exclude" <log>` | No exclude silently stopped matching; SwiftPM only warns |
| `make graph-gates` | Graph layout/engine labs still pass |
| `make chat-gates` | `chat-contract-lab` still passes; public visibility intact |
| Manual GUI (Tasks 16, 17 only) | Protocol seams are actually registered, not silently nil |

**Exit condition:** every feature in `mac/Scripts/feature-map.txt` carries `sealed`, the gate prints `total: 0` and `none` unclassified, and all four builds are green.
