# Claude Plugin Bridge — Design Spec

**Date:** 2026-05-27
**Status:** Approved
**Author:** Dinesh Malla + Claude

## Summary

Bridge Claude Code's plugin ecosystem into LLM IDE so users can:

1. **Discover** plugins from Claude Code marketplaces (anthropics/claude-plugins-official, obra/superpowers)
2. **Auto-detect** Claude Code plugins already installed locally (`~/.claude/plugins/cache/`)
3. **Import** Claude plugins into LLM IDE' native plugin system with full validation
4. **Toggle** each imported plugin between active (agent uses skills at runtime) and passive (reference only)

## Approach: Adapter Layer

A thin adapter module reads Claude Code's plugin format and converts it into LLM IDE' format. Imported plugins go through the existing validation pipeline (injection scanning, size limits) and appear alongside native plugins in the unified PLUGINS section.

No changes to the core plugin loader or agent runtime — the adapter produces standard LLM IDE plugins.

## Architecture

```
LLM IDE App
├── Library UI
│   └── PLUGINS section (unified: native + claude-origin)
├── Plugin Loader (existing, unchanged)
│   └── reads ~/Library/Application Support/LLM IDE/plugins/
├── Agent Runtime (existing, unchanged)
│   └── merges enabled plugin skills into system prompt
│
└── Claude Plugin Adapter (NEW)
    ├── claude-adapter.mjs     — scan, convert, import
    ├── API routes              — REST endpoints for Mac app
    └── reads from:
        ├── ~/.claude/plugins/cache/           (installed)
        ├── ~/.claude/plugins/marketplaces/    (catalog)
        ├── ~/.claude/plugins/installed_plugins.json
        └── GitHub API (fallback when local cache missing)
```

## Module: `claude-adapter.mjs`

### `scanInstalled() → ClaudePlugin[]`

Reads `~/.claude/plugins/installed_plugins.json` and scans `cache/` directories.

Returns for each plugin:
- `name` — e.g. "superpowers"
- `version` — from package.json or inferred
- `marketplace` — which marketplace it came from (e.g. "superpowers-dev")
- `skillCount` — number of .md files in skills/
- `commandCount` — number of .md files in commands/
- `alreadyImported` — boolean, true if `claude-<name>` exists in LLM IDE plugins dir

### `scanMarketplace() → MarketplacePlugin[]`

Reads `~/.claude/plugins/marketplaces/*/plugins/` directories.

**Fallback:** If `~/.claude/plugins/marketplaces/` is missing or empty, fetch the directory listing from `https://api.github.com/repos/anthropics/claude-plugins-official/contents/plugins` (unauthenticated, public repo). Cache the response for 24 hours in LLM IDE' data dir.

Returns for each plugin:
- `name` — directory name
- `description` — from README.md first line if present
- `hasSkills` — boolean
- `hasCommands` — boolean
- `installedInClaude` — boolean (cross-referenced with installed_plugins.json)

### `importPlugin(source, pluginName) → PluginInfo`

The core conversion pipeline:

1. **Locate source:** Find plugin directory in `cache/` (for installed) or `marketplaces/` (for catalog)
2. **Read manifest:** Parse `package.json` if present; infer from directory name if absent
3. **Generate LLM IDE manifest:**
   ```json
   {
     "name": "claude-code-review",
     "version": "1.0.0",
     "displayName": "Code Review",
     "description": "Imported from Claude Code marketplace",
     "author": "anthropics",
     "origin": "claude",
     "sourcePlugin": "code-review",
     "sourceMarketplace": "claude-plugins-official"
   }
   ```
4. **Copy skills:** Each `skills/<name>/SKILL.md` → `skills/<name>.md` with:
   - Size check (max 32KB)
   - Injection fence stripping
   - Suspicious content scanning (warnings, not blocking)
5. **Copy commands:** Each `commands/<name>.md` → `commands/<name>.md` with:
   - Size check (max 16KB)
   - Same sanitization
6. **Write to LLM IDE plugin dir:** `~/Library/Application Support/LLM IDE/plugins/claude-<name>/`
7. **Return** validated PluginInfo for the API response

### `checkForUpdates() → UpdateInfo[]`

Compares imported `claude-*` plugins' `sourcePlugin` + `version` against the current state of the Claude cache/marketplace dirs. Returns a list of plugins with available updates.

## API Routes

All routes require authentication (existing JWT middleware).

