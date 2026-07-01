# Doc Gen Feature Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Doc Gen" sidebar item to the macOS app that lets users select notes and data files from the Library, pick a document template (skeleton of headings), generate a structured document via the CLI agent, and export the editable result as a DOCX file.

**Architecture:** New `DocGenView` mirrors `ReviewView`'s 3-panel `HSplitView` layout. The left panel is a checkbox-based source picker (Library files + KB meetings). The center panel shows the template skeleton before generation and an editable doc after. The right panel reuses `CodeAssistantPanel` unchanged. A lightweight `DocTemplateStore` persists custom templates to JSON in Application Support. Generation calls the existing `/generate-docx` endpoint with a formatted prompt that includes the template sections and the concatenated source content.

---

## Components and Files

| Action | Path |
|--------|------|
| Create | `Models/DocTemplate.swift` |
| Create | `Services/DocTemplateStore.swift` |
| Create | `ViewModels/DocGenViewModel.swift` |
| Create | `Views/DocGen/DocGenView.swift` |
| Create | `Views/DocGen/DocGenSourcePanel.swift` |
| Create | `Views/DocGen/DocGenEditorPanel.swift` |
| Create | `Views/DocGen/DocTemplateManagerSheet.swift` |
| Modify | `Services/ShellState.swift` |
| Modify | `Views/Shell/SidebarView.swift` |
| Views/AppShell.swift | add `.docGen` branch in `detailColumn` |
| Modify | `Services/API/LlmIdeAPIClient+Export.swift` |

---

## Data Model

### `DocTemplate`

```swift
struct DocTemplate: Identifiable, Codable, Equatable {
    let id: UUID
    var name: String
    var sections: [String]   // ordered heading names, e.g. ["Sprint Goal", "Completed Items"]
    let isBuiltin: Bool

    static let builtins: [DocTemplate] = [
        DocTemplate(id: UUID(), name: "Meeting Summary",
                    sections: ["Key Decisions", "Action Items", "Blockers", "Next Steps"], isBuiltin: true),
        DocTemplate(id: UUID(), name: "Sprint Review",
                    sections: ["Sprint Goal", "Completed Items", "Carry-overs", "Blockers & Risks", "Next Sprint Goals"], isBuiltin: true),
        DocTemplate(id: UUID(), name: "Decision Log",
                    sections: ["Context", "Decision", "Rationale", "Alternatives Considered", "Follow-ups"], isBuiltin: true),
        DocTemplate(id: UUID(), name: "Status Update",
                    sections: ["Summary", "Completed This Period", "In Progress", "Risks", "Next Period"], isBuiltin: true),
        DocTemplate(id: UUID(), name: "Action Plan",
                    sections: ["Objective", "Actions", "Owners", "Timeline", "Success Criteria"], isBuiltin: true),
    ]
}
```

### Source item for generation

```swift
struct DocGenSource {
    enum Kind { case meeting(id: String, title: String); case file(url: URL, name: String) }
    let kind: Kind
    var displayName: String { ... }
}
```

---

## `DocTemplateStore`

`@MainActor` `ObservableObject` service injected via `.environmentObject`.

- `var templates: [DocTemplate]` — computed: `DocTemplate.builtins + customTemplates`
- `var customTemplates: [DocTemplate]` — loaded from / persisted to `~/Library/Application Support/com.llmide.macapp/doc-templates.json`
- `func add(_ template: DocTemplate)` — appends to `customTemplates`, saves
- `func update(_ template: DocTemplate)` — replaces by id, saves
- `func delete(id: UUID)` — removes from `customTemplates`, saves (no-op for builtins)
- `func duplicate(_ template: DocTemplate) -> DocTemplate` — creates a copy with a new UUID, `isBuiltin: false`, name appended with " (copy)", adds it

Persistence: `JSONEncoder/JSONDecoder` to a file in Application Support. Encoding failure is non-fatal (logged, not shown to user).

