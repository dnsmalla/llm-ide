---
title: Persistence reference
applies_to: server, mac, extension
---

# Persistence reference

Every persistent store in LLM IDE, with location, schema shape,
version mechanism, and migration policy.

If you are renaming or removing a Codable property, jump to the
[schema-change checklist](#schema-change-checklist) before you touch
any code.

## SQLite KB (server)

| | |
|---|---|
| Location | `LLMIDE_DB_PATH` (default `<repo>/kb/data.db`) |
| Engine | SQLite, WAL mode, FTS5, foreign keys on |
| Schema version | Tracked in the `schema_migrations` table |
| Migrations | `extension/kb/migrations/NNNN_*.sql`, applied at server start by `extension/kb/db.mjs` |
| Policy | **Append-only.** Adding tables / columns is fine; renaming or dropping columns requires a numbered migration and a deprecation window. See ADR-0008. |

Tables: see `docs/explanation/architecture.md` § Storage.

## ChatSessionStore (macOS)

| | |
|---|---|
| Location | `~/Library/Application Support/LLM IDE/sessions/<uuid>.json` |
| Root type | `ChatSession` struct (one file per session) |
| Version field | `storeVersion: Int` on `ChatSession` (default `1`; absent on legacy files, defaulted in `init(from:)`) |
| Corrupt files | Renamed `<uuid>.corrupt-<ts>.json` and skipped |
| Migration policy | New fields must be optional or have a default; legacy decode must keep working in-place. |

## LibraryItemStore (macOS)

| | |
|---|---|
| Location | `~/Library/Application Support/LLM IDE/library_items.json` |
| Root type | `LibraryItemStore.StoreFile { storeVersion: Int, items: [LibraryItem] }` |
| Version field | `storeVersion: Int = 1` on the envelope |
| Legacy decode | If the envelope decode fails, the bare `[LibraryItem]` shape is attempted (files written before the envelope existed) |
| Corrupt files | Renamed `library_items.json.corrupt-<ts>` |
| Migration policy | Bump `storeVersion` when the on-disk layout changes; `load()` is the migration entry point. |

## DocTemplateStore (macOS)

| | |
|---|---|
| Location | `~/Library/Application Support/com.llmide.macapp/doc-templates.json` |
| Root type | `DocTemplateStore.StoreFile { storeVersion: Int, templates: [DocTemplate] }` |
| Version field | `storeVersion: Int = 1` |
| Legacy decode | Falls back to bare `[DocTemplate]` for pre-envelope files |
| Migration policy | Same as LibraryItemStore. |

## ProcessedActionsRegistry (macOS)

| | |
|---|---|
| Location | `~/Library/Application Support/LLM IDE/processed_actions.json` (passed in by `AutoCodeUpdateService`) |
| Root type | `ProcessedActionsRegistry.RegistryFile { storeVersion: Int, entries: [String: RegistryEntry] }` |
| Version field | `storeVersion: Int = 1` |
| Legacy decode | Falls back to bare `[String: RegistryEntry]` dict |
| Migration policy | Append-only on `RegistryEntry`; new fields must be optional. |

## SessionStore (macOS)

| | |
|---|---|
| Refresh token | Keychain (`<host>::refresh_token`, see `KeychainStore.swift`) |
| Access token | In-memory only (re-acquired on app launch from refresh token) |
| Logout | `KeychainStore.logout()` nukes every entry under the service id `com.llmide.macapp` |
| Policy | Tokens are opaque server-issued strings; the Mac side has no schema to migrate. |

## `@AppStorage` / UserDefaults (macOS)

Every key currently in use:

| Key | Owner | Purpose |
|---|---|---|
| `serverURL`, `themeID`, `autoCaptureOnMeeting`, `pollIntervalMs`, `activeCLI`, `defaultModelId`, `gitLabBaseURL`, `gitLabLastProjectId`, `gitLabSavedProjects`, `autoCodeUpdateEnabled`, `autoCodeUpdateLookbackCount`, `autoCodeRunReviewCode`, `autoCodeRunReviewDoc`, `autoCodeRunReviewConflicts`, `autoTaskTemplateReviewCode`, `autoTaskTemplateReviewDoc`, `autoTaskTemplateReviewConflicts`, `backendNodePath`, `backendWorkingDir`, `backendAutoStart` | `AppConfig` | See `configuration.md`. |
| `LLMIDE_CURRENT_CHAT_SESSION_ID` | `CodeAssistantPanel` | Last-opened chat. |
| `LLMIDE_CHAT_PANEL_WIDTH` | `ReviewView` | Splitter width. |
| `LLMIDE_LEGACY_PROMPT_SUPPRESSED` | `AppShell` | Dismissed flag. |

No schema version — flat string/int/bool keys. Renaming a key is a
breaking change that resets that value to its default.

## Keychain (macOS + server)

| | |
|---|---|
| Mac service id | `com.llmide.macapp` |
| Mac entries | `<host>::refresh_token`, `gitlab::<host>::token` |
| Server vault | `user_secrets(user_id, key, ciphertext)` table; ciphertext = `version ‖ iv(12) ‖ aes-256-gcm ‖ tag(16)` |
| Server allowed keys | 11 keys: `github.token`, `backlog.apiKey`, `linear.apiKey`, `slack.webhookUrl`, `slack.botToken`, `email.imapPassword`, `claude.apiKey`, `openai.apiKey`, `google.apiKey`, `custom.apiKey`, `custom.baseUrl` (authoritative list in `server/vault.mjs`) |
| Migration policy | The leading byte of every ciphertext is a version tag — bump it (and add a parallel decrypt branch) when rotating crypto. See ADR-0007. |

## Schema-change checklist

Before renaming or removing a Codable property on any persisted
struct, work through this list:

1. **Is the new field optional or default-valued on decode?** Required
   new properties on existing types break every saved file. Use a
   custom `init(from:)` that defaults missing keys (see `ChatSession`).
2. **Did you bump `storeVersion`?** Every envelope above carries one;
   bump it when the on-disk layout changes so future migrations have
   a hook.
3. **Did you preserve a legacy decode path?** New writes use the new
   shape; reads must tolerate the old shape for one release cycle.
4. **Is there a corrupt-file backup?** Every store above renames
   undecodable files aside instead of overwriting them. Match the
   pattern for any new store you add.
5. **Is the rename load-bearing?** SQLite columns can sometimes be
   shadowed by a view to keep the old name working. Renaming a JSON
   key is harder — it's almost always cheaper to add a new field and
   leave the old one alone.
6. **Server-side: did you add a migration under `extension/kb/migrations/`?**
   ADR-0008 (append-only migrations) is the reason for the rule; the
   `schema_migrations` table is the enforcement.