| Method | Route | Body | Response |
|--------|-------|------|----------|
| `GET` | `/claude-plugins/installed` | — | `{ plugins: ClaudePlugin[] }` |
| `GET` | `/claude-plugins/marketplace` | — | `{ plugins: MarketplacePlugin[], cachedAt: string }` |
| `POST` | `/claude-plugins/import` | `{ source: "installed" \| "marketplace", name: string }` | `{ plugin: PluginInfo }` |
| `POST` | `/claude-plugins/refresh` | — | `{ installed: number, marketplace: number }` |

## Mac UI

### Plugin install menu addition

The `+` button in the PLUGINS section header gets a third group:

```
Install from .zip…
Install from Git URL…
─────────────────────
Import from Claude Code…    ← opens sheet
─────────────────────
Reveal plugin folder
Reload from disk
```

### Claude Import Sheet (`ClaudePluginImportSheet.swift`)

A sheet with two tabs presented from the PLUGINS header menu:

**Tab 1 — "Installed in Claude Code"**
- Lists plugins from `GET /claude-plugins/installed`
- Each row: icon, name, version, skill/command counts
- Button per row: "Import" / checkmark (already imported) / "Update" (newer version available)
- Empty state: "No Claude Code plugins found. Install Claude Code to access its plugin ecosystem."

**Tab 2 — "Marketplace"**
- Lists plugins from `GET /claude-plugins/marketplace`
- Each row: name, description, badges for skills/commands
- Button: "Import" (copies from marketplace dir into LLM IDE)
- If not installed in Claude Code: button still works (reads directly from marketplace cache)

### Library PLUGINS section changes

Plugin rows with `origin: "claude"` get a small badge:

```
  [puzzlepiece] code-review  v1.0.0     [Claude]  [toggle]
  [puzzlepiece] my-plugin    v2.1.0               [toggle]
```

The badge is a small capsule (same style as the ADMIN badge on accounts) using the Claude orange color.

### Plugin detail view

For Claude-origin plugins, the detail view adds:
- "Source: Claude Code • code-review v1.0.0" metadata row
- "Update available: v1.1.0" banner when source is newer (with "Update" button)
- "Source no longer available" note when the original Claude plugin was removed

### Active vs. Passive toggle

The existing enable/disable toggle works unchanged. When a Claude plugin is:
- **Enabled (active):** Its skills are merged into the agent system prompt at runtime
- **Disabled (passive):** Skills appear in Library for reading but don't affect the agent

## Security

- All imported content goes through existing `stripInjectionFences()` and `scanForSuspiciousContent()`
- Size limits enforced: 32KB/skill, 16KB/command, 50 files/plugin
- `claude-` prefix prevents shadowing native LLM IDE plugins
- GitHub fallback uses unauthenticated API (public repos), rate-limited to 60 req/hr
- No server-side URL fetching for plugin content — only GitHub API for directory listings

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Claude Code not installed | `~/.claude/plugins/` missing → empty lists, hint in UI |
| Plugin already imported | Show checkmark; show "Update" if source version is newer |
| Plugin removed from Claude | LLM IDE keeps its copy; detail view shows "Source no longer available" |
| No package.json in source | Infer name from directory name, version defaults to "0.0.0" |
| Skill name collision | Namespaced by plugin name: `claude-code-review/debug` vs `my-plugin/debug` |
| GitHub API rate limit hit | Return cached data with "cache may be stale" warning |
| Marketplace cache stale (>24h) | Attempt GitHub refresh; use stale cache if refresh fails |

## Out of Scope (v1)

- Publishing LLM IDE plugins to Claude marketplace
- Two-way sync (LLM IDE edits don't propagate to Claude dirs)
- Installing Claude Code from LLM IDE
- Marketplace search/filter (flat list only)
- Importing Claude Code hooks or agents (skills and commands only)

## File Inventory

| File | Type | Purpose |
|------|------|---------|
| `extension/plugins/claude-adapter.mjs` | New | Adapter: scan, convert, import |
| `extension/plugins/claude-adapter.test.mjs` | New | Tests for adapter |
| API route file (existing routes file) | Modified | Add 4 `/claude-plugins/*` endpoints |
| `mac/.../ClaudePluginImportSheet.swift` | New | Import sheet UI (two tabs) |
| `mac/.../PluginsSettingsSection.swift` | Modified | Add "Import from Claude Code" menu item |
| `mac/.../LibraryView.swift` | Modified | Add Claude badge to plugin rows |
| `mac/.../PluginDetailView.swift` | Modified | Add source/update info for Claude plugins |
| `mac/.../PluginLibraryRow.swift` | Modified | Add Claude badge rendering |
| `mac/.../LlmIdeAPIClient.swift` | Modified | Add Claude plugin API methods |
