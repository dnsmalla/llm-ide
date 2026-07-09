// Services barrel (Phase 2). Aggregates the service singletons and their
// public types in one entry point. Import specifiers use `.ts` so the barrel
// also loads under `node --test --experimental-strip-types`; the repo tsconfig
// (`allowImportingTsExtensions: true`) accepts these under the bundler / tsc.

export { memoryService } from './memory-service.ts';
export { graphService } from './graph-service.ts';
export { automationService } from './automation-service.ts';
export { NoteService } from './note-service.ts';
export type {
  AgentContext,
  UIAction,
  CleanupReport,
  ContradictionReport,
  NoteMetadata,
  NoteFilter,
  NoteType
} from './automation-service.ts';
export type { NoteMetadata, NoteFilter, NoteType } from './note-service.ts';
