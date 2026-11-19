# Self-improvement folder — plan

Date: 2026-11-19 · Status: **built** (phases 1-5 on main, 2026-11-19) · Owner decisions: see "Decisions"

## Goal

Everything the system **learns** about a project lives in one folder, `<project>/system/self-improvement/`, and the app
reads it from there. Copy the folder into another repo and that repo offers each item for review before it applies.

## Decisions (user, 2026-11-19)

1. The folder is the **source of truth** for learned knowledge. The database keeps only live or raw data.
2. **Project memory moves in** (from `system/memory/chat-memory.md`), migrated once.
3. A copied folder is **imported on review**: one "adopt?" per item, nothing applies on its own.

## What moves and what stays

| Knowledge | Today | After |
|---|---|---|
| Project memory (lasting facts) | `system/memory/chat-memory.md` | `self-improvement/memory.md` |
| Loop step lessons (`promptAddendum`) | inside `system/loop.json` stages | `self-improvement/lessons.json` |
| Accepted Loop changes (+ rationale, evidence, outcome) | DB `loop_improvements` rows only | `self-improvement/changes.jsonl` (the record); DB row keeps bookkeeping only |
| Self-Heal: what fixed or failed for a kind of error | DB incident `history` (per incident, lost on clear) | `self-improvement/self-heal.md` in the **source checkout** |
| Loop signals, review cursor, pending proposals, dismissals | DB | DB (unchanged: raw/live) |
| Self-Heal incident queue, runs, leases | DB | DB (unchanged: live) |
| Session memory, learned rate limits, usage | DB | DB (unchanged: per chat / per machine) |
| `graph-notes.md`, `doc-notes.md`, `environment.md` | `system/memory/` | `system/memory/` (graph output, not learned knowledge) |

"Bookkeeping only" means the DB row keeps `status`, `scope`, `origin`, `baseline` and `outcome`. As built (API 153):
once a decision's line is in `changes.jsonl` the row's change, rationale and evidence are cleared, and the core reads
them back from the project's log for the panel, Undo, the review and the cross-project offers. Proposals and rejected
rows keep their text in the DB (they are not learned knowledge). A failed log write keeps the DB copy.

Shell writes: besides the Edit/Write refusal, every chat Bash call is bracketed by a snapshot of the folder; a change
the app did not make is put back and kept in `inbox/from-shell-<date>/` (`llm_agent/sdk/learned-guard.mjs`); with
`LLMIDE_V2_SANDBOX=on` the folder is also in the sandbox's `filesystem.denyWrite`.

## Folder layout

```
<project>/system/self-improvement/
  manifest.json     { "format": 1, "projectId": "<id>", "projectName": "<name>", "updatedAt": "<iso>" }
  memory.md         project memory, same format as chat-memory.md today
  lessons.json      { "format": 1, "lessons": [ { "id", "loopKey", "stageKey", "text", "origin", "acceptedAt" } ] }
  changes.jsonl     one accepted / reverted / adopted change per line (append-only)
  self-heal.md      source checkout only: dated lessons from applied fixes and needs-a-person incidents
  inbox/            items from another project waiting for review (see Import)
```

- `loopKey` / `stageKey` use the shared `defaultKey` (template and stage) when there is one, so a lesson means the same
  stage in another repo. A custom stage without a key is keyed by its id and is marked `projectOnly` (never offered).
