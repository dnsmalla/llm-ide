# Library as the Single Input Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Library the only place content enters a project — consumer panels select from existing Library items instead of opening their own file pickers.

**Architecture:** Add one reusable `LibraryPicker` sheet driven by the existing `LibraryItemStore`. `CodeAssistantPanel` (which uses `NSOpenPanel`) adopts the picker. `DocGenSourcePanel` already lists Library items inline for selection, so it only needs its own *add* pickers removed. `ReviewView`, `UAGraphView`, and `RegressionView` already read exclusively from the Library — no change.

**Tech Stack:** Swift / SwiftUI (`mac/`), XCTest. Build: `GIT_CONFIG_GLOBAL=/dev/null swift build` (outside the command sandbox). **Note:** this dev box has Command Line Tools only — `swift test` silently no-ops and the test target can't compile (`no such module 'XCTest'`); run the `swift test` steps on CI / full Xcode. Locally, `swift build` of the main target is the compile gate.

**Spec:** `docs/superpowers/specs/2026-06-23-library-single-input-hub-design.md`

> **Refinement vs spec:** the spec proposed a `LibraryPicker` sheet for *both* consumers. While mapping the code, `DocGenSourcePanel` was found to already render Library `notes`/`data` items inline as selectable rows — a sheet there would be redundant. So DocGen is converted by *removing its add pickers* (leaving select-only), and the sheet is used only by `CodeAssistantPanel`. The spec's goal (Library is the sole add point; consumers select from it) is fully preserved.

---

### Task 1: `LibraryPicker` sheet + pure `filter`

A reusable sheet that lists Library items filtered to a consumer's allowed categories and returns the chosen items. The pure `filter` core is unit-tested; the view is build-verified.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Library/LibraryPicker.swift`
- Test: `mac/Tests/LlmIdeMacTests/LibraryPickerTests.swift`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/LibraryPickerTests.swift`:

```swift
import XCTest
@testable import LlmIdeMac

/// LibraryPicker.filter is the pure selection core: it keeps only items whose
/// category is in the consumer's allowed set, so each panel sees only relevant
/// Library content.
final class LibraryPickerTests: XCTestCase {

    private func item(_ name: String, _ cat: LibraryItem.Category) -> LibraryItem {
        LibraryItem(name: name, path: "/p/\(name)", category: cat)
    }

    func testFilterKeepsOnlyAllowedCategories() {
        let items = [
            item("a.swift", .code),
            item("note.md", .notes),
            item("data.csv", .data),
            item("call.md", .meetings),
        ]
        let result = LibraryPicker.filter(items, allowed: [.code, .notes])
        XCTAssertEqual(result.map(\.name), ["a.swift", "note.md"])
    }