---

## `DocGenViewModel`

`@MainActor` `ObservableObject`.

```swift
@Published var selectedSources: Set<DocGenSource.Kind> = []
@Published var selectedTemplate: DocTemplate?
@Published var generationState: GenerationState = .idle

enum GenerationState {
    case idle           // nothing generated yet
    case generating     // agent running
    case done(String)   // generated markdown content (editable)
    case error(String)
}

var canGenerate: Bool { !selectedSources.isEmpty && selectedTemplate != nil }
```

- `func generate(api: LlmIdeAPIClient)` — async, sets state to `.generating`, fetches content for each selected source (meetings via `api.getMeeting(id:)`, files via `String(contentsOf:)`), formats the combined prompt (see below), calls `api.generateDocFromTemplate(content:template:)`, sets state to `.done(text)` or `.error(...)` on finish
- `func export(content: String, api: LlmIdeAPIClient)` — calls `api.exportMarkdown(content:filename:)`, opens the saved `.md` file in Finder on success via `NSWorkspace.shared.activateFileViewerSelecting`

---

## New server route: `POST /generate-doc`

The existing `/generate-docx` endpoint returns a DOCX binary and uses a rigid fixed-section prompt (title, decisions, todos, etc.) — it cannot produce template-structured output. A new route is needed.

**Request body:**
```json
{
  "templateName": "Sprint Review",
  "sections": ["Sprint Goal", "Completed Items", "Carry-overs", "Blockers & Risks", "Next Sprint Goals"],
  "sources": [
    { "name": "Sprint Review — May 14", "content": "..." },
    { "name": "Q2 Targets.md", "content": "..." }
  ]
}
```

**Server behaviour (`extension/server/export-routes.mjs`):**
- Builds a Claude prompt: "Produce a Markdown document titled `{{templateName}}` with the following sections (in order): `{{sections}}`. Base it on the provided source material. Output only the document with `##` headings for each section."
- Sanitizes all inputs via `sanitizeForPrompt`
- Calls `runClaude(prompt)` 
- Returns `{"content": "<markdown string>"}` with status 200

**Client formats the `sources` array** by collecting content for each selected `DocGenSource`:
- `.meeting(id:)` → fetch via `api.getMeeting(id:)`, combine `detail.transcript ?? ""` and entity summaries
- `.file(url:)` → `try String(contentsOf: url, encoding: .utf8)`

---

## API additions (`LlmIdeAPIClient+Export.swift`)

```swift
func generateDoc(templateName: String, sections: [String],
                 sources: [(name: String, content: String)]) async throws -> String
```

- POSTs to `/generate-doc` with the request body above
- Decodes `{"content": String}` from the JSON response
- 240-second timeout (same as existing `generateDocx`)
- Returns the generated Markdown string

```swift
func exportMarkdown(content: String, filename: String) throws -> URL
```

- Synchronous (no network call)
- Writes `content` as UTF-8 to `~/Downloads/<filename>.md` with the same de-collision logic as `generateDocx`
- Returns the saved URL; caller opens it in Finder via `NSWorkspace.shared.activateFileViewerSelecting`

> DOCX export is not included in v1 because the server's `docx` npm dependency is currently disabled. Once that is re-enabled, a follow-up task can add a `/export-docx` route that accepts Markdown and returns a DOCX binary, and the "Export" button can be switched to call it.

---

## UI Components

### `DocGenView`

3-panel `HSplitView`:

```
┌─────────────────┬─────────────────────────────┬───────────────────┐
│ DocGenSourcePanel│     DocGenEditorPanel       │ CodeAssistantPanel│
│  (checkboxes)   │  (template bar + doc area)  │  (reused as-is)  │
└─────────────────┴─────────────────────────────┴───────────────────┘
```

