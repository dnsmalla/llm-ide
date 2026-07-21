> **Superseded (storage/UI):** Multi-session UUID history per scope — see `2026-07-21-cursor-style-chat-history-design.md`. Per-section isolation and Plans removal remain in effect.

# Per-Section Chat — Design

## Goal

Give each sidebar section that shows chat its **own isolated, persistent conversation**, and remove the **Plans** sidebar section. Today one chat view is embedded in several sections and they all share a single conversation; this makes each section's chat independent (no cross-section bleed) and remembered across app restarts.

## Background (current state)

- `CodeAssistantPanel` (`mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift:32`) is the chat view. Its init takes `api`, `initialURL`, `showFileAttachButtons`, `showModelPicker` — **no context/scope parameter**.
- It is embedded in **5 sidebar sections** (the user calls these "menus"), all sharing one conversation:
  - Explorer — `Views/Explorer/ExplorerView.swift:83`
  - Plans — `Views/ReviewView.swift:159` (via `AppShell.swift:436 case .plans: ReviewView(config: .docs)`)
  - Review Conflicts — `Views/ReviewView.swift:159` (via `AppShell.swift:437 case .conflicts: ReviewView(config: .conflicts)`)
  - Visual — `Views/Visual/VisualView.swift:66`
  - Doc Gen — `Views/DocGen/DocGenView.swift:47`
- The active session is a **single global pointer**: `@AppStorage("MEETNOTES_CURRENT_CHAT_SESSION_ID")` at `CodeAssistantPanel.swift:46`. Every panel instance reads/writes the same pointer → same conversation everywhere.
- `ChatSession` (`Models/ChatSession.swift:8`) — `storeVersion`, `id: UUID`, `title`, `createdAt`, `lastUsedAt`, `history: [CodeAssistTurn]`. Supports many sessions (Cursor-style picker).
- `ChatSessionStore` (`Services/ChatSessionStore.swift:12`, a static `enum`) persists to `~/Library/Application Support/LLM IDE/sessions/<uuid>.json`, **global** (not keyed by section/project). `wipeAllForFreshLaunch()` (`:111`) is called from `LlmIdeMacApp.init` and **deletes every session on each launch**, so history is effectively ephemeral across restarts.
- The panel has a multi-session picker: `sessions: [ChatSession]` state (`:72`), `SessionRow` (`Views/CodeAssistant/SessionRow.swift:10`), and `createNewSession` (`:2598`) / `switchSession` (`:2624`) / `deleteSession` (`:2648`).
- Lifecycle: `handleOnAppear` (`:292`) resolves the global pointer → loads/mints a session; `handleHistoryChange` (`:324`) → `persistCurrentSession` (`:2565`) writes on every turn.
- Out of scope (untouched): `AskAgentSheet` (`Views/Shell/AskAgentSheet.swift:11`, separate API, no persistence), `MemoryStore` (repo memory under `<repo>/system/`, not chat history), the menu bar (no chat exists there), mobile chat.

## Locked decisions

1. **Delete the Plans sidebar section.** Remove `.plans` from `ShellState.Section` and every reference; `ReviewView` remains for `.conflicts` only.
2. **Isolate chat per section** for the 4 remaining chat sections: Explorer, Review Conflicts, Visual, Doc Gen.
3. **One persistent chat per section** — each section has exactly one conversation, no multi-session picker.
4. **Persist across app restarts** — stop wiping sessions on launch.
5. **Approach 1** (section *is* the chat identity): deterministic, one file per section, no global pointer, no picker. Core chat function (send/receive, file attach, model picker) is unchanged.
6. Keep a single small **"clear chat"** header affordance per section (replace the picker).

## Design

### New type: `ChatScope`

A precise enum of the 4 chat contexts (cleaner than reusing `ShellState.Section`, which includes non-chat sections). Lives next to `ChatSession` (e.g. in `Models/ChatScope.swift` or atop `ChatSession.swift`):

```swift
enum ChatScope: String, Codable, CaseIterable {
    case explorer, conflicts, visual, docGen
}
```

### `ChatSession`

Add a stored, coded field:

```swift
struct ChatSession: Codable, Identifiable {
    let storeVersion: Int
    let id: UUID
    var scope: ChatScope          // NEW — which section this chat belongs to
    var title: String
    var createdAt: Date
    var lastUsedAt: Date
    var history: [CodeAssistTurn]
}
```

`title` is retained (auto-derived from the first user turn) but no longer surfaced in a picker.

### `ChatSessionStore` — scope-keyed

Replace the global/UUID model with one-file-per-scope:

```swift
enum ChatSessionStore {
    static func fileURL(for scope: ChatScope) -> URL           // sessions/<scope>.json
    static func load(for scope: ChatScope) -> ChatSession      // saved, or fresh ChatSession(scope:)
    static func save(_ session: ChatSession)                   // sessions/<session.scope>.json
    static func clear(for scope: ChatScope)                    // delete one scope's file
    static func clearAll()                                     // sign-out / reset (whole sessions dir)
}
```

