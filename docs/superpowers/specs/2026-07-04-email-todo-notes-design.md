# Email → To-do Notes → Issues — Design

Date: 2026-07-04
Status: **Designed** (awaiting implementation plan)
Branch: `feat/email-todo-notes`

## Problem

Today every fetched email is dumped into the **meeting** pipeline: the email body
becomes a fake "transcript" and the generic meeting summarizer
(`MeetingSummarizationService` → `POST /kb/summarize` → `summarizeTranscript`)
runs on it. A newsletter, a receipt, a 2-line reply, and a real request all get
the same "meeting summary" treatment. There is no classification, no "is this
worth a note" filter, and no extraction of the actual **actionable** content.

The user wants: **fetch email → LLM categorizes it → extract clear to-dos →
review and turn selected to-dos into issues** (GitHub/GitLab), reusing the
existing Issues system and the per-provider allow-list.

## Decisions (locked with the user)

1. **Filter noise + tailor the note.** Classify each email; skip automated/bulk
   (newsletter, marketing, receipt, notification, OTP); keep human-written mail.
2. **Skip boundary = automated & bulk.** Anything a real person wrote is kept.
3. **Dedicated `Email` folder**, separate from meeting notes. Note-worthy →
   processed note; **skipped → raw `.md` kept** (marked `skipped`) so nothing is
   silently lost.
4. **Note = to-dos.** The note's purpose is a clear to-do extraction so they can
   become issues.
5. **Review, then create.** The user picks which to-dos become issues and the
   target repo/provider; creation goes through the **existing repo backend**,
   which already enforces the allow-list (`createIssue`). No auto-create.
6. **Architecture A:** a server-side classify/extract endpoint reusing the
   existing summarize model dispatch; the `.md` files are the source of truth
   (no new DB table).

## Build order

Two independently-testable plans on this one branch:

- **Phase 1** — fetch → categorize → to-do note in the `Email` folder.
- **Phase 2** — the "Email To-dos" review panel + create-issues-from-to-dos.

---

## Phase 1 — Classify + extract + note

### Data flow

```
fetchEmails (existing, OAuth/app-password)  →  Mac gets messages
  for each message:
    heuristic pre-filter:
      sender matches no-reply@ / noreply@ / donotreply@  ⇒  bulk (no LLM call)
    else: POST /kb/email/classify  →  { category, noteWorthy, summary, todos[] }
    if noteWorthy:  write NOTE .md  (summary + structured to-dos) to Email/YYYY/MM/
    else:           write RAW  .md  (frontmatter noteWorthy:false, skipped:<cat>)
  markEmailSeen (existing high-water + seen-ledger)
```

Classification runs **per email** (mirrors the per-note meeting summarizer) on a
**cheap/fast model**. The heuristic pre-filter (sender-address only — the fetched
`EmailMessage` carries no raw headers) avoids an LLM call for obvious automated
senders; everything else goes to the LLM, which catches newsletters/marketing by
content. Classification never blocks the fetch (see Error handling).

> Future optimization: a `List-Unsubscribe`-header check would catch more bulk
> mail cheaply, but requires plumbing headers through `fetchRecentEmails` →
> `EmailMessage` first; out of scope for v1.

### Backend: `POST /kb/email/classify` (authed)

New agent `extension/agents/email-classify.mjs` (network via the same model
dispatch `summarizeTranscript` uses; no new provider surface). Route in
`extension/kb/router.mjs` next to `/kb/summarize`, added to `openapi.yaml` +
`docs/spec/api-server.md`.

Request:
```json
{ "subject": "...", "from": "aki@company.com", "date": "2026-07-04T09:12:00Z", "body": "..." }
```
Response (server validates this shape; one retry on malformed JSON):
```json
{
  "category": "personal|work|action_request|meeting|newsletter|marketing|receipt|notification|otp|other",
  "noteWorthy": true,
  "summary": "One-line gist of what this email is really about",
  "todos": [
    { "title": "Send Q3 numbers to Aki", "detail": "Aki asked for the Q3 figures by Fri",
      "due": "2026-07-10", "priority": "high" }
  ]
}
```
- `noteWorthy` is `false` for skip categories → the server returns no `summary`/
  `todos` (client writes the raw stub without a second call).
- `todos` is `[]` for a kept email with no real action (FYI/thanks); the note
  still saves with the summary.
- `due` may be `null`; `priority ∈ low|med|high`.

### Mac: note writer + Email source

`EmailSource.swift` (`makeNote`) stops routing email through the meeting
pipeline and instead:
1. runs the heuristic pre-filter,
2. calls `api.classifyEmail(subject:from:date:body:)` (new in
   `LlmIdeAPIClient+Email.swift`, returning a decoded
   `EmailClassification { category, noteWorthy, summary, todos: [EmailTodo] }`),