    func testFilterEmptyWhenNoMatches() {
        let items = [item("a.swift", .code)]
        XCTAssertTrue(LibraryPicker.filter(items, allowed: [.data]).isEmpty)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

On CI / full Xcode: `cd mac && swift test --filter LibraryPickerTests 2>&1 | tail -15`
Expected: FAIL — `type 'LibraryPicker' has no member 'filter'` (LibraryPicker doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `mac/Sources/LlmIdeMac/Views/Library/LibraryPicker.swift`:

```swift
import SwiftUI

/// A sheet that lets a consumer panel select existing Library items, filtered
/// to the categories relevant to it. The Library (`LibraryItemStore`) is the
/// single place content enters a project; consumers reference what's already
/// there instead of opening their own file pickers. There is intentionally no
/// "browse to add" — if an item isn't in the Library, the user adds it from the
/// Library first.
struct LibraryPicker: View {
    enum Mode { case single, multi }

    let allowed: [LibraryItem.Category]
    let mode: Mode
    let title: String
    let onConfirm: ([LibraryItem]) -> Void

    @Environment(LibraryItemStore.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var selectedIds: Set<String> = []

    /// Pure, testable core: keep only items whose category is allowed,
    /// preserving the store's order.
    static func filter(_ items: [LibraryItem], allowed: Set<LibraryItem.Category>) -> [LibraryItem] {
        items.filter { allowed.contains($0.category) }
    }

    private var visible: [LibraryItem] {
        Self.filter(library.items, allowed: Set(allowed))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.headline)
                Spacer()
            }
            .padding()
            Divider()

            if visible.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(allowed) { category in
                        let rows = visible.filter { $0.category == category }
                        if !rows.isEmpty {
                            Section(category.sectionTitle) {
                                ForEach(rows) { row($0) }
                            }
                        }
                    }
                }
            }

            Divider()
            footer
        }
        .frame(minWidth: 420, minHeight: 380)
    }

    private func row(_ item: LibraryItem) -> some View {
        let isSel = selectedIds.contains(item.id)
        return Button {
            toggle(item)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: isSel ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSel ? Color.accentColor : Color.secondary)
                Image(systemName: item.category.icon)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name).lineLimit(1)
                    if let folder = item.folderOrigin {
                        Text(folder).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func toggle(_ item: LibraryItem) {
        switch mode {
        case .single:
            selectedIds = [item.id]
        case .multi:
            if selectedIds.contains(item.id) { selectedIds.remove(item.id) }
            else { selectedIds.insert(item.id) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
            Text("Nothing in the Library to pick").font(.headline)
            Text("Add \(allowed.map(\.sectionTitle).joined(separator: " / ")) from the Library first.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel") { dismiss() }
            Button("Add") {
                onConfirm(visible.filter { selectedIds.contains($0.id) })
                dismiss()
            }
            .disabled(selectedIds.isEmpty)
            .keyboardShortcut(.defaultAction)
        }
        .padding()
    }
}
```

- [ ] **Step 4: Run the test (CI / full Xcode) and build locally**

On CI / full Xcode: `cd mac && swift test --filter LibraryPickerTests 2>&1 | tail -8` → Expected: `Executed 2 tests, with 0 failures`.
Locally: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -4` → Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Library/LibraryPicker.swift mac/Tests/LlmIdeMacTests/LibraryPickerTests.swift
git commit -m "feat(mac): LibraryPicker — select existing Library items, category-filtered" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `CodeAssistantPanel` picks from the Library

Replace the two `NSOpenPanel` actions (attach files / attach folder) with the `LibraryPicker`. Selected items are attached via the existing `addFile(url:)` (which reads, probes for binary, and de-dupes).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`

- [ ] **Step 1: Add picker presentation state**

Find (near the other `@State` declarations, around `:49`):

```swift
    @State private var attachments: [LlmIdeAPIClient.CodeAttachment] = []
```

Add immediately after it:

```swift
    @State private var showLibraryPicker = false
```

- [ ] **Step 2: Point both toolbar actions at the picker**

There are two identical toolbar rows (compact + expanded). Replace BOTH occurrences of this pair (at `:999-1000` and `:1024-1025`):

```swift
                contextButton(icon: "plus",   label: "Add files",  action: pickFiles)
                contextButton(icon: "folder", label: "Add folder", action: pickFolder)
```

with (a single action that opens the Library picker):

```swift
                contextButton(icon: "plus", label: "Add from Library", action: { showLibraryPicker = true })
```

- [ ] **Step 3: Attach the picker sheet**

Find the `pickFiles()` function (`:1291`). Immediately ABOVE the `// MARK: - File pickers` line (`:1289`), add a sheet modifier on the body. To keep it local, attach it to the root view of `body`. Locate the end of the `body` view's outermost container and add:

```swift
        .sheet(isPresented: $showLibraryPicker) {
            LibraryPicker(
                allowed: [.code, .notes, .data],
                mode: .multi,
                title: "Add from Library"
            ) { items in
                attachNotice = nil
                var rejected: [String] = []
                for item in items where addFile(url: item.url) == .notText {
                    rejected.append(item.name)
                }
                if !rejected.isEmpty {
                    attachNotice = rejected.count == 1
                        ? "“\(rejected[0])” can’t be attached — images and binary files aren’t supported in chat yet."
                        : "\(rejected.count) files couldn’t be attached — images and binary files aren’t supported in chat yet."
                }
            }
        }
```

(If the body's container end is ambiguous, attach the `.sheet` to the same view the existing `attachNotice`-related modifiers hang off — any view inside `body` works as long as it's in the live hierarchy.)

- [ ] **Step 4: Delete the now-unused NSOpenPanel code**

Delete the entire `pickFiles()` function (`:1291-1310`), the entire `pickFolder()` function (`:1312-1322`), and the entire `walkFolder(_:)` function (`:1348-1370`). Keep `addFile(url:)`, `AttachOutcome`, `displayPath(_:)`, `skipDirs`, and `walkableExtensions` only if still referenced; if `skipDirs`/`walkableExtensions` are now unused (they were only used by `walkFolder`), delete them too.

- [ ] **Step 5: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6`
Expected: `Build complete!` (and no "unused" warnings for deleted helpers). If the compiler reports `skipDirs`/`walkableExtensions`/`AttachOutcome.unreadable` unused, remove the dead members.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift
git commit -m "feat(mac): Code Assistant attaches from the Library, not its own picker" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `DocGenSourcePanel` becomes select-only

DocGen already lists Library `notes`/`data` items as selectable source rows. Remove its own add affordances (the per-section `+` buttons, the footer "Add file or folder" menu, and the source `fileImporter`) so content is added only from the Library. Keep the template importer (templates are app assets, not project content). Add a Sources (meetings) selection section to match the spec's allowed set.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift`

- [ ] **Step 1: Remove the source-import state**

Delete these two lines (`:10-11`):

```swift
    @State private var showFileImporter = false
    @State private var importCategory: LibraryItem.Category = .notes
```

- [ ] **Step 2: Remove the source `fileImporter`**

Delete the FIRST `.fileImporter` block (`:38-46`):

```swift
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                for url in urls { itemStore.add(url: url, category: importCategory) }
            }
        }
```

Leave the SECOND `.fileImporter` (template importer, `:47-57`) untouched.

- [ ] **Step 3: Remove the per-section add buttons**

In `notesSection` delete the `addButton(for: .notes)` line (`:229`) and the `Spacer()` immediately before it if it now leaves a dangling header; the header should read:

```swift
            HStack {
                sectionHeader(title: "Notes", icon: "note.text", color: .blue)
                Spacer()
            }
```

Do the same in `dataSection` — remove `addButton(for: .data)` (`:250`), leaving:

```swift
            HStack {
                sectionHeader(title: "Data", icon: "tablecells", color: .purple)
                Spacer()
            }
```

Then delete the now-unused `addButton(for:)` function (`:308-322`).

- [ ] **Step 4: Add a Sources (meetings) selection section**

After `dataSection` is rendered in `body` (`:24`, after the `dataSection` line inside the `VStack`), insert:

```swift
                    Divider().padding(.vertical, 6)
                    sourcesSection
```

Then add this section next to `notesSection`/`dataSection`:

```swift
    // MARK: - Sources (meetings) section

    private var sourcesSection: some View {
        let items = itemStore.items(for: .meetings)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionHeader(title: "Sources", icon: "waveform.and.mic", color: .indigo)
                Spacer()
            }
            if items.isEmpty {
                emptyHint("No sources captured yet")
            } else {
                ForEach(items) { item in
                    fileRow(item: item, iconColor: .indigo)
                }
            }
        }
    }
```

- [ ] **Step 5: Replace the footer add-menu with a Library hint**

Replace the entire `footer` computed property (`:265-292`) with a static hint pointing to the Library:

```swift
    private var footer: some View {
        HStack(spacing: 7) {
            Image(systemName: "books.vertical")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("Add notes, data, or sources from the Library")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
```

- [ ] **Step 6: Build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -6`
Expected: `Build complete!` If the compiler flags `itemStore.add` as the only remaining caller removed, that's fine — `add` stays (the Library uses it). Remove any newly-unused private helper the compiler names.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift
git commit -m "feat(mac): DocGen selects sources from the Library (no own add picker)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Confirm conforming panels + final verification

`ReviewView`, `UAGraphView`, and `RegressionView` already source content exclusively from the Library; this task verifies nothing regressed and records the conformance.

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-library-single-input-hub-design.md` (status note only)

- [ ] **Step 1: Verify no stray content pickers remain**

Run:
```bash
cd /Users/dinesh.malla/llm-ide
grep -n "NSOpenPanel\|fileImporter" mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift
```
Expected: only the DocGen *template* `fileImporter` remains; no `NSOpenPanel` in CodeAssistantPanel. (ReviewView/UAGraphView/RegressionView have no content picker — confirmed during design.)

- [ ] **Step 2: Full build**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build 2>&1 | tail -4`
Expected: `Build complete!`

- [ ] **Step 3: Run the Mac test suite (CI / full Xcode)**

On CI / full Xcode: `cd mac && swift test 2>&1 | tail -8` → Expected: all tests pass, including `LibraryPickerTests`.

- [ ] **Step 4: Mark the spec done and commit**

Add to the top of the spec file under **Status**: `Implemented 2026-06-23`. Then:
```bash
git add docs/superpowers/specs/2026-06-23-library-single-input-hub-design.md
git commit -m "docs(spec): mark Library single-input-hub implemented" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Runtime verification (user)**

The GUI can't be driven headlessly. In the running app, confirm:
- Code Assistant "Add from Library" opens the picker showing code/notes/data items; selecting attaches them; binary/image items are rejected with the notice.
- DocGen shows Notes / Data / Sources from the Library, selectable; it no longer has its own add buttons or footer add-menu; the template importer still works.
- Adding a new file via the Library menu makes it appear in both pickers.

---

## Self-Review

- **Spec coverage:** shared selector → Task 1; CodeAssistant conversion → Task 2; DocGen select-only (spec's "DocGen selects from Library") → Task 3; the three conforming panels + "no browse fallback" (empty state in Task 1) → Tasks 1 & 4; category filters (CodeAssistant `[.code,.notes,.data]`, DocGen notes/data/meetings) → Tasks 2 & 3. The spec's "LibraryPicker for DocGen" is intentionally refined to "remove DocGen's add pickers" (documented above) since DocGen already inlines Library selection. ✔
- **Placeholders:** none — every code step shows the actual code; run steps show command + expected output (with the CI caveat for `swift test`). ✔
- **Type consistency:** `LibraryPicker(allowed:mode:title:onConfirm:)` and `LibraryPicker.filter(_:allowed:)` defined in Task 1, called with identical labels in Tasks 2–3; `LibraryItem.Category` cases (`code/data/notes/meetings`), `item.url`, `item.category.icon`, `category.sectionTitle`, `itemStore.items(for:)`, and `addFile(url:) -> AttachOutcome` all match the current codebase. ✔
