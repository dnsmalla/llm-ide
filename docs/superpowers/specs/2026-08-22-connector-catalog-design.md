# Connector Catalog — Design

**Date:** 2026-08-22
**Status:** Approved design, pending implementation plan
**Approach:** Server-side catalog + per-user selection state; new connectors ride the existing Source Connector engine
**Catalog set:** Google Drive, Google Calendar, Miro (new builds) + Box, Slack (existing, surfaced)

## Context

LLM-IDE has two connector worlds. **Pattern A** connectors (Box, git, issues, QA,
SCIP) index content into the SQLite `sources` table server-side. **Pattern B**
(Mac-driven fetch sources) fetch raw data through server transport endpoints,
write files to a source folder, run LLM classification, and save notes under
`llm-doc/` — Email is the hand-built reference. A purpose-built, tested
**Source Connector engine** (`mac/Sources/LlmIdeMac/SourceConnectors/`:
manifest-driven fetch → inbox → pipeline → note writer) has existed since
2026-07-31 and ships with **zero manifests**.

There is no connector catalog or registry: the Settings → Connections section
hardcodes Meeting/Email/Slack/Box cards, and Library has no connector surface.
The user wants an MCP-like experience: browse a catalog in the Library, select
connectors, and see only the selected ones in Settings — with the fetch →
folder → LLM → llm-doc structure for the new ones, exactly like Email.

## Hard constraints (user-mandated)

1. **Meeting and Email are defaults and are not changed.** Their cards,
   pipelines, config, and state remain exactly as today. They are not catalog
   entries and cannot be removed.
2. **Existing behavior for Box and Slack is unchanged** — only their
   *visibility* becomes selection-driven. On first boot after upgrade both are
   pre-selected, so current users see no difference until they choose.
3. **Removing a connector never deletes data** — fetched raw files and
   llm-doc notes stay on disk; removal only hides the card and stops fetching.
4. Folder/notes structure is **flexible per selection**: selecting a connector
   scaffolds its folders; nothing is created for unselected connectors.

## Architecture

### 1 · Catalog + selection state (server)

- `extension/connectors/connector-catalog.mjs` — frozen `CONNECTOR_CATALOG`
  array, mirror of `extension/mcp/catalog.mjs`. Entry shape:
  `{ id, name, description, icon, authKind: 'google-oauth'|'slack-oauth'|'box-ccg'|'miro-oauth', docsUrl }`.
  Initial entries: `gdrive`, `gcal`, `miro`, `box`, `slack`.
- Per-user selection state in `extension/connectors/connector-state.mjs`
  (mirror of `plugins/state.mjs`): `connector-state.json` beside the plugin
  dir, `{ [userId]: { selected: string[] } }`, atomic writes, orphan pruning.
  First-run migration pre-selects `box` and `slack`.
- Routes under `/auth/me/connectors` (exact MCP route pattern; added to the
  auth-routes allow-list): `GET /` (selected + linked state), `GET /catalog`
  (catalog + computed `selected` flag), `POST /add` `{ id }`, `DELETE /<id>`.
  Actions audited like `plugin.*` / `mcp-plugin.*`.

### 2 · Library section (Mac)

A **Connectors** section in the Library sidebar, following the MCP Plugins
pattern (state vars + `.task`, `unifiedSectionHeader`, "+" menu, sheet, row
view, `ShellState.LibrarySelection.connector(id)` case, detail view):

- Rows: selected connectors — icon, name, linked badge (vault-aware via the
  existing `SourceLinkStore` mechanism).
- "+" menu → **"Add from catalog…"** sheet listing the 5 entries with
  description + auth kind; already-selected entries disabled.
- Context menu → Remove (with copy noting data is kept).
- Section id added to the collapsed-sections default seed.

### 3 · Settings section (Mac)

`ConnectionsSettingsSection` renders, in order:

