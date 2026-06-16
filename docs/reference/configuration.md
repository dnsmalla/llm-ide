---
title: Configuration reference
applies_to: server, mac, extension
---

# Configuration reference

Every configurable setting in LLM IDE, mapped to the store that owns
it. If you're adding a new setting, use the [decision tree](#where-does-this-go)
at the bottom to pick where it lives.

## UI preferences (macOS)

Owned by `AppConfig` (`mac/Sources/LlmIdeMac/Models/Config.swift`) and
written through `UserDefaults`. `@Published` for SwiftUI binding.

| Setting | Store | Default | Notes |
|---|---|---|---|
| `serverURL` | UserDefaults | `http://127.0.0.1:3456` | Loopback-only (`isSafeServerURL` rejects non-localhost). |
| `themeID` | UserDefaults | `Theme.dark.id` | One of the registered themes in `Theme.swift`. |
| `autoCaptureOnMeeting` | UserDefaults | `false` | Auto-arm when Zoom/Teams becomes frontmost. |
| `pollIntervalMs` | UserDefaults | `250` | AX caption poll cadence in ms. |
| `LLMIDE_CURRENT_CHAT_SESSION_ID` | `@AppStorage` | `""` | Last-opened Code Assistant chat. `CodeAssistantPanel.swift`. |
| `LLMIDE_CHAT_PANEL_WIDTH` | `@AppStorage` | `200` | Persisted splitter width. `ReviewView.swift`. |
| `LLMIDE_LEGACY_PROMPT_SUPPRESSED` | `@AppStorage` | `false` | Whether the legacy-data prompt was dismissed. `AppShell.swift`. |

## GitLab integration (macOS)

| Setting | Store | Default | Notes |
|---|---|---|---|
| `gitLabBaseURL` | UserDefaults | `https://gitlab.com` | Switching the host re-keys the Keychain entry. |
| `gitLabToken` | **Keychain** (`gitlab::<host>::token`) | empty | PAT with `api` scope. |
| `gitLabLastProjectId` | UserDefaults | `""` | Last-opened project numeric id. |
| `gitLabSavedProjects` | UserDefaults (JSON-encoded `[SavedGitLabProject]`) | `[]` | Per-project clones; corrupt blobs are stashed not erased. |

## Auth / secrets (macOS)

Owned by `KeychainStore.swift`. Service identifier: `com.llmide.macapp`.

| Setting | Store | Default | Notes |
|---|---|---|---|
| JWT refresh token | Keychain `<host>::refresh_token` | n/a | Set by `SessionStore` after login. Wiped on logout. |
| GitLab PAT | Keychain `gitlab::<host>::token` | n/a | See above. |

All entries use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
`KeychainStore.logout()` nukes every item with our service id.

## Auto Code Update (macOS)

`AppConfig` again; all UserDefaults.

| Setting | Store | Default | Notes |
|---|---|---|---|
| `autoCodeUpdateEnabled` | UserDefaults | `false` | Master switch for the auto pipeline. |
| `autoCodeUpdateLookbackCount` | UserDefaults | `5` | Number of recent notes to scan. |
| `autoCodeRunReviewCode` | UserDefaults | `true` | Include review-code tasks. |
| `autoCodeRunReviewDoc` | UserDefaults | `true` | Include review-doc tasks. |
| `autoCodeRunReviewConflicts` | UserDefaults | `false` | Include resolve-conflicts tasks. |
| `autoTaskTemplateReviewCode` | UserDefaults | see `defaultTemplateReviewCode` | Prompt template. |
| `autoTaskTemplateReviewDoc` | UserDefaults | see `defaultTemplateReviewDoc` | Prompt template. |
| `autoTaskTemplateReviewConflicts` | UserDefaults | see `defaultTemplateReviewConflicts` | Prompt template. |
| `activeCLI` | UserDefaults | `claudeCode` | Raw value of `AICliTool`. |
| `defaultModelId` | UserDefaults | per-CLI default | Model id for the active CLI. |

## Backend supervisor (macOS)

