# Extensions: one screen, visible health, one-click repair — plan

Date: 2026-11-19 · Status: done (2026-11-20) · Owner decisions: see "Decisions"

## Goal

Skills, plugins, MCP servers and skill kits are managed in one place, with the same actions and words for every kind.
Each item shows whether it actually works, and a problem comes with the fix for it.

## Decisions (user, 2026-11-19)

1. **One Extensions screen.** Four kinds: Skills, Plugins, MCP servers, Skill kits. The older panes (Plugins, LLM
   Sources, MCP Plugins) are folded in; nothing installed is lost. Connectors stay separate (they bring data into notes).
2. **Repair = health check + one-click fixes.** A check that really tests an item, and the matching fix. No model call,
   works in release builds. Failures are also recorded as Self-Heal incidents where Self-Heal is on.
3. **No per-project switches for now.** One global set per user.

## Vocabulary (one word per thing, everywhere a user reads)

| Thing | Word | Replaces |
|---|---|---|
| Anything a user adds | Extension | add-on, plugin (as umbrella) |
| Model Context Protocol server | MCP server | MCP Plugin, Extension tool |
| A folder of skills/commands/agents from a repo | Skill kit | LLM Source, Skill bundle |
| A packaged plugin | Plugin | — |
| One skill | Skill | — |
| On / off | Switch on, Switch off; state "On" / "Off" | Enabled/Disabled, Enable/Disable |
| Delete | Remove | Remove server, Remove source, Uninstall |

No environment variable names, file names, git commands or tool-id patterns in user-facing text.

## State at the start (reviewed 2026-11-19)

- Solid: the catalog (installs off, pinned commit with ancestry check, scan, per-kind consent, update preview, roll back,
  Repair), per-item switches, the "in chats now" summary.
- Dead ends: a legacy plugin cannot be removed or updated from any screen (routes exist); `/mcp`, `/plugin`, `/agents`,
  `/hooks` open the Library root; new-project skills install says "open it again to retry" but reopening does not retry.
- Health: no test, live status or error text for a chat MCP server; plugin load warnings reach only the console.
- Self-Heal records no extension failure, and its fix loop edits LLM-IDE's own source only (debug builds).
- Safety: the Git plugin install hands the core's whole environment to `git`. User-added MCP servers are pre-approved by
  design (only catalog servers ask per call); the UI does not say so.

## Phases (each ships on its own, tests first, gates green)

### Phase 1 — dead ends and safety (done: 8f28dc21c, c10176207, 39179a266)
- Git plugin clone runs with the scrubbed child environment, like skill-kit clones.
- Remove and Update for legacy plugins in the UI (`DELETE /auth/me/plugins/uninstall/:name`, `…/claude-plugins/update`).
- `/mcp`, `/plugin`, `/agents`, `/hooks` open the matching pane.
- New-project skills: a real Retry (re-run `/kb/project/install-skills`), and wording that matches what happens.
- The MCP detail states when a server runs without asking per call.

### Phase 2 — health check and fixes (core) (done: a2d9d0a51)
- `POST /auth/me/extensions/check { kind, id }` → `{ status: ok|problem|unknown, problems: [{ code, message, fix }] }`.
  Checks, none with a model: MCP server starts and lists its tools (bounded time, stdio and remote); the program a
  stdio server needs exists; a credential is present; a catalog item's files match its pinned tree hash and its
  consents cover the commit; a plugin loads without warnings and its hook commands exist; a skill kit parses.
- Each problem names one fix the UI can run: `repair` (re-fetch), `consent`, `sign-in`, `set-credential`,
  `install-program` (shows the command, never runs it), `switch-off`.
- Results are cached briefly per item; a failing MCP server in a chat turn updates the same record.
- A problem is recorded as a Self-Heal incident (source `server`, category `extension`) where Self-Heal is on.

### Phase 3 — health in the UI (done: 4428bdb20)
- A status on every row (Working / Problem / Not checked), a Check button, the problem text and its fix button.
- A "Problems" filter and a count on the Library entry. The chat notice for a failed MCP server links to the item.

### Phase 4 — one Extensions screen (done: 4b464951b)
- The Installed tab lists all four kinds from both stores with the same row, detail, switch, update and remove.
- Add: one dialog (catalog, GitHub address, or for an MCP server a command or URL), replacing the per-pane dialogs.
- The three older Library entries are removed; their routes stay (the screen calls them).
- All text follows the vocabulary table.

### Phase 5 — loose ends (done: c1a8017cf, 7f19c13b1; the MCP tool list already shipped in Phase 3)
- Loop skill stage: a picker instead of a free-text field.
- An MCP server's tool list in its detail (from the health check).
- Connector catalog flags that no longer match their pipelines.

## Not in scope
- Per-project switches; an AI diagnosis step; changing which catalog items reach Claude turns (`LLMIDE_EXT_ACTIVE_SET`,
  an earlier bench-gated decision).

## Risks
- A health probe starts a user's MCP server: bounded time, same environment rules as a chat turn, never on a hub for
  stdio, and only when the user asked for the check or the item is already on.
- Folding the panes: every action a legacy pane offers must exist in the new screen before the entry is removed.
