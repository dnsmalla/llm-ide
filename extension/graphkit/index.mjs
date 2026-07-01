// graphkit — the graph + memory module.
//
//   graph.mjs  — code-graph queries (FTS-backed "what code relates to X")
//   memory.mjs — Graphify repository memory (repo.md, graph-notes.md,
//                bugs/, q&a/) bridged into agent context
//
// Agents and context renderers import from here; the KB's graph tables
// and the graphify-out/ directory layout are implementation details
// behind this surface.

export { findRelatedCode, findGraphContext, rollupCodeRefs } from './graph.mjs';
export { renderGraphifyMemory, buildAllowedRoots, resolveAllowedRepoRoot } from './memory.mjs';
export {
  readChatMemoryFacts,
  writeChatMemoryFacts,
  appendChatMemory,
  parseChatMemoryFacts,
  factKey,
} from './memory-writer.mjs';
