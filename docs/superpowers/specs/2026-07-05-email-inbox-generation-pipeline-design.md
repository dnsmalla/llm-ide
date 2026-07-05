# Email note generation: folder-based, decoupled from DB — Design

Date: 2026-07-05
Status: **Designed** (awaiting implementation plan)

## Problem

Two issues surfaced after the 2026-07-04 email-todo-notes feature landed:

1. **"Email To-dos" library entry is premature.** It backs a "turn a to-do into
   an issue" workflow that isn't needed yet. The underlying code
   (`EmailTodosView`, `EmailTodosViewModel`, `EmailNoteStore`,
   `IssueTargetOptions`) is being kept for that future work, but it shouldn't
   be reachable from the Library sidebar today.

2. **Note generation is tied to live IMAP fetch + a DB dedup ledger.**
   Today `EmailSource.makeNote` classifies each message the moment it's
   fetched and relies on the server's `email_seen`/`email_state` tables purely
   to decide which messages to *fetch*. That's the right place for DB dedup
   (avoiding re-downloading mail from the server), but note **generation**
   itself should not be entangled with that fetch cycle — it should run off
   whatever raw email content sits in a folder, so the same generation code
   works regardless of whether a message arrived via IMAP fetch or was
   dropped into the folder by hand.

The user also asked that this be built as a **reusable, documented pattern**
shared with Meeting (already has one, via live capture) and, in a later
phase, Slack — not a one-off Email fix.

## Decisions (locked with the user)

1. **Library:** remove only the sidebar entry point (`emailTodosSection` in
   `LibraryView.swift`, the `.emailTodos` case in `LibraryDetailView.swift`
   and `ShellState.LibrarySelection`). `EmailTodosView`, `EmailTodosViewModel`,
   `EmailNoteStore`, `IssueTargetOptions`, and their tests **stay in the
   tree**, unreferenced, for the future "todo → issue" work.
2. **Fetch stays exactly as-is.** IMAP/Google-OAuth fetch
   (`extension/agents/email-source.mjs`, `extension/agents/google-oauth.mjs`,
   `EmailSourceSheet.swift`, `email_seen`/`email_state` DB dedup) is untouched
   — it works and is still needed to pull new mail from the server.
3. **Raw capture, plain text.** Each fetched message is saved as a plain-text
   file (`From:`/`Subject:`/`Date:` header block, blank line, body) — not
   `.eml` — into `<notesRoot>/EmailInbox/YYYY/MM/<timestamp>-<slug>.txt`.
   Files here are **never moved or deleted** by the app.
