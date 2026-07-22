# Doc Gen: Show All File Types — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Doc Gen source panel list every file type (not just `.md/.txt/.json/.csv`) in its Data, Notes, and Sources sections.

**Architecture:** Remove the single `textSources(from:)` text-only filter from `DocGenSourcePanel.swift` so sections render the full `itemStore.items(for:)` list. Non-text files that get selected as sources are already handled safely: `DocGenViewModel.generate` reads each file with strict UTF-8 (`try? String(contentsOf:encoding: .utf8)`), so binaries throw, land in `unreadableSourceNames`, and show the existing ⚠️ marker without corrupting the generated doc. No VM change required.

**Tech Stack:** Swift / SwiftUI (macOS app). No new dependencies.

## Global Constraints

- **No XCTest target exists.** `swift test` reports "no tests found; create a target in the 'Tests' directory" — adding one is a deferred refactor (see `docs/explanation` / the mac package-split work), **out of scope here.** Verification for every task is `swift build` + a manual drive, **not** XCTest. Do not write test files.
- **Pre-push hook caveat:** the repo's pre-push hook runs `swift test` for `mac/` changes, which fails with "no tests found" on `origin/main` today. A `mac/`-only commit must be pushed with `git push --no-verify`. This is pre-existing and documented, not caused by this work.
- **Run the GUI app via the release/app build, not the raw `.build` binary** (the raw binary won't restore the project / run the auto-updater). Use `mac/build_app.sh` then open the produced `.app`, or the project's run path. GUI interaction needs Accessibility permission.
- **One concern per commit; Conventional Commits** (`feat(mac):`, `refactor(mac):`, etc.), per repo CLAUDE.md.

**Spec:** [`docs/superpowers/specs/2026-07-22-docgen-show-all-files-design.md`](../specs/2026-07-22-docgen-show-all-files-design.md)

---

## File Structure

Only one file is modified:

- **Modify:** `mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift`
  - `notesSection` (line ~171), `dataSection` (line ~191), `sourcesSection` (line ~211): stop filtering through `textSources(from:)`.
  - Three `emptyHint(...)` calls (lines ~179, ~199, ~218): drop the ".md/.txt/…" wording.
  - `textSources(from:)` private helper (lines ~336–340): delete (becomes unused).

No files created. No other files touched. (`FileDetailView.swift` already edits/opens every type; `DocGenViewModel.swift` already rejects binaries — both confirmed in the spec, unchanged here.)

---

## Task 1: Remove the text-only filter from the Doc Gen source panel

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift` (sections at ~171/~191/~211, hints at ~179/~199/~218, helper at ~336–340)

**Interfaces:**
- Consumes: `itemStore.items(for: LibraryItem.Category) -> [LibraryItem]` (existing; `LibraryItemStore` injected via `@Environment`). The `.notes`, `.data`, `.meetings` categories already return all files of that kind — no filter upstream.
- Produces: nothing new. Downstream behavior (`DocGenViewModel.generate`) is unchanged and already tolerates non-text selection.

- [ ] **Step 1: Replace the filter in `notesSection`**

In `mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift`, change:

```swift
    private var notesSection: some View {
        let items = textSources(from: itemStore.items(for: .notes))
```

to:

```swift
    private var notesSection: some View {
        let items = itemStore.items(for: .notes)
```

- [ ] **Step 2: Replace the filter in `dataSection`**

Change:

```swift
    private var dataSection: some View {
        let items = textSources(from: itemStore.items(for: .data))
```

to:

```swift
    private var dataSection: some View {
        let items = itemStore.items(for: .data)
```

- [ ] **Step 3: Replace the filter in `sourcesSection`**

Change:

```swift
    private var sourcesSection: some View {
        let items = textSources(from: itemStore.items(for: .meetings))
```

to:

```swift
    private var sourcesSection: some View {
        let items = itemStore.items(for: .meetings)
```

- [ ] **Step 4: Update the three empty-state hints**

Change each `emptyHint(...)` so it no longer implies a text-only list:

```swift
                emptyHint("No .md/.txt notes in Library yet")
```
→
```swift
                emptyHint("No notes in Library yet")
```

```swift
                emptyHint("No .md/.txt/.csv data files in Library yet")
```
→
```swift
                emptyHint("No data files in Library yet")
```

```swift
                emptyHint("No .md meeting transcripts in Library yet")
```
→
```swift
                emptyHint("No meeting transcripts in Library yet")
```

- [ ] **Step 5: Delete the now-unused `textSources(from:)` helper**

Delete this entire block (the doc comment + function), found just above the closing brace of `struct DocGenSourcePanel`:

```swift
    /// Doc Gen reads UTF-8 text only — offer `.md`, `.txt`, `.json`, `.csv`.
    private func textSources(from items: [LibraryItem]) -> [LibraryItem] {
        let allowed: Set<String> = ["md", "markdown", "txt", "json", "csv"]
        return items.filter { allowed.contains($0.ext.lowercased()) }
    }
```

(Leaving it would be dead code; the build would still succeed, but removing it keeps the file honest and prevents the filter from being silently reintroduced.)

- [ ] **Step 6: Verify it compiles**

Run from the repo root:

```bash
cd mac && swift build 2>&1 | tail -5
```

Expected: `Build complete!` with no errors. If `textSources` is referenced anywhere else (it isn't — it's `private` and used only at the three call sites above), the compiler will flag it; fix the remaining call site.

- [ ] **Step 7: Manual drive — confirm all files show and binaries are flagged**

Build and open the app (use the app build, not the raw `.build` binary):

```bash
cd mac && ./build_app.sh && open "$(./build_app.sh --print-path 2>/dev/null || echo build/Release)/LlmIdeMac.app" 2>/dev/null || true
```

(If the one-liner above doesn't match this repo's exact build script, fall back to whatever `mac/build_app.sh` produces — open that `.app`. Grant Accessibility if prompted.)

In the running app:
1. Open (or create) a project.
2. In the **Library → Data** section, use **Add file** to drop in **two** files: a text file (e.g. `notes.md`) and a binary (e.g. a `.png` screenshot, or any `.xlsx`).
3. Open the **Doc Gen** panel. Confirm **both** files appear in the **Data** section (previously the `.png`/`.xlsx` was hidden).
4. Select **both** sources and pick a template, then **Generate**.
5. Confirm: the binary row shows the ⚠️ "Could not read this file" marker, the `.md` is used, and the document **generates successfully** (no error, no garbage from the binary injected into the doc).
6. Empty-state check: in a fresh project with an empty `data/` folder, confirm the Data section hint reads "No data files in Library yet" (no ".md/.txt/.csv").

If step 5 shows the binary's bytes leaking into the generated doc, **stop** — that means the file decoded as valid UTF-8 (the acknowledged edge case in the spec). Report it; do not ship. The fix would be a NUL-byte heuristic in `DocGenViewModel.generate`, which is explicitly out of scope unless it actually occurs.

- [ ] **Step 8: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift
git commit -m "feat(mac): show all file types in Doc Gen source panel" -m "Drop the textSources filter so Data/Notes/Sources list every file, not just .md/.txt/.json/.csv. Non-text sources are already safe: DocGenViewModel reads them with strict UTF-8, so binaries throw and land in unreadableSourceNames (⚠️ marker) without corrupting the generated doc. Editing was already supported via FileDetailView's Open-in-App for all types.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 9: Push (mac/ change — use --no-verify)**

```bash
git push --no-verify origin main
```

(Reason: the pre-push hook runs `swift test` for `mac/` changes, which fails "no tests found" because the mac package has no test target yet — pre-existing on origin/main. If a test target has since been added, drop `--no-verify` and push normally.)

---

## Self-Review

**1. Spec coverage**
- "Change 1 — Show every file (remove filter, Data/Notes/Sources, update hints, delete helper)" → Task 1, Steps 1–5. ✓
- "Change 2 — Flag non-text sources instead of feeding garbage" → Spec concluded **no new code** (existing strict-UTF-8 read already does this); covered by Step 7's verification that binaries get the ⚠️ and don't corrupt output. ✓
- "No change to editing" → No task needed (confirmed). ✓
- "Verification — swift build + manual drive" → Task 1, Steps 6–7. ✓

**2. Placeholder scan** — none. All edits show exact before/after code; build/run commands are concrete.

**3. Type consistency** — `itemStore.items(for:)` returns `[LibraryItem]`, the same type `textSources(from:)` returned, so `let items = …` and the downstream `ForEach(items)` / `items.isEmpty` checks are unchanged. No signature changes anywhere.

**4. Scope** — single file, single concern, single commit. Appropriately one task.
