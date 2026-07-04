# Email → To-do Notes (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Email To-dos" review panel in the Library that lists the open to-dos extracted from Phase 1's email notes, lets the user select them and pick a target repo, and creates GitHub/GitLab issues (through the existing allow-listed backend) — writing the created issue URL back into the note so a to-do is done exactly once.

**Architecture:** Files stay the source of truth. A new `EmailNoteStore` scans the `Email/` folder, parses each note's YAML frontmatter into a new `EmailNoteFrontmatter` (open to-do = `issue == nil`), and writes back the issue URL on success. A new `EmailTodosViewModel` aggregates open to-dos and drives issue creation via `RepoBackendFactory.guarded(...).createIssue(...)`. A new `EmailTodosView` renders in the Library via a new `LibrarySelection.emailTodos` case.

**Tech Stack:** SwiftUI macOS, swift-testing, Yams (`YAMLDecoder`/`YAMLEncoder`, already used by `FrontmatterCoder`).

## Global Constraints

- Files are the source of truth — a to-do's `issue:` frontmatter field (nil → open, URL string → done) is authoritative; the `- [ ]`/`- [x]` body checkbox is cosmetic, updated best-effort.
- Issue creation MUST go through `RepoBackendFactory.guarded(_:config:)` so the per-provider allow-list applies; the "Create issues" action is disabled when `config.isAllowed(.createIssue, provider:)` is false — reuse the existing allow-list UI treatment, never bypass.
- Target repo/project comes from the user's configured repos: `config.gitLabSavedProjects` (`SavedGitLabProject`, projectId = `String(resolvedId)`) and `config.gitHubSavedRepos` (`SavedGitHubRepo`, projectId = `"owner/name"` via `GitHubClient.ownerAndName(from:)`). Default the picker to the `isActive` one.
- Email note files are under `<notesRoot>/Email/YYYY/MM/*.md`.
- No new backend routes, no new secret surface, no DB.

## Interfaces already in the codebase (consume these)