| Setting | Store | Default | Notes |
|---|---|---|---|
| `backendNodePath` | UserDefaults | empty | Absolute path to `node`; user picks or auto-detects. |
| `backendWorkingDir` | UserDefaults | empty | Directory containing `server.mjs`. |
| `backendAutoStart` | UserDefaults | `false` | Launch backend at app start. |

## Server (`extension/server/config.mjs`)

Every value is sourced from `process.env`. Defaults are dev-safe; the
two starred entries are required in production.

| Env var | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` requires the two secrets below. |
| `LLMIDE_JWT_SECRET` *required in prod* | dev-persisted in `kb/.dev-secrets.json` | ≥ 32 chars. Rotating invalidates all sessions. |
| `LLMIDE_VAULT_KEY` *required in prod* | dev-persisted in `kb/.dev-secrets.json` | ≥ 32 chars. Rotating strands stored vault secrets. |
| `LLMIDE_HOST` | `127.0.0.1` | Loopback by default. |
| `LLMIDE_PORT` | `3456` | |
| `LLMIDE_BODY_LIMIT_MB` | `2` | Per-request body cap. |
| `LLMIDE_TRUST_PROXY` | `false` | Enable only behind a trusted reverse proxy. |
| `LLMIDE_DB_PATH` | `<repo>/kb/data.db` | SQLite path. |
| `LLMIDE_JWT_ISSUER` | `llmide` | `iss` claim. |
| `LLMIDE_ACCESS_TTL_SEC` | `900` (15 m) | |
| `LLMIDE_REFRESH_TTL_SEC` | `2592000` (30 d) | |
| `LLMIDE_BCRYPT_COST` | `12` | Clamped to 10–14. |
| `LLMIDE_LOG_LEVEL` | `info` (prod) / `debug` (dev) | `trace`–`error`. |
| `LLMIDE_LOG_JSON` | `true` (prod) / `false` (dev) | Force JSON log output. |
| `LLMIDE_DISABLE_REGISTRATION` | `false` | Close `/auth/register` after bootstrap. |
| `LLMIDE_CORS_ORIGINS` | `""` | Extra comma-separated allowed origins. |
| `LLMIDE_MODEL` | `claude-sonnet-4-6` | Default Claude model id. |
| `LLMIDE_SUMMARIZE_MODEL` | `claude-opus-4-8` | Override for meeting summaries. |
| `BIND_HOST` | `127.0.0.1` | Used by `start.sh` only; container deployments set `0.0.0.0`. |

## Agent skills

Each markdown skill under `extension/agents/` and the meeting-agent
prompts under `extension/llm_agent/` carries a YAML frontmatter block.
The agent dispatcher reads it; nothing about a skill is configured in
JS code.

| Key | Notes |
|---|---|
| `name` | Slug, used in `/agents/<name>` paths. |
| `description` | One-line trigger description; surfaced to the planner. |
| `tools` | Tools the skill is allowed to call. |
| `applies_to` | Surfaces that may dispatch this skill. |

## Build (macOS)

| Setting | Store | Default | Notes |
|---|---|---|---|
| `LLMIDE_SIGN_IDENTITY` | shell env | `-` (ad-hoc) | Passed to `codesign -s`. Use a Developer ID for distribution. |
| `LLMIDE_NOTARY_PROFILE` | shell env | unset | Keychain profile name for `xcrun notarytool`. Notarize step skips if unset. |

See `mac/Scripts/` for the per-phase build scripts.

## Where does this go?

```text
new setting
├── User-tweakable + non-secret + macOS UI
│       → AppConfig (@Published + UserDefaults)
│         …unless the value is purely view-local: @AppStorage("LLMIDE_*")
│
├── Secret (token, password, API key)
│       → KeychainStore (Mac) / per-user vault (server)
│
├── Server-side, deploy-time
│       → envStr/envInt/envBool in extension/server/config.mjs
│         + a line in extension/.env.example
│
└── Agent behavior (prompt, allowed tools, dispatch rules)
        → skill markdown frontmatter under extension/agents/
```

A setting that doesn't fit any branch is usually a mistake — either it
belongs in code (a constant, not config) or it crosses surfaces and
needs its own ADR.
