// The ONE place that knows where a repo's generated knowledge lives on disk.
//
// Everything the app generates for a repo lives under a single container,
// `<repo>/system/` — mirroring the Mac app's ProjectLayout ("System / generated
// data — one visible container"). One artifact, one path, rewritten in place:
//
//   system/graph/index.md      impact-ranked repo overview  (code graph)
//   system/graph/graph.json    machine-readable adjacency list
//   system/memory/graph-notes.md   cross-links + dependency hubs
//   system/memory/doc-notes.md     doc/InfiniteBrain sections
//   system/memory/chat-memory.md   LLM-curated durable facts (written here)
//   system/repo.md             hand-authored project facts
//   system/faults/, system/q&a/    archived fault reports + saved Q&A
//
// Two things this replaced:
//
//  1. `graphify-out/memory/` — that directory belongs to the separate
//     `/graphify` skill (it writes `graphify-out/graph.json`). The app was
//     dropping its own memory into another tool's output tree, so a `/graphify`
//     rebuild and an app regeneration each owned part of one directory.
//  2. `graphify-out/memory/repo.md` — a byte-for-byte COPY of
//     `system/graph/index.md`, rewritten every generation. The overview is now
//     read from the one file that owns it, so there is nothing to keep in sync.
//
// LEGACY_MEMORY_DIR is still READ when the canonical dir has no counterpart, so
// a repo the Mac app hasn't regenerated since the move keeps working. Nothing
// writes there any more: the chat-memory writer materialises migrated facts at
// the canonical path on its first write and removes the legacy file.

import { join } from 'node:path';

export const SYSTEM_DIR = 'system';
export const MEMORY_DIRNAME = 'memory';

/** `<root>/system` — the single generated-knowledge container. */
export function systemDir(root) {
  return join(root, SYSTEM_DIR);
}

/** `<root>/system/memory` — generated + curated agent memory. */
export function memoryDir(root) {
  return join(root, SYSTEM_DIR, MEMORY_DIRNAME);
}

/** Pre-consolidation location. Read-only fallback; never written. */
export function legacyMemoryDir(root) {
  return join(root, 'graphify-out', MEMORY_DIRNAME);
}

/** `<root>/system/graph/index.md` — the repo overview, owned by the code graph. */
export function graphIndexFile(root) {
  return join(root, SYSTEM_DIR, 'graph', 'index.md');
}

/** The canonical chat-memory file (the only path ever written). */
export function chatMemoryFile(root) {
  return join(memoryDir(root), 'chat-memory.md');
}

/** Its pre-consolidation location, migrated forward on first write. */
export function legacyChatMemoryFile(root) {
  return join(legacyMemoryDir(root), 'chat-memory.md');
}