- `AllowlistedRepoBackend` gates `createIssue` via `config.isAllowed(.createIssue, provider: wrapped.kind)`; `RepoBackendFactory.guarded(_ client:RepoBackend, config:) -> RepoBackend`.
- `RepoBackend.createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue`. `RepoIssuePayload { title:String?; body:String?; labels:[String]?; dueDate:String? }`. `RepoIssue: Identifiable, Hashable, Sendable` exposes the created issue (has a URL/id — confirm the exact property name when implementing Task 4; it's used only for write-back).
- `SavedGitLabProject { id; url; displayName; resolvedId:Int?; isActive; ... }` (Config.swift:38); `SavedGitHubRepo { id; url; displayName; resolvedId:Int?; isActive; ... }` (GitHubModels.swift:43). `GitHubClient.ownerAndName(from url:) -> (String,String)?`.
- `RepoBackendKind` (`.gitlab` / `.github`); `GitLabClient(config:)` / `GitHubClient(config:)`.
- `FrontmatterCoder.split(file: String) -> (yaml: String, bodyStart: String.Index)?` (generic; reuse). `FrontmatterCoder.decode` is hard-typed to `MeetingFrontmatter` — do NOT reuse for email.
- `LibrarySelection` enum (ShellState.swift:63) + `shell.librarySelection`. `LibraryView.mainList` builds `List(selection:$shell.librarySelection)`; the detail pane switches on the selection (find `LibraryDetailView`).
- Phase-1 note frontmatter shape (written by `EmailFileStore`): `source, from, date, category, noteWorthy, todos: [{title, detail, due, priority, issue}]`.

---

### Task 1: `EmailNoteFrontmatter` + `EmailNoteStore.scanOpenTodos()`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Models/EmailNoteFrontmatter.swift`
- Create: `mac/Sources/LlmIdeMac/Services/NotesFolder/EmailNoteStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/EmailNoteStoreTests.swift`

**Interfaces:**
- Produces: `struct EmailNoteFrontmatter: Codable, Equatable { var source:String; var from:String; var date:String; var category:String; var noteWorthy:Bool; var todos:[Todo]; struct Todo: Codable, Equatable { var title:String; var detail:String; var due:String?; var priority:String; var issue:String? } }`
- Produces: `struct OpenTodo: Identifiable, Equatable { let id:String; let file:URL; let todoIndex:Int; let from:String; let subject:String; let title:String; let detail:String; let due:String?; let priority:String }` and `struct EmailNoteStore { let root: URL; init(root:URL); func scanOpenTodos() -> [OpenTodo] }` where `root` is `<notesRoot>/Email`.
- `id` = `"\(file.path)#\(todoIndex)"`. `subject` is parsed from the note's `# <subject>` H1 (fallback "Email"). `scanOpenTodos` recurses `root/**/*.md`, decodes frontmatter, and yields one `OpenTodo` per todo whose `issue == nil`; notes with `noteWorthy == false` or no todos yield nothing; unparseable files are skipped (logged), never throw.

- [ ] **Step 1: Write the failing test** — write two `.md` files into a temp `Email/2026/07/` dir (one note-worthy with 2 todos, one already having `issue: "https://x/1"` on a todo; one skipped stub), then assert `scanOpenTodos()` returns exactly the open ones with correct `title/subject/file/todoIndex`, and skips the done + skipped notes.

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("EmailNoteStore")
struct EmailNoteStoreTests {
  private func write(_ root: URL, _ rel: String, _ body: String) throws {
    let u = root.appendingPathComponent(rel)
    try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
    try body.data(using: .utf8)!.write(to: u)
  }
  @Test func scansOnlyOpenTodos() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("em-\(UUID().uuidString)")
    try write(root, "2026/07/a.md", """
    ---
    source: email
    from: "aki@co.com"
    date: 2026-07-04T09:00:00Z
    category: action_request
    noteWorthy: true
    todos:
      - title: "Send Q3"
        detail: "by Fri"
        due: "2026-07-10"
        priority: high
        issue: null
      - title: "Book room"
        detail: "for review"
        due: null
        priority: med
        issue: "https://gl/issues/9"
    ---
    # Quarterly review

    ## To-dos
    """)
    try write(root, "2026/07/b.md", """
    ---
    source: email
    from: "news@co.com"
    date: 2026-07-04T09:00:00Z
    category: newsletter
    noteWorthy: false
    skipped: newsletter
    ---
    # Weekly digest
    """)
    let todos = EmailNoteStore(root: root).scanOpenTodos()
    #expect(todos.count == 1)
    #expect(todos[0].title == "Send Q3")
    #expect(todos[0].subject == "Quarterly review")
    #expect(todos[0].todoIndex == 0)
  }
}
```

- [ ] **Step 2: Run — FAIL.** `cd mac && swift test --filter EmailNoteStoreTests` (missing types).

- [ ] **Step 3: Implement.** `EmailNoteFrontmatter.swift` = the struct above. `EmailNoteStore.swift`:
  - `scanOpenTodos()`: `FileManager.default.enumerator(at: root, includingPropertiesForKeys:nil)`; for each `.md`: read contents; `guard let split = FrontmatterCoder.split(file: contents) else { continue }`; `guard let fm = try? YAMLDecoder().decode(EmailNoteFrontmatter.self, from: split.yaml), fm.noteWorthy else { continue }`; parse subject from the first `# ` line in the body (`String(contents[split.bodyStart...])`), fallback "Email"; for each `(i, t) in fm.todos.enumerated() where t.issue == nil` append an `OpenTodo`. Wrap per-file work in do/catch and log+skip on failure.
  - Use `import Yams`.

- [ ] **Step 4: Run — PASS.** `swift test --filter EmailNoteStoreTests` (sandbox off if the toolchain errors).

- [ ] **Step 5: Commit** — `git commit -m "feat(mac): EmailNoteStore scans open to-dos from email notes"`

---