- `@State private var sourceVisible = true`
- `@State private var assistantVisible = true`
- `@StateObject private var vm = DocGenViewModel()`
- Toolbar: left sidebar toggle, right assistant toggle (same pattern as `ReviewView`)
- Passes `vm` as `@ObservedObject` to both `DocGenSourcePanel` and `DocGenEditorPanel`

### `DocGenSourcePanel`

Left panel, width `min: 200, ideal: 240, max: 300`.

Two sections:
1. **Meetings** — loaded via `api.listMeetings()` (existing endpoint); each row has a checkbox toggle, meeting title, and date. Selecting adds `.meeting(id:title:)` to `vm.selectedSources`.
2. **Library Files** — loaded from `LibraryItemStore`; shows `.notes` and `.data` categories; each row has a checkbox toggle. Selecting adds `.file(url:name:)` to `vm.selectedSources`.

"+ Add file or folder" button at the bottom opens a file importer sheet (delegates to `LibraryItemStore.importFiles`).

### `DocGenEditorPanel`

Center panel, `minWidth: 340`.

**Template bar** (always visible at top):
- "Template" label + template name button (tapping opens an inline popover listing all templates from `DocTemplateStore`, grouped Built-in / My Templates)
- "Manage…" button → presents `DocTemplateManagerSheet` as a sheet
- Spacer
- State-dependent right side:
  - `.idle` or `.generating`: "✦ Generate" button, disabled when `!vm.canGenerate`
  - `.done`: "↺ Regenerate" + "⬇ Export Markdown" buttons

**Doc area** below the bar:
- `.idle`: empty state ("Select source notes and a template, then Generate")
- `.generating`: template skeleton with placeholder rows streaming in (show sections as gray placeholders, animate the section currently being filled); "Cancel" button to cancel the `Task`
- `.done(content)`: `TextEditor` bound to a `@State var editableContent` initialized from `content`; shows "✎ Editable" badge. Changes to `editableContent` do not trigger re-generation.
- `.error(msg)`: red error text + "Try again" button

### `DocTemplateManagerSheet`

Full sheet (`presentationSizing(.medium)`), two-column layout:

**Left list** (~200 pt): all templates grouped "Built-in" / "My Templates". Selected template highlighted. "＋ New" button at bottom of list.

**Right detail**:
- For **built-in**: read-only name, read-only sections list, "Duplicate" button
- For **custom**: editable name field, reorderable sections list (drag handle + delete button per row), "Add section…" row, Save / Delete buttons in footer

Section names are plain strings (no per-section instructions). Reordering uses `List` with `.onMove`.

---

## Sidebar integration

**`ShellState.swift`:** Add `.docGen` to the `Section` enum:
```swift
case library, live, review, plans, conflicts, issues, gantt, docGen, settings
```

**`SidebarView.swift`:** Add inside the "Actions" `Section`, after "Review Doc":
```swift
sidebarRow(label: "Doc Gen", systemImage: "wand.and.document", section: .docGen)
```

**`AppShell.swift`:** Add to `detailColumn(_:)`:
```swift
case .docGen: DocGenView(api: api)
```

**`DocTemplateStore`** is instantiated once in `LlmIdeMacApp` and injected as `.environmentObject` (same pattern as `ThemeStore`).

---

## Error handling

| Scenario | Behaviour |
|----------|-----------|
| No sources selected | Generate button disabled |
| No template selected | Generate button disabled |
| Meeting fetch fails | Show inline error per item in the source panel; item is skipped from generation |
| Generation fails | `.error(msg)` state in editor; "Try again" button resets to `.idle` with sources + template preserved |
| Export fails | NSSavePanel-style error alert (AppKit `NSAlert`) — non-blocking, content preserved |
| File read fails (Library item) | Skip the item, show a warning badge on it in the source panel |

---

## Out of scope

- Saving generated docs back to the KB (export-only)
- Per-section custom prompts (sections are heading names only)
- Template sharing or syncing across machines
- Streaming token-by-token generation (section-by-section placeholder animation is sufficient)
