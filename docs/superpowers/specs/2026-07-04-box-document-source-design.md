# Box Document Source — Design

Date: 2026-07-04
Status: **Designed** (awaiting implementation plan)
Branch: `feat/box-document-source`

## Problem

The system ingests external sources (Email, Slack, Git repos, GitHub issues, QA) into a per-user knowledge base, and the Sources UI already stubs a `documents` source as "coming soon" (`InputSourceRegistry.swift`). The user wants to add **Box** (box.com) as a document source: pull documents from a Box folder into this system so the agent and `/kb/search` can use them, and have the ingested content saved (tenant-scoped) like every other source.

Box has no long-lived personal access token (developer tokens expire in 60 min), so auth needs a deliberate choice.

## Decisions (locked with the user)

1. **Ingestion pattern — Pattern A (server indexes into the KB).** The server fetches each Box file's extracted text, chunks it, and writes rows to the existing `sources` table with `kind='doc'`. No Mac-side note generation. Mirrors `connectors/git.mjs` (`indexLocalRepo`).
2. **Auth — Box Client-Credentials Grant (CCG).** A Box server app. `clientId`, `subjectType` (`enterprise`|`user`), `subjectId` are non-secret config; `clientSecret` lives in the encrypted vault. The server exchanges these for a short-lived access token per index run (no refresh-token storage).
3. **Scope — Box-specific first.** Promote the `documents` stub to a live Box source. Generalizing to other doc providers is deferred until a second provider exists.
4. **Re-index — wholesale per sync** (matches git): delete this folder's existing `doc` rows, re-fetch + re-insert. No incremental `box_state` table, so **no migration** for v1.
5. **Unsupported files — skipped + logged**, not errored (binary/no-text-representation files).

## Architecture

```
   Mac: BoxSourceSheet ──(setSecret box.clientSecret)──▶ vault (user_secrets)
        SavedBoxSource (UserDefaults: clientId, subjectType, subjectId, folderId)
        "Re-sync" ──POST /kb/connect-box──▶ router.mjs
                                              │
                                              ▼
                           connectors/box.mjs  indexBoxFolder(userId, creds)
                             1. CCG token exchange (api.box.com/oauth2/token)
                             2. recursive folder list (/2.0/folders/{id}/items)
                             3. per file: extracted_text representation
                             4. chunkLines → {kind:'doc', ref:'box:<fileId>', …}
                             5. deleteSourcesByPrefix(doc, box:<folderId>) + ingestSources
                                              │
                                              ▼
                          sources table (SQLite, user_id-scoped) → FTS `search`
```

Everything runs server-side except configuration/trigger. The connector is a peer of `git.mjs`/`issues.mjs`.

## Components

### 1. Box auth helper (in `extension/connectors/box.mjs`)
- `exchangeCCGToken({clientId, clientSecret, subjectType, subjectId})` → `{accessToken}`.
  - `POST https://api.box.com/oauth2/token`, form body: `grant_type=client_credentials`, `client_id`, `client_secret`, `box_subject_type` (`enterprise`|`user`), `box_subject_id`.
  - Fixed host (`api.box.com`) → no SSRF check needed (like slack).
  - On non-2xx, throw an error with the Box error `message` only (never echo the secret); redact via the shared `redactSecrets` before surfacing.