### Task 2: `EmailNoteStore.markTodoCreated(...)` write-back

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/NotesFolder/EmailNoteStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/EmailNoteStoreTests.swift` (add cases)

**Interfaces:**
- Produces: `func markTodoCreated(file: URL, todoIndex: Int, issueURL: String) throws` — decode the file's frontmatter, set `todos[todoIndex].issue = issueURL`, re-encode the frontmatter with `YAMLEncoder`, rewrite the file (frontmatter + original body preserved), atomically. Best-effort: also flip the matching `- [ ] <title>` body line to `- [x] <title> — <issueURL>` if present (match by title; if not found, skip silently — frontmatter is authoritative).

- [ ] **Step 1: Write the failing test** — write a note with an open todo, call `markTodoCreated(file:todoIndex:0, issueURL:"https://gl/issues/42")`, re-scan → that todo no longer appears in `scanOpenTodos()`, and re-reading the file shows `issue: "https://gl/issues/42"` in the frontmatter. Round-trip: a second `scanOpenTodos()` returns the remaining open todos only.

```swift
  @Test func markTodoCreatedClosesIt() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("em-\(UUID().uuidString)")
    try write(root, "2026/07/a.md", """
    ---
    source: email
    from: "aki@co.com"
    date: 2026-07-04T09:00:00Z
    category: action_request
    noteWorthy: true
    todos:
      - title: "Send Q3"
        detail: "by Fri"
        due: "2026-07-10"
        priority: high
        issue: null
    ---
    # Quarterly review

    ## To-dos

    - [ ] Send Q3 — due 2026-07-10 (high)
    """)
    let store = EmailNoteStore(root: root)
    let open = store.scanOpenTodos()
    #expect(open.count == 1)
    try store.markTodoCreated(file: open[0].file, todoIndex: 0, issueURL: "https://gl/issues/42")
    #expect(store.scanOpenTodos().isEmpty)
    let text = try String(contentsOf: open[0].file, encoding: .utf8)
    #expect(text.contains("https://gl/issues/42"))
  }
```

- [ ] **Step 2: Run — FAIL** (no `markTodoCreated`).
- [ ] **Step 3: Implement** per the interface. Preserve the body via `FrontmatterCoder.split`. Guard `todoIndex` in bounds (throw a clear error otherwise). Write with `.atomic`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): EmailNoteStore.markTodoCreated writes issue URL back"`

---

### Task 3: `IssueTargetOption` list (reuse the resolver logic)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/Repo/IssueTargetOptions.swift`
- Test: `mac/Tests/LlmIdeMacTests/IssueTargetOptionsTests.swift`

**Interfaces:**
- Produces: `struct IssueTargetOption: Identifiable, Hashable { let id:String; let kind:RepoBackendKind; let projectId:String; let label:String; let isActive:Bool }` and `enum IssueTargetOptions { @MainActor static func all(config: AppConfig) -> [IssueTargetOption] }` — GitLab projects with a non-nil `resolvedId` → `projectId=String(resolvedId)`, `label="<display> (GitLab)"`; GitHub repos with a parseable URL → `projectId="owner/name"`, `label="owner/name (GitHub)"`. `isActive` mirrors the saved record. Skip providers whose token is empty. This is the multi-target generalization of `CodeAssistantPanel.resolveIssueTarget()` (which returns only the active one) — the panel picker uses `all(...)`, defaulting the selection to the `isActive` option.

- [ ] **Step 1: Write the failing test** — build an `AppConfig` (test UserDefaults) with a GitHub token + one saved repo `url:"https://github.com/o/n", isActive:true` and a GitLab token + one project `resolvedId:7, isActive:false`; assert `all(config:)` returns 2 options with `projectId` `"o/n"` and `"7"`, correct kinds, and `isActive` flags.

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** using `GitHubClient.ownerAndName(from:)` for the GitHub projectId and `String(resolvedId)` for GitLab; read `config.gitHubToken`/`config.gitLabToken` to skip empty-token providers.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): IssueTargetOptions lists configured repos for issue creation"`

---

### Task 4: `EmailTodosViewModel` (aggregate + create issues)

**Files:**
- Create: `mac/Sources/LlmIdeMac/ViewModels/EmailTodosViewModel.swift`
- Test: `mac/Tests/LlmIdeMacTests/EmailTodosViewModelTests.swift`

**Interfaces:**
- Produces: `@MainActor final class EmailTodosViewModel: ObservableObject { @Published var open:[OpenTodo]; @Published var selected:Set<String>; @Published var target:IssueTargetOption?; @Published var status:String?; func reload(notesRoot:URL); func payload(for:OpenTodo) -> RepoIssuePayload; func createSelected(config:AppConfig, notesRoot:URL) async }`.
- `payload(for:)` (pure, unit-tested): `RepoIssuePayload(title: todo.title, body: <detail + "\n\nDue: \(due)" if due + "\n\nFrom email: \(from) — \(subject)">, labels: nil, dueDate: todo.due)`.
- `createSelected`: builds the guarded backend from `target.kind` (`RepoBackendFactory.guarded(target.kind == .gitlab ? GitLabClient(config:) : GitHubClient(config:), config:)`); for each selected open todo, `createIssue(projectId: target.projectId, payload:)`, then `EmailNoteStore(root:).markTodoCreated(file:todoIndex:issueURL: issue.<url>)`; collect per-todo errors into `status`; `reload` at the end. (The network path is integration; tests cover `payload(for:)` + target→client-kind selection, not live network.)

