// Incremental, idempotent memory-index generation. Maintains a content-hash
// manifest so only CHANGED source files are re-read and re-chunked; unchanged
// docs are reused from cache. Artifacts are written to a `.graphkit/` directory
// that self-gitignores (memory stays local, never pushed).
//
// This is the "check existing, update only what's not done" engine: cheap to run
// on every code change (e.g. from a git hook or watcher) and token-light, because
// it never re-derives work it already did.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  collectMemoryDocs,
  chunksForDoc,
  contentHash,
  docIdentity,
  assembleGraph,
  type DocMeta,
} from "./text/memoryGenerator.js";
import { generateIndex } from "./indexGenerator.js";
import { serializeDocument, toDocument, mergeGraphs } from "./models.js";
import { scanSkills, scanAgents, mergeCapabilities } from "./skills/skillScanner.js";
import { scanCode } from "./code/tsScanner.js";

/** Default artifact directory, relative to the scanned source root. */
export const DEFAULT_OUT_DIR = ".graphkit";
const CACHE_VERSION = 1;

interface CacheEntry {
  hash: string;
  meta: DocMeta;
}
interface Cache {
  version: number;
  docs: Record<string, CacheEntry>; // keyed by fileURL
}

export interface UpdateReport {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  nodes: number;
  edges: number;
  outDir: string;
}

/**
 * Refresh the memory index for `srcDir` incrementally. Re-chunks only files whose
 * content hash changed since the last run; reuses cached chunks for the rest.
 * Writes graph.json + index.md + cache.json into the artifact dir and returns a
 * report of what changed. Idempotent: a second run with no edits changes nothing.
 */
export async function updateMemory(
  srcDir: string,
  opts: { outDir?: string; skillsDir?: string; agentsDir?: string; codeDir?: string; scipIndex?: string } = {},
): Promise<UpdateReport> {
  const outDir = opts.outDir ?? join(srcDir, DEFAULT_OUT_DIR);
  const cachePath = join(outDir, "cache.json");
  const prev = loadCache(cachePath);
  const next: Cache = { version: CACHE_VERSION, docs: {} };
  const report: UpdateReport = {
    added: [], updated: [], unchanged: [], removed: [], nodes: 0, edges: 0, outDir,
  };

  const docs = collectMemoryDocs(srcDir);
  const metas: DocMeta[] = [];
  const seen = new Set<string>();

  for (const doc of docs) {
    const { fileURL } = docIdentity(doc);
    seen.add(fileURL);
    let text: string;
    try {
      text = readFileSync(doc, "utf8");
    } catch {
      continue; // unreadable file — skip (it simply won't appear in the graph)
    }
    const hash = contentHash(text);
    const prevEntry = prev.docs[fileURL];
    if (prevEntry && prevEntry.hash === hash) {
      metas.push(prevEntry.meta);
      next.docs[fileURL] = prevEntry;
      report.unchanged.push(fileURL);
    } else {
      const meta = chunksForDoc(doc);
      metas.push(meta);
      next.docs[fileURL] = { hash, meta };
      (prevEntry ? report.updated : report.added).push(fileURL);
    }
  }
  for (const fileURL of Object.keys(prev.docs)) {
    if (!seen.has(fileURL)) report.removed.push(fileURL);
  }

  let { graph } = assembleGraph(metas);

  // Link skills + agents into the index so agents can consult it cheaply.
  const capabilities = [
    ...(opts.skillsDir ? scanSkills(opts.skillsDir) : []),
    ...(opts.agentsDir ? scanAgents(opts.agentsDir) : []),
  ];
  graph = mergeCapabilities(graph, capabilities);

  // Fold in a code→graph when requested, into the same index. `--scip` alone is
  // sufficient to trigger this: scanCode's SCIP branch reads only from `scipIndex`
  // and never touches `root`, so passing a falsy `codeDir` alongside it is harmless.
  if (opts.codeDir || opts.scipIndex) {
    graph = mergeGraphs(graph, await scanCode(opts.codeDir ?? "", { scipIndex: opts.scipIndex }));
  }

  report.nodes = graph.nodes.length;
  report.edges = graph.edges.length;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "graph.json"), serializeDocument(toDocument(graph)));
  writeFileSync(join(outDir, "index.md"), generateIndex(graph, { title: "Memory Index" }));
  writeFileSync(cachePath, JSON.stringify(next));
  ensureGitignore(outDir);
  return report;
}

function loadCache(path: string): Cache {
  if (!existsSync(path)) return { version: CACHE_VERSION, docs: {} };
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Cache;
    // A cache from a different version is a perf artifact, not source of truth —
    // rebuild from scratch rather than risk a stale/incompatible shape.
    if (c.version !== CACHE_VERSION || typeof c.docs !== "object") {
      return { version: CACHE_VERSION, docs: {} };
    }
    return c;
  } catch {
    return { version: CACHE_VERSION, docs: {} };
  }
}

/** Make the artifact dir self-ignoring so generated memory is never committed. */
function ensureGitignore(outDir: string): void {
  const gi = join(outDir, ".gitignore");
  if (existsSync(gi)) return;
  writeFileSync(gi, "# GraphKit-generated memory index — local only, do not commit.\n*\n");
}