- Every text field is cleaned and capped on write and on read (`cleanAddendum`: 2000 chars per lesson; memory keeps
  today's `LLMIDE_MEM_*` caps; a change line at most 10,000 chars). A file that fails to parse is reported, never
  half-loaded, and never overwritten without a `.bak`.
- Writes are atomic (temp file + rename), like `writeChatMemoryFacts` today.

## Safety

- Add `**/system/self-improvement/**` to `DEFAULT_PROTECTED_GLOBS` (`ui/screens/loop/native/protected.ts`), so no
  Loop or Factory agent can edit its own lessons or memory during a run. Writes come only from the app (accept,
  revert, hand edit, memory extraction) and the core.
- Hand-typed lessons get the same cleaning and 2000-char cap as accepted ones (today the textarea has none).
- Imported items are data until adopted; a lesson from another repo never reaches a prompt before the user adopts it.
- Self-Heal writes `self-heal.md` only into the repo root the run was started with (already allow-listed).
- Nothing in the folder holds secrets: evidence excerpts and Self-Heal text go through `redactIncidentText`.

## Phases (each one ships on its own, tests first, `make regression` green)

### Phase 1 — folder + project memory move (core)
- `extension/graphkit/paths.mjs`: `selfImprovementDir(root)`; `chatMemoryFile(root)` → `self-improvement/memory.md`;
  old `system/memory/chat-memory.md` becomes a legacy read path.
- `memory.mjs:444` reads through `chatMemoryFile()` (today it rebuilds the path — must change, or prompts lose memory).
  One fallback list shared by the reader and `readChatMemoryFacts`.
- Migration: first read or write moves the old file (copy, verify, then delete the old one), like the graphify-out
  migration today. Never deletes before the new file is written and re-read.
- Tests to update: `graphify-memory-project-root`, `memory-roundtrip-e2e`, `project-memory`, `memory-ledger`,
  `graphify-memory-environment`. New: migration test (old only, new only, both present → new wins, old kept as `.bak`).
- Docs: `graphkit/README.md`, `docs/reference/project-layout.md`, `docs/spec/agent-runtime.md`.

### Phase 2 — Loop lessons into `lessons.json` (UI + host fs)
- Loader/saver `ui/screens/loop/native/improve/lessons.ts` (validated, atomic, hash-checked like `saveLoops`).
- `addendumSection` (`stage-exec.ts:450`) reads the lesson for the stage from `lessons.json`, not `promptAddendum`.
- Accept / revert of `setPromptAddendum`, and the "Accepted lessons" textarea, write `lessons.json`.
- One-time move: a `promptAddendum` found in `loop.json` is written to `lessons.json`, then removed from `loop.json`
  (both saves hash-checked; on a conflict nothing is removed).
- Tests: `improve-change`, `improve-panel-model`, `native-stage-exec` (addendum section), `native-model`.

### Phase 3 — accepted changes log `changes.jsonl`
- Accept, revert and adopt append one line (change, rationale, redacted evidence excerpts, scope, origin, time) **before**
  the DB decide call; the DB decide carries the line's id. If the DB call fails the panel shows it as today, and the
  next `/state` re-sends it (closes today's "applied but could not be recorded" gap).
- The outcome check writes its verdict back as a new line (`{ id, outcome }`), so the log is complete without the DB.
- The review prompt reads rejected/accepted history from the log (today from the DB).

### Phase 4 — Self-Heal learnings `self-heal.md`
- On an applied fix and on `needsHuman`, the core appends a dated entry (category, redacted message summary, the
  attempts from `history`, what fixed it or that it needs a person) to `<repo>/system/self-improvement/self-heal.md`.
- `renderBatch` adds the newest lessons for the same category (at most 5, fenced as data).

### Phase 5 — import on review (as built)
- `manifest.json` holds `root` (this project's real path). `graphkit/self-improvement-folder.mjs` `ensureOwnFolder` runs
  before every read (memory reader and writer, prompt reader, Self-Heal notes, the inbox listing): a manifest naming
  another root moves `memory.md`, `lessons.json`, `changes.jsonl`, `self-heal.md` into `inbox/<project>-<date>/`.
  A user may also copy another project's folder straight into `inbox/<name>/`.
- Memory facts and Self-Heal notes: `GET/POST /kb/agent/self-improvement/inbox` (API 152), shown in the memory viewer
  ("From <project>", Adopt / Dismiss). Lessons and Loop changes: the Loop page's Improvements panel ("Copied from
  other projects"), matched by the shared keys, applied through `applyChange` (full rules + stale check), logged as
  `adopt` with origin `imported:<project>`.
- Every writer that creates the folder writes a manifest at once (the core with this root; the desktop UI with
  `root: null`, which the core fills in on its next read). So a folder with learned files but no manifest, or with a
  damaged one, is of unknown origin and goes to `inbox/unknown-origin-<date>/` for review.
- No tool writes the folder: the chat engine refuses Edit/Write there in every permission mode (Bypass included), a
  Bash command naming it always asks, and Loop agents are refused (`isLearnedKnowledgePath`, `llm_agent/tools/gates.mjs`).
  Reading it stays allowed.

### Review fixes (2026-11-19, API 154)
- Identity: a manifest carries a random `folderId`; the core records the ids it claimed on this install (beside its DB,
  `<db>-self-improvement-folders.json`). Only an id this install claimed, whose recorded root is gone, is a MOVED
  project (claimed again). A copy here (source still exists) or a folder from another computer goes to review.
- `POST /kb/agent/self-improvement/claim` (fs.write): the Loop page calls it before writing lessons/changes and after
  creating the folder, so the shell guard never undoes the app's own write and a new manifest gets the real root.
- `logged: true` drops DB text only when the core finds the line in the project's log; a row whose line is gone is
  listed with `recordMissing` (no Undo) instead of hidden. The whole log is read (up to 64 MB).
- The Loop load hash carries lessons.json's hash: a save from a stale view that would overwrite a newer lesson is a
  conflict. Re-sent decisions carry only the decide fields (never a `projectRoot` from the file).
- Inbox adopt of a memory fact is verified before the item leaves the inbox; the Self-Heal agent's reasons are
  redacted before they are stored; Self-Heal notes use the same folder the manifest check guards.
- Left as is: the inbox GET may move a copied folder aside under `fs.read` (a safety move, never a user write); the
  shell guard skips a folder over 400 files / 16 MB and only covers native Bash in chat turns.

### Phase 5 — original sketch
- `manifest.json.projectId` ≠ this project's id → the folder (or a copied `inbox/`) is foreign. Its items are listed in
  the Loop page's Improvements panel ("From <projectName>") and in the memory viewer, each with Adopt / Dismiss.
- Adopt writes the item into this project's files with `origin: "imported:<projectName>"` and applies the lesson or
  change through the same strict validation and stale check as today's offers; Dismiss records it so it is not shown
  again. The manifest is then rewritten for this project.
- Tests: foreign manifest, partial adopt, dismiss, malformed item skipped with a reason.

## Not in scope
- Moving raw signals, the incident queue, session memory or rate limits out of the DB.
- Syncing the folder automatically between repos (the user copies it; Phase 5 handles the arrival).
- The Mac app (removed); iOS/web read memory through the API and need no change.

## Risks
- **Memory disappearing from prompts** if the reader is not switched with the writer (Phase 1 test covers it).
- **Two-step writes** (file then DB) can still split if the app quits in between; Phase 3's re-send on `/state` heals it.
- **`system/` is git-ignored in this repo** (`.gitignore:102`): the folder is shared by copying, not through git, unless
  a project chooses to commit it.
