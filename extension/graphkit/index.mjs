// graphkit — the graph + memory module.
//
//   graph.mjs  — code-graph queries (FTS-backed "what code relates to X",
//                plus searchCodeIndex: the staged symbol-index → graph →
//                text-index search behind the agent's find-code tool)
//   memory.mjs — repository memory bridged into agent context
//   paths.mjs  — the one definition of where a repo's generated knowledge
//                lives on disk (`<repo>/system/…`); read it first
//
// Agents and context renderers import from here; the KB's graph tables
// and the on-disk directory layout are implementation details behind
// this surface.

export {
  findRelatedCode, findGraphContext, rollupCodeRefs, findRelatedSymbols,
  searchCodeIndex, relationLabel, seedCandidates,
} from './graph.mjs';
export { renderGraphifyMemory, buildAllowedRoots, resolveAllowedRepoRoot } from './memory.mjs';
export {
  readChatMemoryFacts,
  writeChatMemoryFacts,
  appendChatMemory,
  parseChatMemoryFacts,
  factKey,
  factIndex,
} from './memory-writer.mjs';