1. **Meeting card and Email card exactly as today** (hardcoded, untouched).
2. **One card per selected connector:**
   - `box` → the existing Box card + `BoxSourceSheet` (Re-sync, Pattern A),
     now conditional on selection.
   - `slack` → the existing Slack card + `SlackSourceSheet` (hosted OAuth /
     bot token, Fetch now), conditional on selection.
   - `gdrive` / `gcal` / `miro` → a **generic manifest-driven card**: title,
     icon, Configure… sheet generated from the manifest's `configFields`
     (label, kind, secret?), Fetch now, last-result line. One form pattern
     serves every future connector — no per-connector Settings UI.

### 4 · Pipelines for the new three (existing Source Connector engine)

The engine ships at last, unmodified in behavior:

- Manifest JSON per connector in
  `mac/Sources/LlmIdeMac/Resources/source_connectors/` (`gdrive.json`,
  `gcal.json`, `miro.json`): `inboxFolder`, `noteType` (= catalog id),
  `endpoints { fetch, seen, classify }`, `configFields`, `rawHeaders`.
- Adapter per connector (`SourceConnectorAdapter` protocol) calling the new
  server endpoints.
- Flow per connector, identical to Email's shape: fetch → raw files in
  **`source/<id>/`** (via `InboxStore`) → SHA-256 dedup →
  `InboxGenerationPipeline` → `POST /kb/<id>/classify` → note in
  **`llm-doc/<id>/YYYY/MM/`** via `SourceConnectorNoteWriter` (the note index
  auto-discovers new type folders).
- `SourceConnector.ensureSetup` scaffolds `source/<id>/` + `llm-doc/<id>/`
  when the connector is selected — constraint 4.
- Scheduling: selected connectors join `SourceRegistry.fetchSources` (the
  Auto Tasks "Source Update" sweep) alongside Email — additive; Email's
  behavior unchanged.

### 5 · Server transports + auth

- `/kb/gdrive/fetch`, `/kb/gcal/fetch`, `/kb/miro/fetch` + `/<id>/seen` +
  `/<id>/classify` endpoint groups in `routes/router.mjs`, modeled on the
  email block (`/kb/email/*`), including its SSRF guards for any user-supplied
  host. Google endpoints reuse `connectors/google-oauth.mjs` with the vault
  namespace extended to `google.connector.*` (bring-your-own client, same as
  Gmail); Miro gets a hosted OAuth helper mirroring `slack-oauth.mjs`
  (`miro.*` vault keys). Vault `ALLOWED_KEYS` gains the new namespaces.
- Miro scope note (honest limitation): the API exposes boards as structured
  items (text, sticky notes, shapes). Notes capture text content; images and
  board graphics are not meaningfully LLM-processable and are referenced, not
  analyzed.

## Phasing

1. **Catalog + Library + Settings wiring** — catalog module, state, routes,
   Library section, Settings selection-driven rendering (box/slack
   pre-selected). The catalog marks `gdrive`/`gcal`/`miro` with
   `pipelineReady: false` in this phase: they can be selected and appear in
   the Library and Settings, but their card renders a simple
   "pipeline lands in the next phase" placeholder (no manifest exists yet),
   and no fetching is attempted. Phases 2–3 flip the flag and deliver the
   real transports, manifests, and generic cards.
2. **Google pair** — gdrive + gcal transports, manifests, adapters, generic
   card wiring, classify agents.
3. **Miro** — OAuth helper, transport, manifest, adapter.

Each phase lands with the full extension + mac suites green and the
Regression Loop stage green.

## Non-goals

- No change to Meeting/Email pipelines or cards.
- No change to Box's Pattern-A indexing (it never produces llm-doc notes;
  that stays).
- No migration of Email/Slack onto the Source Connector engine (Slack's
    existing fetch flow stays as-is; only visibility changes).
- No generic "any OAuth provider" framework — three concrete integrations.
- No deletion of fetched data or notes on connector removal.

## Risks

- Google bring-your-own-client friction (same as Gmail's reality — documented
  in-app, not new).
- Miro API rate limits / content shape — mitigated by text-only extraction
  and the engine's noise filter.
- Two card systems (bespoke box/slack + generic new) in Settings — accepted
  to honor constraint 2; a later cleanup can unify behind manifests.
