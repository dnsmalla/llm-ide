# Cursor-Style Per-Section Chat History — Design

## Goal

Restore a **Cursor-like chat history** in the macOS app: **+ New chat** plus a session list with per-row delete, while keeping chats **isolated per sidebar section** (Explorer, Review Conflicts, Visual, Doc Gen).

Remove the current **one-file-per-scope** model (`sessions/<scope>.json`). All section chats use the same **UUID multi-session** store.

## Background (current state)

- `CodeAssistantPanel` embeds chat in four sections via `ChatScope` (`.explorer`, `.conflicts`, `.visual`, `.docGen`).
- `ChatSessionStore` persists **exactly one** chat per scope at `sessions/<scope>.json`.
- Header exposes only a **trash Clear** control; the Cursor-style session picker (`SessionRow`, `createNewSession`, `switchSession`) was removed in the per-section chat work (2026-07-19).
- `ChatSession` has `id`, `title`, `createdAt`, `lastUsedAt`, `history` — **no `scope` field** (scope is implied by filename today).
- History already survives app restarts (no wipe-on-launch). Sign-out still clears the sessions directory.

## Locked decisions

1. **UI = Cursor-style:** header history popover with **+ New chat** + list; header trash deletes current; row trash deletes that session.
2. **Isolation = per section:** list/create/delete only affect the panel’s `ChatScope`.
3. **Storage = UUID files only:** `sessions/<uuid>.json`. Drop the one-file-per-scope API as the live path.
4. **Migrate then remove duplicates:** on first load of a scope, if `sessions/<scope>.json` exists, convert once to a UUID session with that `scope`, delete the old file, and never write `<scope>.json` again.
5. **No empty spam:** New chat while the current session is already empty titled “New chat” is a no-op.
6. **Out of scope:** rename UI, search, sync to extension/server, global “all chats” browser.

## Design

### Model: `ChatSession`

Add a required coded field:

```swift
var scope: ChatScope
```

- New sessions always set `scope` from the panel.
- Decode: missing `scope` → treat as **orphan** (not listed under any section; ignored by scoped APIs). Optional one-time cleanup of orphan UUID files is nice-to-have, not required for correctness.
- Keep `title` auto-derived from the first user turn (default `"New chat"`).

### Store: `ChatSessionStore`

Replace scope-filename CRUD with UUID multi-session APIs, filtered by scope:

```swift
enum ChatSessionStore {
    static func list(for scope: ChatScope) -> [ChatSession]  // lastUsedAt desc
    static func load(id: UUID) -> ChatSession?
    static func save(_ session: ChatSession)                 // bumps lastUsedAt
    static func delete(id: UUID)
    static func clear(for scope: ChatScope)                  // delete all with that scope
    static func clear()                                      // sign-out: wipe sessions dir
    static func migrateScopeFileIfNeeded(for scope: ChatScope) -> ChatSession?
}
```

**On-disk layout**

| Path | Role |
|------|------|
| `sessions/<uuid>.json` | One chat session (includes `scope`) |
| `sessions/<scope>.json` | **Legacy only** — read once in migration, then deleted |

**Migration (`migrateScopeFileIfNeeded`)**

1. If `sessions/<scope>.json` exists and decodes, mint/reuse its `id` (or new UUID if needed), set `scope`, `save` as `<uuid>.json`, delete `<scope>.json`.
2. If decode fails, quarantine as `.corrupt-<ts>` (same pattern as today).
3. Idempotent: second call finds no legacy file.

**Corrupt files:** rename to `.corrupt-<unix-ts>` and skip (existing pattern).

### Panel: `CodeAssistantPanel`

**Header**

- History button (chat-list / clock) → popover.
- Trash → delete **current** session, then fall back (see below).

**Popover**

1. **+ New chat** at top.
2. Divider.
3. `SessionRow` list for `list(for: scope)` only — title, relative time, hover trash, active highlight.

**State**

- `currentSessionId: UUID`
- `history` / composer / agent state as today
- `sessions: [ChatSession]` refreshed after create/switch/delete/save
- Per-scope current pointer via `@AppStorage("chat.current.<scope>")` (string UUID) so reopen lands on the last active chat in that section

**Lifecycle**

- `onAppear`: `migrateScopeFileIfNeeded(for:)` → resolve pointer / newest / mint empty → load history.
- On history change: update title if still `"New chat"`, `save`, refresh list.
- **New chat:** if current is empty “New chat”, no-op; else save current → create empty `ChatSession(scope:)` → save → switch → update pointer → close popover.
- **Switch:** save current → load target → update pointer → close popover.
- **Delete (header or row):** `delete(id)` → if deleted was current, switch to newest remaining for scope, or mint empty → update pointer.
- Never leave the panel without a current session id.

### UI component: restore `SessionRow`

Restore `mac/Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift` (title + relative timestamp; hover trash). Module-internal; only used by the panel popover.

### Call sites

No change to embedding sites beyond existing `scope:` — Explorer, Conflicts, Visual, Doc Gen already pass `ChatScope`.

### Sign-out

Unchanged: wipe entire `sessions/` directory via `clear()`.

## Error handling

| Case | Behavior |
|------|----------|
| Missing file for pointer id | Fall back to newest in scope, else mint empty; rewrite pointer |
| Corrupt JSON | Quarantine; omit from list |
| Delete last session | Mint fresh empty session for scope |
| Save failure | Log warning; keep in-memory state (existing pattern) |

## Testing

XCTest under `mac/Tests/`:

1. `list(for:)` returns only matching `scope`, sorted by `lastUsedAt` descending.
2. `save` / `load` / `delete` round-trip.
3. Migration: `<scope>.json` → one UUID file with that scope; legacy file removed; second migrate is no-op.
4. `clear(for:)` removes only that scope’s sessions.
5. Orphan (no `scope` in decode path) does not appear in `list(for:)`.

Manual (in app):

- [ ] Each section shows its own history only
- [ ] + New chat creates a new thread; old one remains in list
- [ ] Switch between chats restores messages
- [ ] Header trash deletes current; row trash deletes that row
- [ ] Restart app: histories and last-active per section restore
- [ ] Empty “New chat” + New again does not duplicate rows

## Files touched

| File | Change |
|------|--------|
| `mac/Sources/LlmIdeMac/Models/ChatSession.swift` | Add `scope` |
| `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift` | UUID multi-session + migrate; remove live `<scope>.json` API |
| `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` | Popover, new/switch/delete, AppStorage pointer |
| `mac/Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift` | Restore |
| `mac/Tests/…` | Store + migration tests |
| `docs/superpowers/specs/2026-07-19-per-section-chat-design.md` | Superseded for storage/UI: one-chat-per-section + clear-only → this spec |

## Non-goals

- Extension side panel chat history (separate surface)
- Server-backed unified chat sessions for Mac
- Renaming chats in the UI
- Cross-section “All chats” view
