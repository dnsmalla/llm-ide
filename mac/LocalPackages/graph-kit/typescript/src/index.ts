// @dnsmalla/graph-kit — TypeScript implementation of the GraphKit canonical
// graph engine. Schema-compatible with the Swift package (see ../schema/SCHEMA.md).

export * from "./models.js";
export {
  generateFromDir,
  generateFromFiles,
  type GeneratedMemory,
  type MemoryChunk,
  SUPPORTED_EXTENSIONS,
  displayName,
} from "./text/memoryGenerator.js";
export {
  chunksForDoc,
  assembleGraph,
  collectMemoryDocs,
  docIdentity,
  contentHash,
  type DocMeta,
} from "./text/memoryGenerator.js";
export { generateIndex, type IndexOptions } from "./indexGenerator.js";
export { scanCode } from "./code/tsScanner.js";
export { parseScipJson, loadScipIndex } from "./code/scipScanner.js";
export { updateMemory, DEFAULT_OUT_DIR, type UpdateReport } from "./incremental.js";
export { scanSkills, scanAgents, mergeCapabilities } from "./skills/skillScanner.js";
