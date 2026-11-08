# Chat history per project

Host API v1 clients (the iPhone app and the web app) keep a separate chat history for each project. The
decision builds on project-scoped roles (ADR 0022); the wire contract is API 128 in
[api-server](../spec/api-server.md#7q-per-project-chat-history-api-128).

## What a project's history is

- A chat session belongs to at most one project (`chat_sessions.project_id`).
- The Host API keeps **one current chat per (user, project)**. `chat.new` replaces only that project's
  current chat; other projects' chats are untouched.
- A chat that existed before project-scoped history (or a pairing that sends no `projectId`) is
  **legacy/global**: its `project_id` is NULL and it lives in the no-project list.
- The desktop app's own chat store is separate and is unchanged. A server-side list is only used by Host
  API clients; the desktop UI keeps its current behavior.

## Frames

| Frame | `projectId` |
|---|---|
| `chat.sessions` | list only that project's chats; omitted = legacy/global chats |
| `chat.history` | the named session must belong to the same project, else `denied` + `PROJECT_MISMATCH` |
| `chat.new` | create the new current chat in that project |
| `chat.send` | run the turn on that project's current chat |
| `chat.snapshot` | the project's current transcript |
| `chat.history.clear` | clear that project's current chat |
| `chat.cancel`, `chat.options`, `approvals.answer`, `toolApprovals.answer` | checked against the project grant, as before |

On a hub (`LLMIDE_HUB=1`) every project-scoped frame must name a project; otherwise the host answers
`denied` with `PROJECT_REQUIRED`. An unassigned caller is a viewer on that project and may Ask only.

A Host API error frame has no HTTP status: `denied` is its 403 class. The literal `PROJECT_MISMATCH` /
`PROJECT_REQUIRED` in the message is what the web and iOS pickers map to their reason, so older clients
keep working.

## Clients

- **Web**: the History list (`chat.sessions`) and one chat (`chat.history`) send the picker's selected
  project. Switching projects clears the previous project's list and open chat, drops any reply still in
  flight for it, then loads the new project's chats.
- **iOS**: the History tab follows the same `projectsStore.selectedId`; switching projects clears the
  previous list and open chat before reloading.
- **Desktop**: no UI change. The local chat store is not segmented by this feature.

## HTTP

`GET /kb/chat/sessions?projectId=…` returns that project's chats. Without `projectId` the route keeps its
existing whole-list behavior (the extension's current call). An invalid id is 400 `VALIDATION_FAILED`.
`POST /kb/chat/sessions` already accepted `projectId` and now validates its grammar.

## Migration

`0074_chat_project_scope.sql`:

1. Adds the `(user_id, project_id, updated_at)` list index.
2. Normalizes an empty `project_id` to NULL. Every session written before this migration was the global
   Host API chat and stays NULL.
3. Creates `host_api_project_chat(user_id, project_id, chat_session_id)`, one current chat per project
   (`project_id` `''` is the legacy/global chat), and copies the pre-0074 single pointer into it.

The old `host_api_quick_chat` table is kept for downgrade safety but is no longer read or written.

## Verify

- `cd extension && npm test` covers the store, the gateway (`tests/host-api-project-chat.test.mjs`) and the
  migration (`tests/migration-0074-chat-project.test.mjs`).
- `cd web && npm test` covers the History project switch (`tests/read-controller.test.mjs`).
- `make test-shared-protocol` covers the iOS wire payloads and the read controller.
