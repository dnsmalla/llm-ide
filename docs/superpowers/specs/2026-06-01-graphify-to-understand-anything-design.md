# Replace graphify with Understand-Anything

**Date:** 2026-06-01
**Status:** Approved
**Approach:** Adapter-layer migration (Approach A)

## Summary

Replace the graphify CLI and its integration throughout the meet-notes system
with [Understand-Anything](https://github.com/Lum1104/Understand-Anything)
(UA). The migration uses an adapter-layer strategy: the internal `CGData` /
`CGNode` / `CGEdge` types remain the common interface consumed by all SwiftUI
views. Only the producer layer (runner, parser, store, installer) is rewritten
to target UA's JSON schema and npx-based invocation.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Invocation | npx / node CLI from Mac app | UA has no standalone binary; npx is the standard invocation path |
| Memory layer | Keep MemoryGenerator as-is | It reads .md files directly, independent of graph tool. Only output path changes |
| Visualization | Keep SwiftUI canvas | Adapt existing CodeGraphCanvas to render UA's richer node/edge types natively |
| Migration strategy | Adapter layer | Lowest risk; ~70% of changes are renames. Views consume same CGData types |

## Architecture

### Current flow

```
GraphifyRunner (shells graphify CLI)
  -> graphify-out/graph.json
  -> GraphifyParser
  -> CGData
  -> GraphifyStore (disk cache)
  -> SwiftUI views (GraphifyView, CodeGraphCanvas, MemoryTabView)
```

### New flow

```
UARunner (shells npx understand-anything)
  -> .understand-anything/knowledge-graph.json
  -> UAParser
  -> CGData
  -> UAStore (disk cache)
  -> SwiftUI views (UAGraphView, CodeGraphCanvas, MemoryTabView)
```

## File changes

### Rewrites (new logic)

| Old file | New file | Description |
|----------|----------|-------------|
| `GraphifyRunner.swift` | `UARunner.swift` | npx/node invocation, Node.js version check |
| `GraphifyParser.swift` | `UAParser.swift` | Parse UA's versioned JSON schema into CGData |
| `GraphifyInstaller.swift` | `UAInstaller.swift` | npm install -g, plugin marketplace commands |

### Renames (same logic, new names/paths)

| Old file | New file | Description |
|----------|----------|-------------|
| `GraphifyStore.swift` | `UAStore.swift` | Same disk-cache pattern, reads knowledge-graph.json |
| `GraphifyError.swift` | `UAError.swift` | Same error cases + new `.nodeVersionTooOld` |
| `GraphifyHelpers.swift` | `UAHelpers.swift` | Layout helpers, rename only |
| `GraphifyView.swift` | `UAGraphView.swift` | Rename + update UI strings |

### Kept (minor edits)

| File | Change |
|------|--------|
| `CodeGraphModels.swift` | Expand CGNodeKind (21 types) and CGEdgeKind (35 types) |
| `CodeGraphLayout.swift` | No change |
| `MemoryGenerator.swift` | No change (reads .md files directly) |
| `MemoryNotesWriter.swift` | Output path: `graphify-out/memory/` -> `.understand-anything/memory/` |
| `MemoryStore.swift` | Directory reference update |
| `ProcessLauncher.swift` | No change |
| `BugReport.swift` | Rename references |
| `QAEntry.swift` | Rename references |

### Downstream renames (~20 files)

All files that reference `Graphify` / `graphify` by name in variable names,
labels, or strings. These consume `CGData` and need only cosmetic renames:

- `Config.swift` — `graphifyBinaryOverride` -> `uaBinaryOverride`
- `PathValidator.swift` — validate `.understand-anything/` directory
- `Project.swift` — path references
- `MeetNotesMacApp.swift` — initialization
- `AppShell.swift` — navigation
- `SidebarView.swift` — nav label "Graphify" -> "Code Graph"
- `ShellState.swift` — state references
- `AutoCodeUpdateService.swift` — trigger references
- `LibraryItemStore.swift` — file store references
- `ProjectStore.swift` — project settings
- `RegressionRunner.swift` — test runner references
- `Settings/PathsSettingsSection.swift` — settings label and install hint
- `Settings/GitHubSettingsSection.swift` — references
- `Settings/GitLabSettingsSection.swift` — references
- `Views/CodeGraph/MemoryTabView.swift` — path references
- `Views/AutoCode/AutoCodeView.swift` — references
- `Views/CodeAssistant/ReportBugSheet.swift` — references
- `Views/HelpGuideView.swift` — help text
- `Views/Regression/RegressionView.swift` — references

## Model changes

### CGNodeKind expansion

Current code types (4): `file`, `symbol`, `module`, `docPage`

New types added to cover UA's 21 node types:

| UA type | CGNodeKind | Notes |
|---------|-----------|-------|
| `file` | `.file` | Unchanged |
| `function` | `.function` | New (split from `.symbol`) |
| `class` | `.classType` | New (split from `.symbol`) |
| `module` | `.module` | Unchanged |
| `concept` | `.noteConcept` | Reuse existing |
| `config` | `.config` | New |
| `document` | `.docPage` | Map to existing |
| `service` | `.service` | New |
| `table` | `.table` | New |
| `endpoint` | `.endpoint` | New |
| `pipeline` | `.pipeline` | New |
| `schema` | `.schemaNode` | New (avoids Swift keyword) |
| `resource` | `.resource` | New |
| `domain` | `.domain` | New |
| `flow` | `.flow` | New |
| `step` | `.step` | New |
| `article` | `.article` | New |
| `entity` | `.entity` | New |
| `topic` | `.topic` | New |
| `claim` | `.claim` | New |
| `source` | `.noteSource` | Reuse existing |

The `.symbol` kind is retained as a fallback for unmapped types. Existing
memory note kinds (`.memoryDoc`, `.memoryChunk`, `.noteDecision`, etc.) are
unchanged — `MemoryGenerator` still uses them.

### CGEdgeKind expansion

Current (5): `imports`, `calls`, `references`, `defines`, `relatedTo`

New types added, grouped by UA category:

**Structural:** `imports` (existing), `exports`, `contains`, `inherits`, `implements`
**Behavioral:** `calls` (existing), `subscribes`, `publishes`, `middleware`
**Data flow:** `readsFrom`, `writesTo`, `transforms`, `validates`
**Dependencies:** `dependsOn`, `testedBy`, `configures`
**Semantic:** `relatedTo` (existing), `similarTo`
**Infrastructure:** `deploys`, `serves`, `provisions`, `triggers`
**Schema:** `migrates`, `documents`, `routes`, `definesSchema`
**Domain:** `containsFlow`, `flowStep`, `crossDomain`
**Knowledge:** `cites`, `contradicts`, `buildsOn`, `exemplifies`, `categorizedUnder`, `authoredBy`

Existing `.defines` and `.references` become fallbacks for unmapped edge types.

### CGPalette update

`CGPalette.color(for:)` must be extended with colors for every new
`CGNodeKind` case. Group by semantic category:
- Code types (function, classType): purple/indigo shades
- Infrastructure (service, endpoint, pipeline, resource, config): orange/teal
- Data (table, schemaNode): green shades
- Domain (domain, flow, step): red/coral
- Knowledge (article, entity, topic, claim): blue/cyan

### CGNode additions

No new struct fields. UA's additional per-node data is stored in the existing
`metadata: [String: String]` dictionary to avoid breaking the `CGNode.init`
signature. Keys:

Additional UA fields stored in metadata:
- `"complexity"` — `"simple"` | `"moderate"` | `"complex"`
- `"tags"` — comma-separated tag list
- `"weight"` — edge weight (on edges, stored as string)

### CGData additions

Two new optional arrays for future use:

```swift
public let layers: [UALayer]      // defaults to []
public let tour: [UATourStep]     // defaults to []
```

These are parsed and stored but not rendered by the SwiftUI canvas in this
phase. They enable future layer/tour UI without re-parsing.

## UARunner

### Binary resolution order

1. Settings override: `uaBinaryOverride` in AppConfig (absolute path to the binary)
2. `npx understand-anything` via PATH — primary path; spawns a child node process. Requires `npx` and `node` on PATH
3. Direct binary at global npm prefix: e.g. `/usr/local/lib/node_modules/understand-anything/bin/understand-anything`
4. Direct binary at user prefix: `~/.local/share/understand-anything/node_modules/.bin/understand-anything`

The runner first tries the direct binary paths (faster, no npx overhead),
falling back to npx if none are found.

### Invocation

```bash
npx understand-anything analyze <folder>
```

Output: `<folder>/.understand-anything/knowledge-graph.json`

### Prerequisites check

Before invoking, UARunner checks:
- Node.js is installed and on PATH
- Node.js version >= 22 (parse output of `node --version`)
- Target folder is writable

New error case: `.nodeVersionTooOld(found: String)` with install hint
suggesting `nvm install 22` or `brew install node@22`.

### Install hint

```
npm install -g understand-anything
```

## UAParser

### Input schema

UA outputs versioned JSON at `.understand-anything/knowledge-graph.json`:

```json
{
  "version": "1.0.0",
  "kind": "codebase",
  "project": { "name", "languages", "frameworks", "description", "analyzedAt", "gitCommitHash" },
  "nodes": [{ "id": "file:path", "type", "name", "filePath", "lineRange", "summary", "tags", "complexity" }],
  "edges": [{ "source", "target", "type", "direction", "description", "weight" }],
  "layers": [{ "id", "name", "description", "nodeIds" }],
  "tour": [{ "order", "title", "description", "nodeIds" }]
}
```

### Mapping logic

**Node ID:** UA uses `type:path` format (e.g. `"file:src/index.ts"`). Stored
as-is in `CGNode.id`.

**Node type:** Direct switch on `type` string to `CGNodeKind`. UA's alias
table (e.g. `"func"` -> `"function"`, `"struct"` -> `"class"`) is applied
before mapping.

**File path resolution:** Same `resolveFileURL` logic from the old parser —
`filePath` is relative, appended to `repoRoot`. Stale absolute paths are
rebased.

**Line range:** UA uses `[start, end]` array. Stored in metadata as
`"line": "L{start}-L{end}"` for compatibility with existing detail panel.

**Edge type:** Direct switch on `type` string to `CGEdgeKind`. UA's alias
table applied before mapping.

**Layers and tours:** Decoded into lightweight Swift structs, stored on
`CGData`.

## UAStore

Same disk-cache pattern as GraphifyStore:
- Cache directory: `~/Library/Application Support/MeetNotesMac/CodeGraph/<sha256>/`
- Files: `knowledge-graph.json` + `meta.json`
- `RunMetadata.graphifyVersion` renamed to `RunMetadata.toolVersion`
- `invalidate(for:)` unchanged

## UAInstaller

### For npm global install

```bash
npm install -g understand-anything
```

### For Claude Code plugin

```
/plugin marketplace add Lum1104/Understand-Anything
/plugin install understand-anything
```

The Mac app can surface these as copyable text in the install prompt, or
attempt `npx understand-anything install --platform <cli>` if available.

### Platform mapping

| AICliTool | Platform argument |
|-----------|------------------|
| `.claudeCode` | `claude` |
| `.cursor` | `cursor` |
| `.gemini` | `gemini` |
| `.copilot` | `codex` |

## Path changes

| Old path | New path |
|----------|----------|
| `<repo>/graphify-out/graph.json` | `<repo>/.understand-anything/knowledge-graph.json` |
| `<repo>/graphify-out/memory/` | `<repo>/.understand-anything/memory/` |
| `<repo>/graphify-out/memory/graph-notes.md` | `<repo>/.understand-anything/memory/graph-notes.md` |
| `<repo>/graphify-out/cache/` | N/A (UA manages its own cache internally) |
| `.gitignore`: `graphify-out/` | `.gitignore`: `.understand-anything/` |

## Claude Code skill update

1. Remove graphify skill reference from `~/.claude/CLAUDE.md`
2. Install UA plugin via marketplace
3. Update CLAUDE.md to reference `/understand` command
4. Delete old `mac/graphify-out/` directory
5. Update project `.gitignore`

## Out of scope

- Rendering UA's layers as colored groups in the SwiftUI canvas (future enhancement)
- Tour navigation UI in the Mac app (future enhancement)
- UA's React dashboard embedding (decided against)
- Image/video/PDF analysis (UA doesn't support; was a graphify-only feature via the Claude Code skill, not used by the Mac app)

## Testing

- UAParser unit tests: parse a sample `knowledge-graph.json` fixture, verify correct CGData output
- UARunner unit tests: mock ProcessLauncher, verify npx invocation args and error handling
- UAStore unit tests: save/load/invalidate cycle
- Node version check: mock `node --version` output for version parsing
- Integration: build the app and run against the existing `mac/` codebase with `/understand` to produce a real graph