- `baseDir` / `sessionsDir` unchanged (`~/Library/Application Support/LLM IDE/sessions/`).
- `load(for:)` returns a fresh `ChatSession(scope:)` when no file exists (first open).
- **Migration:** old UUID-named session files and the legacy `chat-history.json` are **orphaned/ignored** — the new loader only reads `<scope>.json`, and the app already wiped sessions every launch, so there is no real data loss. `migrateLegacy()` (`:130`) is removed. (Optional: a one-time sweep of non-`<scope>` files in `sessions/`; not required for correctness.)

### `CodeAssistantPanel` — wiring

- Add a required `scope: ChatScope` init parameter.
- **Remove** the `@AppStorage("MEETNOTES_CURRENT_CHAT_SESSION_ID")` global pointer.
- **Remove** the multi-session picker: the `sessions: [ChatSession]` state, `SessionRow` usage, `createNewSession`, `switchSession`. (`SessionRow.swift` becomes dead — delete.)
- `handleOnAppear` → `history = ChatSessionStore.load(for: scope).history`.
- `handleHistoryChange` → `ChatSessionStore.save(currentSession)` where `currentSession.scope == scope`.
- Repurpose `deleteSession` → `clearCurrentChat()` using `ChatSessionStore.clear(for: scope)`, wired to the header "clear chat" button (also resets in-memory `history = []`).
- The 4 embedding sites pass their scope:
  - `ExplorerView.swift:83` → `CodeAssistantPanel(..., scope: .explorer)`
  - `ReviewView.swift:159` → `scope: .conflicts`
  - `VisualView.swift:66` → `scope: .visual`
  - `DocGenView.swift:47` → `scope: .docGen`

### Persistence across restarts

- Remove the `wipeAllForFreshLaunch()` call from `LlmIdeMacApp.init` and delete the method. Section chats now survive launches.
- Sign-out still clears chats (`AccountSettingsSection.swift:62-66` calls `clearAll()`).

### Delete the Plans section

Touch points (all in `mac/Sources/`, except where noted):
- `Services/ShellState.swift` — remove `.plans` from the `Section` enum (`:9`), `label` (`:19`), `systemImage` (`:39`), the visible-sections list (`:59`), the `"plan"` string-init case (`:100`), and the section color (`:120`).
- `Views/AppShell.swift:319` — remove `.plans` from the sidebar list.
- `Views/AppShell.swift:436` — remove `case .plans: ReviewView(api: api, config: .docs)`.
- `Views/Library/MeetingDetailView.swift:270` — the "go to Plans" nav button (`shell.section = .plans`). Verify its label/context during implementation and remove it (or repoint to a sensible section if it carries a real action).
- `ReviewView` keeps serving `.conflicts`; its `.docs` config becomes unused — optional cleanup (remove the dead `.docs` case if low-risk).

Unrelated and **untouched**: `LlmIdeAPIClient+KB.swift:92 return r.plans` (KB plan-task data, not the sidebar section).

## Data flow

- **Open a section** → `CodeAssistantPanel.onAppear` → `ChatSessionStore.load(for: scope)` → populate `history` (or empty for first open).
- **Send/receive a turn** → `.onChange(of: history)` → `ChatSessionStore.save(session)` → `sessions/<scope>.json`.
- **Switch sections** → each panel instance loads its own scope independently; no shared state.
- **Clear chat** (header button) → `clear(for: scope)` deletes the file + resets `history = []`.
- **App restart** → files still on disk → `load(for:)` restores each section's chat.
- **Sign-out** → `clearAll()` wipes the whole `sessions/` dir.

## Edge cases

- First open of a section (no saved file) → `load` returns a fresh empty `ChatSession`; behaves like today's new session.
- Orphaned old UUID session files on disk after upgrade → ignored by the scope-keyed loader; harmless (optionally swept).
- Two windows / two instances of the same section → both read/write the same `<scope>.json` (last writer wins on disk); acceptable for this app's single-window model. Not a regression vs. today.
- Sign-out while a panel is showing → `clearAll()` deletes files; in-memory `history` should be reset (the panel already reacts to auth state).

## Testing

- `ChatSessionStoreTests` (new or in `mac/Tests/`): using a temp dir as `baseDir`:
  - `load(for:)` returns a fresh session when no file exists.
  - `save` round-trips (save then load yields the same `history`).
  - **Isolation**: `save` an `.explorer` session, then `load(for: .conflicts)` is unaffected (still fresh/its own data).
  - `clear(for:)` removes only that scope's file (others remain).
  - `clearAll()` removes the whole dir.
- `CodeAssistantPanel` scope wiring and the Plans deletion are **build-verified** (`swift build`) plus a grep confirming no dangling `.plans` references in `mac/Sources/`. Existing chat-related tests, if any, must still pass.

## Out of scope

- `AskAgentSheet` (separate modal chat, own API, no persistence).
- Repo/agent `MemoryStore` (per-repo markdown, unrelated to per-section chat history).
- Adding chat to more sidebar sections.
- Mobile / menu-bar chat (none exists).
- Migrating any old conversation into a section (old data is wiped today anyway).
