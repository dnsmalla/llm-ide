// The ONE place that knows where a project's generated knowledge lives on disk.
// Mirrors the Mac app's `GeneratedDataLocator` (mac/.../Core/Project), decision D1
// of 2026-10-28: generated data ALWAYS lives in the PROJECT's own `system/`,
// never in a cloned repo's `system/` under `code/<child>/`. The cloned repo is
// only the input being graphed.
//
// Callers pass either the project root or a `code/<child>` repo root. Both
// resolve to the same project:
//
//   <project>/system/graph/index.md          code graph overview (one repo)
//   <project>/system/graph/<child>/index.md  code graph per repo (2+ code/ repos)
//   <project>/system/memory/chat-memory.md   LLM-curated durable facts
//   <project>/system/memory/graph-notes.md   cross-links + dependency hubs
//   <project>/system/memory/doc-notes.md     doc/InfiniteBrain sections
//   <project>/system/repo.md                 hand-authored project facts
//   <project>/system/faults/, system/q&a/    archived fault reports + saved Q&A
//
// A `<project>` is a directory whose `system/project.json` exists. A repo is a
// `code/<child>` directory only when its parent is named `code` AND the
// grandparent is such a project. Anything else (including a project living
// under `~/code/`) is its own root.
//
// Read-only legacy fallbacks (N-1), never written:
//   `<repo>/system/...`             pre-D1 location of generated output
//   `<repo>/graphify-out/memory/`   pre-consolidation memory (owned by `/graphify`)
// The Mac app's migration moves `<repo>/system/...` into the project at open.
//
// Nothing here writes to a repo; writers use the project-level paths only.

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const SYSTEM_DIR = 'system';
const MEMORY_DIRNAME = 'memory';
const GRAPH_DIRNAME = 'graph';

/** `<project>` for a project root or a `code/<child>` repo root. */
export function projectRootOf(root) {
  const r = resolve(root);
  const parent = dirname(r);
  if (basename(parent) !== 'code') return r;
  const grand = dirname(parent);
  return existsSync(join(grand, SYSTEM_DIR, 'project.json')) ? grand : r;
}

/** Child repo folder names under `<project>/code/` (sorted, hidden skipped). */
function codeChildNames(project) {
  try {
    return readdirSync(join(project, 'code'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** `<project>/system` — the single generated-knowledge container. */
export function systemDir(root) {
  return join(projectRootOf(root), SYSTEM_DIR);
}

/** `<project>/system/memory` — generated + curated agent memory. */
export function memoryDir(root) {
  return join(systemDir(root), MEMORY_DIRNAME);
}

/**
 * Code-graph output dir for `root`. Flat `system/graph/` when the project graphs
 * at most one repo; with 2+ `code/<child>` repos each gets `system/graph/<child>/`.
 * Mirrors `GeneratedDataLocator.graphDir(forRepo:)` on the Mac side.
 */
export function graphDir(root) {
  const r = resolve(root);
  const project = projectRootOf(r);
  const base = join(project, SYSTEM_DIR, GRAPH_DIRNAME);
  if (r === project) return base;
  return codeChildNames(project).length > 1 ? join(base, basename(r)) : base;
}

/** Pre-D1 generated-output container inside a repo: `<repo>/system`. Read-only. */
export function legacySystemDir(root) {
  return join(resolve(root), SYSTEM_DIR);
}

/** Pre-consolidation memory location. Read-only fallback; never written. */
export function legacyMemoryDir(root) {
  return join(resolve(root), 'graphify-out', MEMORY_DIRNAME);
}

/** Pre-D1 memory location inside a repo: `<repo>/system/memory`. Read-only. */
export function legacySystemMemoryDir(root) {
  return join(legacySystemDir(root), MEMORY_DIRNAME);
}

/** `<project>/system/graph/index.md` — the code graph overview. Falls back to the legacy file when only that exists. */
export function graphIndexFile(root) {
  const current = join(graphDir(root), 'index.md');
  if (existsSync(current)) return current;
  const legacy = join(legacySystemDir(root), GRAPH_DIRNAME, 'index.md');
  return existsSync(legacy) ? legacy : current;
}

/** The canonical chat-memory file (the only path ever written). */
export function chatMemoryFile(root) {
  return join(memoryDir(root), 'chat-memory.md');
}

/** Its pre-consolidation location, migrated forward on first write. */
export function legacyChatMemoryFile(root) {
  return join(legacyMemoryDir(root), 'chat-memory.md');
}