- [ ] **Step 1: Write the failing test** — construct an `OpenTodo` and assert `payload(for:)` maps title/dueDate and includes the from/subject in the body; assert that with `target == nil`, `createSelected` sets a "pick a target" status and creates nothing.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Confirm the exact `RepoIssue` URL property when wiring `markTodoCreated` (grep `struct RepoIssue`). Guard: no target → status "Choose a repo first."; empty selection → status "Select at least one to-do.".
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): EmailTodosViewModel builds issue payloads + creates issues"`

---

### Task 5: Library wiring — `LibrarySelection.emailTodos`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift` (add enum case)
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` (sidebar row + detail routing)

**Interfaces:**
- Produces: `LibrarySelection.emailTodos` case; a sidebar row (in the Sources area) tagged `.emailTodos`; the detail-pane switch renders `EmailTodosView` (Task 6) for that case.

- [ ] **Step 1:** Add `case emailTodos` to `LibrarySelection` (ShellState.swift:63). `swift build`.
- [ ] **Step 2:** In `LibraryView.mainList`, add a `Label("Email To-dos", systemImage: "checklist")` row `.tag(ShellState.LibrarySelection.emailTodos)` near the Sources/meetings section. In the detail switch (find where other cases render), add `case .emailTodos: EmailTodosView()` (Task 6 provides it — until then, a `Text("Email To-dos")` placeholder to compile).
- [ ] **Step 3:** `swift build` clean; `swift test` full suite unaffected (no logic change).
- [ ] **Step 4: Commit** — `git commit -m "feat(mac): add Email To-dos section to the Library sidebar"`

---

### Task 6: `EmailTodosView` panel UI

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/Library/EmailTodosView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift` (swap the Task-5 placeholder for the real view)

**Interfaces:**
- Consumes: `EmailTodosViewModel`, `IssueTargetOptions.all(config:)`, `config.isAllowed(.createIssue, provider:)`, the notes root (same source `EmailSource` uses — resolve it the way the app resolves `ctx.root`; find the shared notes-root accessor).

- [ ] **Step 1:** Build `EmailTodosView`: `@EnvironmentObject var config`, `@StateObject var vm = EmailTodosViewModel()`, `.onAppear { vm.reload(notesRoot:) ; vm.target = IssueTargetOptions.all(config:).first(where:\.isActive) }`. Layout (match existing Library panel styling — `Typography`/`Spacing`/`theme`):
  - Header + a `Picker` over `IssueTargetOptions.all(config:)` bound to `vm.target`.
  - A `List` of `vm.open` grouped by `subject`/`from`, each row a toggle bound into `vm.selected` + title/detail/due/priority + a link to the source note.
  - A "Create issues" button: `.disabled(vm.selected.isEmpty || vm.target == nil || !config.isAllowed(.createIssue, provider: vm.target?.kind == .gitlab ? .gitLab : .gitHub))`; on tap `Task { await vm.createSelected(config:notesRoot:) }`. When disallowed, show the same "operation disabled" hint the allow-list UI uses.
  - `vm.status` line for results/errors.
- [ ] **Step 2:** Swap the placeholder in `LibraryView` for `EmailTodosView()`.
- [ ] **Step 3:** `swift build` clean; `swift test` full suite green.
- [ ] **Step 4: Manual (controller/human):** open the app, add an email source, fetch a real actionable email, open **Email To-dos**, pick a repo, Create issues → verify an issue is created and the to-do disappears from the panel (its note now carries the issue URL).
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): Email To-dos review panel — select + create issues"`

---

## Self-Review notes

- **Spec coverage:** review panel (T5/T6), open-todo scan (T1), select + pick repo (T3/T6), create via allow-listed backend (T4), write-back/idempotency (T2), no DB (files only). ✓
- **Type consistency:** `OpenTodo.id = "\(path)#\(index)"` used as the selection key across T1/T4/T6; `EmailNoteFrontmatter.Todo.issue: String?` is the authoritative done-flag across T1/T2; `IssueTargetOption.projectId` feeds `createIssue(projectId:)` in T4. ✓
- **Open item for the implementer:** confirm the exact `RepoIssue` URL property name (Task 4 Step 3) and the shared notes-root accessor (Task 6) — both exist; grep before writing.
- **Deferred to a later phase:** filename-collision dedup for same-second/same-subject emails (noted in Phase 1 review); a per-todo "dismiss" (skip without creating an issue).