4. **Generation is a separate, folder-driven pass.** After each fetch, a
   generation pass scans the *entire* `EmailInbox/` folder (not just this
   run's new files, so manually-dropped files are picked up too), skips files
   whose content hash is already recorded on an existing note, and classifies
   + writes a note for the rest via the existing `/kb/email/classify` +
   `EmailFileStore` (unchanged). Trigger: automatically, right after fetch.
5. **Dedup without a DB:** SHA-256 of each inbox file's raw bytes, stored as
   `sourceHash` in the generated note's frontmatter. A file is "already
   processed" if some note already carries its hash. No sidecar ledger file,
   no DB table — the notes folder is the only state.
6. **Built as a reusable primitive**, not Email-specific, so Slack (Phase 2,
   separate spec) can adopt the same shape later. Meeting's existing
   live-capture pattern (`MeetingFileStore` create/append/finalize →
   summarization) is the reference this generalizes; it is not itself
   changed.
7. **Per-file failures during generation don't abort the batch** — mirrors
   the existing per-channel failure isolation in `SlackSource.ingest`.

## Scope

**In scope:** Library sidebar cleanup; the reusable `InboxStore` +
`InboxGenerationPipeline` primitive; `EmailSource` migrated onto it;
`EmailNoteFrontmatter.sourceHash`; docs; tests.

**Out of scope (explicitly deferred):**
- Slack migration onto the same primitive — a separate follow-up spec/plan
  once this lands.
- "Turn a to-do into an issue" — separate future work; the backing code is
  kept but not rewired in this change.
- Any change to Meeting's live-capture pipeline.
- Any change to the IMAP/OAuth fetch mechanism or its DB dedup.

## Design

### A. Library cleanup

Remove:
- `emailTodosSection` computed property and its call site in
  `mac/Sources/LlmIdeMac/Views/Library/LibraryView.swift`.
- The `.emailTodos` case in `LibraryDetailView.swift`'s switch.
- The `.emailTodos` case and its doc comment in
  `ShellState.LibrarySelection`.

Keep untouched: `EmailTodosView.swift`, `EmailTodosViewModel.swift`,
`EmailNoteStore.swift`, `IssueTargetOptions.swift`, and their tests
(`EmailTodosViewModelTests.swift`, `IssueTargetOptionsTests.swift`,
`EmailNoteStoreTests.swift`). They simply become unreferenced by the app's
navigation graph until the issue-filing work resumes.

### B. Reusable pipeline

New files under `mac/Sources/LlmIdeMac/Services/NotesFolder/`:

**`InboxStore`** — writes one raw captured item per file.
```swift
struct InboxStore {
    let root: URL   // e.g. <notesRoot>/EmailInbox

    @discardableResult
    func write(from: String, date: Date, subject: String, body: String) throws -> URL
}
```
Layout: `root/YYYY/MM/<yyyy-MM-dd-HHmmss>-<slug>.txt`, content:
```
From: <from>
Subject: <subject>
Date: <ISO8601 date>

<body>
```
Never deletes or moves; a second call for the same logical message just
writes another timestamped file (dedup happens downstream, by content hash,
not here).

**`InboxGenerationPipeline`** — generic scan/dedup/generate loop.
```swift
struct RawInboxItem {
    let url: URL
    let from: String
    let subject: String
    let date: Date
    let body: String
    let hash: String   // sha256 of the raw file bytes
}

enum InboxGenerationPipeline {
    /// Scans every file under `inboxRoot`, parses the header block, hashes
    /// the raw bytes, skips anything in `knownHashes`, and calls `generate`
    /// for the rest. Per-item failures are collected, not thrown — the rest
    /// of the batch still runs.
    static func run(
        inboxRoot: URL,
        knownHashes: Set<String>,
        generate: (RawInboxItem) async throws -> Void
    ) async -> (processed: Int, failures: [String])
}
```
Both types are pure filesystem + parsing code — no networking, no
`SourceContext` dependency — so they're unit-testable standalone and reusable
by any future source with the same "capture raw, generate later" shape.

### C. Email wiring

`EmailSource.fetchAndIngest` (unchanged fetch/dedup portion) replaces the
current per-message `makeNote` (classify + write) with:
1. Per fetched message: `InboxStore(root: emailInboxRoot).write(...)`.
2. After the fetch loop: read existing `sourceHash` values from all notes
   under `Email/` (new small helper, e.g. `EmailFileStore.existingSourceHashes() -> Set<String>`,
   parsing frontmatter of each `.md`), then
   `InboxGenerationPipeline.run(inboxRoot: emailInboxRoot, knownHashes:generate:)`
   where `generate` calls the existing `classifyEmail()` API +
   `EmailFileStore.writeNote`/`writeSkipped` (unchanged), now passing the
   item's `hash` through to be written as `sourceHash` in frontmatter.

`EmailNoteFrontmatter` gains:
```swift
var sourceHash: String?
```
decoded optionally (older notes without it simply have `nil`, and are never
matched by a new inbox file's hash — which is fine, they were already
generated).

`SourceIngestResult` semantics are preserved: `imported` reflects notes
written by the generation pass this run (bulk/skip/note-worthy all count, as
today); a non-empty `failures` list from the generation pass surfaces the
same way `EmailSource`'s existing failure path does.

### D. Docs

- Doc comments on `InboxStore` and `InboxGenerationPipeline` spelling out the
  two-phase pattern generically (capture now, generate later, dedup by
  content hash, never touch the raw file) so it reads as infrastructure, not
  an email-specific hack.
- A new short subsection in `docs/explanation/architecture.md` describing
  the capture → generate pipeline shape, referencing Meeting's live-capture
  flow as the pattern this generalizes, and noting Slack as the next planned
  adopter.

### E. Testing

- `InboxStoreTests` — file written at the right path with the right header
  format; multiple writes don't collide/overwrite.
- `InboxGenerationPipelineTests` — known-hash skip; unknown hash triggers
  `generate`; a `generate` throw for one item doesn't stop the rest; failures
  collected.
- Update `EmailSourceRoutingTests` / `EmailFileStoreTests` for the split
  (`routeDecision` unchanged; `writeNote`/`writeSkipped` now also assert
  `sourceHash` in frontmatter).
- End-to-end-ish: seed a few files directly into `EmailInbox/`, run the
  generation pass, assert notes appear in `Email/` and re-running produces no
  duplicates.

## Error handling

- Fetch-step failures: unchanged from today (abort, surfaced via
  `.failure`).
- `InboxStore.write` failure: propagates and aborts the fetch loop for this
  run, same as today's `writeNote`/`writeSkipped` throw behavior — nothing
  fetched this run should be silently lost.
- Generation-pass per-file failure (classify error, write error): collected
  into `failures`, loop continues to the next file. Result mapping mirrors
  `SlackSource.ingest` exactly: if `failures` is non-empty, return
  `.failure(failures.joined(separator: "; "), imported: successCount)`
  (even when some items did succeed); else if `successCount == 0` return
  `.none`; else return `.imported(successCount, ...)`.

## Out of scope (recap)

- Slack migration onto `InboxStore`/`InboxGenerationPipeline` (Phase 2, own
  spec).
- "Turn a to-do into an issue" rewiring.
- Any change to Meeting's live-capture pipeline or the IMAP/OAuth fetch
  mechanism.
