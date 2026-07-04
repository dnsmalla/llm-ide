# Email → To-do Notes Phase 2 — Readiness Note (pre-plan)

Date: 2026-07-04
Status: **Research captured — not yet a bite-sized plan.** Write the full plan
(via writing-plans) once Phase 1 is e2e-verified + merged and the 3 open
questions below are answered.

Phase 2 = the "Email To-dos" review panel + create-issues-from-to-dos, per the
approved spec `docs/superpowers/specs/2026-07-04-email-todo-notes-design.md`.

## Anchors already mapped (real code, verified)

- **Issue creation:** `RepoBackend.createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue` (`mac/Sources/LlmIdeMac/Services/Repo/RepoBackend.swift:318`). `RepoIssuePayload` fields: `title: String?`, `body: String?`, `labels: [String]?`, `dueDate: String?` ("yyyy-MM-dd", GitLab-only — GitHub ignores), plus milestone/assignee/state/weight (all optional). `RepoIssue: Identifiable, Hashable, Sendable` (`:107`) — carries the created issue's id/url for write-back.
- **Allow-list enforcement is automatic:** `AllowlistedRepoBackend.require(.createIssue)` (`AllowlistedRepoBackend.swift:41-43`) gates via `config.isAllowed(.createIssue, provider: wrapped.kind)`. So creating issues through a guarded backend is throttled by the existing allow-list with zero new code — a disabled `createIssue` throws before the network call.
- **Backend construction pattern (reuse verbatim):**
  ```swift
  let backend = providerIsGitLab
    ? RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
    : RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
  ```
  (pattern from `CodeAssistantPanel.swift:589-590`). ALWAYS go through
  `RepoBackendFactory.guarded` so the allow-list applies.
- **Library sidebar:** `LibraryView.swift:168` builds `List(selection: $shell.librarySelection)`; sidebar sections are enumerated there. A new "Email To-dos" entry hooks into this selection model.
- **Phase 1 frontmatter (the input):** `EmailFileStore` writes note-worthy `.md` with YAML frontmatter containing a `todos:` list, each `{title, detail, due, priority, issue: null}`. `issue: null` → open; a URL → done. Written under `root/Email/YYYY/MM/`.

## The 3 open questions to resolve before writing the plan

1. **Panel placement.** Does "Email To-dos" become its own top-level Library
   sidebar section, or a child under the existing Sources area? Need to match
   `LibraryView`'s section model + `shell.librarySelection` cases. (Recommend:
   its own section, since it's an action inbox, not a note folder.)

2. **Repo/project selection.** How does the user pick *which* repo+project an
   issue lands in? Options: (a) a picker of the user's configured repos in the
   panel; (b) a single "default issue repo" setting. `createIssue` needs a
   `projectId` — must confirm how existing UI resolves the active repo→projectId
   (look at how `CodeAssistantPanel` derives `projectId` for its issue calls).
   (Recommend: per-create picker of configured repos, remembering last choice.)

3. **Reading todos back.** `EmailFileStore` wrote *custom* YAML frontmatter (NOT
   `MeetingFrontmatter`, so `FrontmatterCoder` can't decode it). Phase 2 needs a
   small `EmailNoteFrontmatter` Codable + a reader to parse `todos[]`/`issue`
   from the `.md`, and a writer to set `issue:` + check the box on success.
   Decide: dedicated `EmailNoteStore` (parse + write-back), keeping files as the
   source of truth. (Recommend: yes — a focused reader/writer beside
   `EmailFileStore`.)

## Provisional task shape (to firm up in the plan)

1. `EmailNoteFrontmatter` Codable + reader: scan `Email/**/*.md`, parse open
   to-dos (issue == null). TDD.
2. Write-back: set a to-do's `issue:` URL + check its `- [ ]` box in the `.md`
   atomically. TDD (round-trip).
3. `EmailTodosViewModel`: aggregate open to-dos across notes; selection state.
4. Review panel UI in Library + wire selection → repo picker → guarded
   `createIssue` → write-back; create disabled when `.createIssue` not allowed.
5. End-to-end + full suites + docs.

## Do NOT start Phase 2 until

- Phase 1 is e2e-verified (real email → to-do note file) and merged, so the
  frontmatter contract is confirmed stable, and
- the 3 questions above are answered.