### 2. Connector `extension/connectors/box.mjs` (Pattern A)
- `indexBoxFolder(userId, { clientId, clientSecret, subjectType, subjectId, folderId })` → `{ indexed, skipped }`.
  - Token via `exchangeCCGToken`.
  - `listFolderRecursive(token, folderId)` — paginated `GET /2.0/folders/{id}/items?fields=id,name,type,modified_at&limit=1000&offset=…`; recurse into subfolders up to `MAX_DEPTH` and a global `MAX_FILES` cap (log when capped, mirroring git's fence caps).
  - `fetchExtractedText(token, fileId)` — request the `[extracted_text]` representation (`GET /2.0/files/{id}?fields=representations`, then fetch the representation content URL, honoring the `x-rep-hints` header and a pending→retry poll with a bounded number of attempts). Returns `null` when no text representation exists (→ skip + log).
  - Chunk via the existing `chunkLines` (reuse from git.mjs — extract to a shared util if not already exported) into rows `{kind:'doc', ref:'box:<fileId>', chunkIdx, title:<fileName>, body:<chunk>, meta:{ path, fileId, folderId, modifiedAt }}`.
  - `deleteSourcesByPrefix(userId, 'doc', 'box:<folderId>')` then `ingestSources(userId, items)` (delete-then-insert, tenant-scoped, `MAX_INGEST_BATCH` already enforced).
- **Testability:** pure helpers — `buildTokenForm(...)`, `parseFolderItems(json)`, `chunkLines(...)`, `toSourceRows(files)` — are unit-tested directly. Network is behind an injectable `httpJson`/`httpText` (default real `fetch`), mocked in tests (mirrors `slack-source.mjs` tests).

### 3. Routes (`extension/kb/router.mjs`)
- `POST /kb/box/test` — body `{clientId, subjectType, subjectId, folderId}`; reads `box.clientSecret` from the vault; exchanges token + lists one page → `{ folderName, itemCount }`. Validation errors → 400.
- `POST /kb/connect-box` — same inputs; runs `indexBoxFolder` → `{ indexed, skipped }`.
- Both `requireUser`-scoped (the top-level `/kb/*` gate already enforces this). Add to `server.mjs` ENDPOINTS array and `docs/reference/api/openapi.yaml` (or `make docs-check` api-coverage fails).
- Vault: add `box.clientSecret` to `ALLOWED_KEYS` in `server/vault.mjs`.

### 4. Storage
No schema change. Rows go to the existing `sources` table (`kind='doc'`, added in migration `0005`), FTS-mirrored into `search` by the existing triggers, `user_id`-scoped. Secret in `user_secrets` (encrypted). Config in Mac UserDefaults.

### 5. Mac (`mac/Sources/LlmIdeMac/`)
- **Model** — `SavedBoxSource` in `Models/Config.swift` (mirror `SavedSlackSource`): `id, displayName, clientId, subjectType, subjectId, folderId, folderName?, enabled`. `@Published var boxSource: SavedBoxSource?` with UserDefaults persistence + `init` load (via `decodeConfigOrStash`). `clientSecret` is NOT in this struct.
- **API client** — `Services/API/LlmIdeAPIClient+Box.swift`: reuse `setSecret("box.clientSecret", …)`, `testBox(...)` → `/kb/box/test`, `connectBox(...)` → `/kb/connect-box`.
- **UI** — `Views/Sources/BoxSourceSheet.swift` (mirror `SlackSourceSheet.swift`): fields for clientId, clientSecret, subjectType picker, subjectId, folderId; "Save & verify" → `setSecret` + `testBox` + save `SavedBoxSource`. Promote the `documents` card in the Sources view / `InputSourceRegistry` to a live Box card with a "Re-sync" button calling `connectBox`.

## Error handling
- Bad/expired creds → the token exchange throws; `/kb/box/test` + `/kb/connect-box` return the redacted Box error message (400/502 as appropriate). The `clientSecret` is never echoed (shared `redactSecrets`).
- A file with no `extracted_text` representation, or a per-file fetch error → skipped, counted in `skipped`, logged (structured); the run continues (one bad file never aborts the index).
- Folder-list pagination / file cap reached → logged; partial index is still committed (wholesale delete happens before insert, so a failed run mid-way could leave the folder's rows deleted — see Risks).

## Testing
- Connector pure helpers: `buildTokenForm`, `parseFolderItems` (files vs subfolders, pagination), `toSourceRows` (ref/chunkIdx/meta shape), `chunkLines`.
- `indexBoxFolder` against a mock HTTP layer: happy path (N files → M chunk rows via a spy `ingestSources`), a no-text-representation file (skipped), a per-file fetch error (skipped, run continues), the file cap.
- Routes: `/kb/box/test` + `/kb/connect-box` — missing-field 400, missing vault secret 400, success shape. Follow existing `router` route-test patterns.
- Mac: `SavedBoxSource` UserDefaults round-trip + tolerant decode.

## Risks / follow-ups
- **Wholesale re-index deletes before insert:** a run that fails after the delete leaves the folder's `doc` rows gone until the next successful sync. Acceptable for v1 (matches git's model); a future improvement is delete-after-successful-fetch or incremental `box_state`.
- **Re-fetching all file texts each sync** is O(folder size) in Box API calls — fine for modest folders; incremental sync is the future optimization.
- CCG token is fetched per run (~60 min lifetime, ample for one index). No token caching across runs in v1.

## Out of scope
- Writing back to Box; per-file incremental sync (`box_state`); user OAuth redirect flow; non-Box document providers; the Box MCP tools (those are for development inspection, not a runtime dependency — the connector calls Box's REST API directly).