3. writes via a new **`EmailFileStore`** (parallel to `MeetingFileStore`, rooted
   at a new `Email/` subfolder under the notes root) — keeping email files out of
   the meeting/date tree.

Note-worthy `Email/YYYY/MM/<date>-<slug>.md`:
```markdown
---
source: email
from: aki@company.com
date: 2026-07-04T09:12:00Z
category: action_request
noteWorthy: true
todos:
  - title: "Send Q3 numbers to Aki"
    detail: "Aki asked for the Q3 figures by Fri"
    due: "2026-07-10"
    priority: high
    issue: null        # set to the issue URL once created (Phase 2)
---
# <subject>

**Summary:** <one-line gist>

## To-dos
- [ ] Send Q3 numbers to Aki — due 2026-07-10 (high)

## Original
<original email body>
```
Skipped `.md`: frontmatter `noteWorthy: false`, `skipped: newsletter`, body =
raw email only (no LLM fields, no `## To-dos`).

The structured `todos` frontmatter (not the human checkbox list) is the
machine-readable source Phase 2 reads/writes.

---

## Phase 2 — Review & create issues

### "Email To-dos" panel (Mac)

A Library sidebar entry that scans `Email/` notes for **open** to-dos
(frontmatter `todos[]` where `issue == null`), grouped by source email. Each row:
title, detail, due, priority, link to the source note.

### Flow

```
select to-dos (checkboxes)
  → pick target repo/provider (from configured repos)
  → "Create issues"
      for each selected to-do:
        RepoBackend.createIssue(projectId:, payload: RepoIssuePayload(
          title: todo.title,
          body:  todo.detail + due + backlink to the Email note))
        (backend is AllowlistedRepoBackend → createIssue gated by the allow-list)
  → on success: set that to-do's `issue:` to the returned RepoIssue URL in the
    note frontmatter + check the box in the "## To-dos" list
```

- The create action is **disabled** (greyed, with the standard "operation
  disabled" reason) when `createIssue` is OFF for the chosen provider — reusing
  the existing allow-list UI treatment; never attempted.
- **Idempotency:** a to-do with a non-null `issue:` is "done" — checked off,
  carries its issue link, and is filtered out of the panel. No new DB table; the
  `.md` frontmatter is the source of truth.

### Reused infra (unchanged)

- `RepoBackend.createIssue(projectId:payload:)` / `RepoIssuePayload` / `RepoIssue`
- `AllowlistedRepoBackend` (allow-list enforcement) + `RepoBackendFactory.guarded`
- The existing repo/provider configuration + picker.

---

## Error handling

- **Classify fails / times out** → write the **raw `.md`** (`noteWorthy` unknown,
  frontmatter `classifyError: true`) so nothing is lost; fetch never blocks;
  re-classifiable later.
- **Malformed LLM JSON** → server schema-validates, retries once, else returns
  `noteWorthy: true, todos: []` (user keeps summary/raw, no auto to-dos).
- **Issue creation fails** (network / API / rate-limit) → per-to-do error
  surfaced; that to-do stays open (`issue` stays null, retryable); no partial
  "done".
- **createIssue disallowed** by allow-list → create disabled up front.

## Testing

- **Backend** (`email-classify.test.mjs`): valid schema for sample emails
  (mocked model); skip categories → `noteWorthy:false`; schema-validate + one
  retry on bad JSON; timeout → error surfaced (not a hang).
- **Mac** — `EmailFileStore`: note-worthy note has correct frontmatter/to-dos +
  `## To-dos`; skipped note is raw-only. Heuristic pre-filter
  (`no-reply@`/`noreply@` sender → bulk, no LLM). Review panel: open-to-do
  scan; selection → `createIssue` payload; allow-list OFF → create disabled;
  idempotency (issue URL written back, to-do leaves the panel).
- **End-to-end:** a sample fetched email lands as an `Email/` note with
  structured to-dos.
- Full mac + ext suites green; `make docs-check` green (new route documented).

## Security

- No new secret surface. `/kb/email/classify` is authed; email content is sent
  to the same model dispatch the app already uses for summaries.
- Issue creation stays behind the existing per-provider allow-list — email-driven
  to-dos cannot bypass a disabled `createIssue`.

## Out of scope

- Auto-creating issues without review.
- Non-Gmail specifics (works for any fetched email regardless of auth method).
- Re-classifying the existing meeting-notes backlog.
- A DB-backed to-do store (files are the source of truth for v1).
