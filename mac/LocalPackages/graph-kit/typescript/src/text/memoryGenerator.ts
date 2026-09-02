// Walks .md / .mdx / .markdown / .txt files and generates "memory chunks" —
// heading-bounded sections of text. Each chunk is a graph node; chunks link to
// their doc via `contains` (doc → chunk), and to each other via wiki-links (`references`),
// shared tags (`relatedTo`, capped), and whole-word title mentions (`relatedTo`).
// Faithful port of the Swift `MemoryGenerator`. v1: no LLM, no embeddings.

import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { EXCLUDED_DIRS } from "../exclusions.js";
import { join, extname, basename, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CGData, CGEdge, CGNode, CGNodeKind } from "../models.js";

export const SUPPORTED_EXTENSIONS = new Set(["md", "mdx", "markdown", "txt"]);
export const MAX_CHUNK_BODY_CHARS = 4000;
const TAG_CAP = 6;

export interface MemoryChunk {
  id: string;
  docPath: string;
  docTitle: string;
  headingPath: string[];
  body: string;
  kind: CGNodeKind;
  tags: string[];
  wikiLinks: string[];
  title: string;
  displayHeading: string;
}

export interface GeneratedMemory {
  graph: CGData;
  chunks: MemoryChunk[];
  docCount: number;
}

/** Generate a memory graph from an explicit list of files. */
export function generateFromFiles(files: string[]): GeneratedMemory {
  const docs = files
    .filter((p) => SUPPORTED_EXTENSIONS.has(ext(p)) && isRegularFile(p))
    .sort();
  return generate(docs);
}

/** List supported doc files under a directory (bounded), as absolute paths. */
export function collectMemoryDocs(
  root: string,
  opts: { maxFiles?: number; maxFileBytes?: number } = {},
): string[] {
  return collectDocs(root, opts.maxFiles ?? 500, opts.maxFileBytes ?? 2_000_000);
}

/** Walk a directory (bounded) and build a memory graph. */
export function generateFromDir(
  root: string,
  opts: { maxFiles?: number; maxFileBytes?: number } = {},
): GeneratedMemory {
  const maxFiles = opts.maxFiles ?? 500;
  const maxFileBytes = opts.maxFileBytes ?? 2_000_000;
  return generate(collectDocs(root, maxFiles, maxFileBytes));
}

/** Stable identity for a doc: hashes the ABSOLUTE path and emits a file:// URL so
 * node IDs + metadata match across implementations (and across runs). */
export function docIdentity(docPath: string): {
  abs: string;
  fileURL: string;
  docID: string;
  docTitle: string;
} {
  const abs = resolve(docPath);
  return {
    abs,
    fileURL: pathToFileURL(abs).href,
    docID: "doc:" + shortHash(abs),
    docTitle: basename(abs, extname(abs)),
  };
}

/** One doc's chunked result — the cacheable unit for incremental updates. */
export interface DocMeta {
  docID: string;
  docTitle: string;
  fileURL: string;
  chunks: MemoryChunk[];
}

/** Read + chunk a single doc into a cacheable DocMeta. */
export function chunksForDoc(docPath: string): DocMeta {
  const { abs, fileURL, docID, docTitle } = docIdentity(docPath);
  return { docID, docTitle, fileURL, chunks: chunkDoc(abs, fileURL, docID, docTitle) };
}

/** Content hash of a string — used by the incremental manifest. */
export function contentHash(text: string): string {
  return shortHash(text);
}

/**
 * Assemble doc + chunk nodes and all cross-chunk edges from already-chunked docs.
 * Pure: no file I/O. The incremental updater calls this with a mix of freshly
 * chunked docs and cache-reused DocMetas.
 */
export function assembleGraph(docs: DocMeta[]): { graph: CGData; chunks: MemoryChunk[] } {
  const allChunks: MemoryChunk[] = [];
  const nodes: CGNode[] = [];
  const edges: CGEdge[] = [];

  for (const d of docs) {
    nodes.push({ id: d.docID, title: d.docTitle, kind: "memoryDoc", metadata: { fileURL: d.fileURL } });
    for (const chunk of d.chunks) {
      allChunks.push(chunk);
      nodes.push({
        id: chunk.id,
        title: chunk.title,
        kind: chunk.kind,
        metadata: {
          fileURL: d.fileURL,
          doc: d.docTitle,
          heading: chunk.displayHeading,
          type: displayName(chunk.kind),
        },
      });
      // Containment, typed as containment and pointing parent→child — mirroring
      // the Swift implementation and the code track's file→symbol convention.
      //
      // This was `chunk → doc` with kind `relatedTo`, which made a document's
      // backbone indistinguishable from the noisy title-match guesses that
      // share that kind. Any consumer that ranks or filters edges by strength
      // therefore dropped the one edge saying which document a section belongs
      // to, leaving every chunk isolated: a real 13-doc folder produced 209
      // nodes in 209 separate components.
      edges.push({ fromId: d.docID, toId: chunk.id, kind: "contains", confidence: "EXTRACTED" });
    }
  }

  // Cross-chunk edges, priority order (de-duped).
  const byLowerTitle = new Map<string, MemoryChunk[]>();
  for (const c of allChunks) {
    const key = c.title.toLowerCase();
    (byLowerTitle.get(key) ?? byLowerTitle.set(key, []).get(key)!).push(c);
  }
  const emitted = new Set<string>();
  const emit = (from: string, to: string, kind: CGEdge["kind"]) => {
    const key = `${from}→${to}:${kind}`;
    if (from === to || emitted.has(key)) return;
    emitted.add(key);
    edges.push({ fromId: from, toId: to, kind, confidence: "EXTRACTED" });
  };

  // (1) Wiki-links → references
  for (const c of allChunks) {
    for (const target of c.wikiLinks) {
      for (const m of byLowerTitle.get(target.toLowerCase()) ?? []) {
        emit(c.id, m.id, "references");
      }
    }
  }

  // (2) Tag co-occurrence → relatedTo, capped per tag
  const byTag = new Map<string, string[]>();
  for (const c of allChunks) {
    for (const t of c.tags) (byTag.get(t) ?? byTag.set(t, []).get(t)!).push(c.id);
  }
  for (const ids of byTag.values()) {
    if (ids.length < 2) continue;
    const head = ids.slice(0, TAG_CAP);
    for (let i = 0; i < head.length; i++) {
      for (let j = i + 1; j < head.length; j++) emit(head[i]!, head[j]!, "relatedTo");
    }
  }

  // (3) Whole-word title fallback for chunks lacking explicit wiki-links
  const titleByID = new Map(allChunks.map((c) => [c.id, c.title] as const));
  for (const c of allChunks) {
    if (c.wikiLinks.length > 0) continue;
    const body = c.body.toLowerCase();
    for (const [otherID, otherTitle] of titleByID) {
      if (otherID === c.id) continue;
      const needle = otherTitle.toLowerCase();
      if (needle.length < 5) continue;
      if (containsWholeWord(body, needle)) emit(c.id, otherID, "relatedTo");
    }
  }

  return { graph: { nodes, edges, layers: [], tour: [] }, chunks: allChunks };
}

function generate(docs: string[]): GeneratedMemory {
  const metas = docs.map(chunksForDoc);
  const { graph, chunks } = assembleGraph(metas);
  return { graph, chunks, docCount: metas.length };
}

// --------------------------------------------------------------------------
// chunking
// --------------------------------------------------------------------------

function chunkDoc(docPath: string, _fileURL: string, docID: string, docTitle: string): MemoryChunk[] {
  let text: string;
  try {
    text = readFileSync(docPath, "utf8");
  } catch {
    return [];
  }

  const fm = stripFrontmatter(text);
  text = fm.text;
  const defaultKind: CGNodeKind = fm.kind ?? "memoryChunk";
  const frontmatterTags = fm.tags;

  const lines = text.split("\n");
  const chunks: MemoryChunk[] = [];
  const headingStack: string[] = [];
  const headingLevels: number[] = [];
  let bodyBuf: string[] = [];

  const flush = () => {
    const body = bodyBuf.join("\n");
    if (body.trim().length === 0 && headingStack.length === 0) {
      bodyBuf = [];
      return;
    }
    const bounded = body.slice(0, MAX_CHUNK_BODY_CHARS);
    const id = `${docID}::${shortHash(headingStack.join("/"))}:${chunks.length}`;
    const kind = classify(headingStack[headingStack.length - 1], bounded) ?? defaultKind;
    const tags = mergeTags(frontmatterTags, extractHashtags(bounded));
    const wikiLinks = extractWikiLinks(bounded);
    const headingPath = [...headingStack];
    chunks.push({
      id,
      docPath,
      docTitle,
      headingPath,
      body: bounded,
      kind,
      tags,
      wikiLinks,
      title: headingPath[headingPath.length - 1] ?? docTitle,
      displayHeading: headingPath.length === 0 ? "(preamble)" : headingPath.join(" › "),
    });
    bodyBuf = [];
  };

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      flush();
      while (headingLevels.length > 0 && headingLevels[headingLevels.length - 1]! >= heading.level) {
        headingStack.pop();
        headingLevels.pop();
      }
      headingStack.push(heading.text);
      headingLevels.push(heading.level);
    } else {
      bodyBuf.push(line);
    }
  }
  flush();
  return chunks;
}

// --------------------------------------------------------------------------
// frontmatter (lightweight: type/kind + tags, no YAML dependency)
// --------------------------------------------------------------------------

function stripFrontmatter(text: string): { text: string; kind: CGNodeKind | null; tags: string[] } {
  if (!text.startsWith("---\n")) return { text, kind: null, tags: [] };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { text, kind: null, tags: [] };
  const block = text.slice(4, end);
  const remaining = text.slice(end + 5);

  const blockLines = block.split("\n");
  let rawType = "";
  let rawTags: string[] = [];
  for (let i = 0; i < blockLines.length; i++) {
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(blockLines[i]!.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if ((key === "type" || key === "kind") && rawType === "") {
      rawType = val;
    } else if (key === "tags") {
      if (val) {
        rawTags = splitTagString(val);
      } else {
        // YAML block sequence: gather following `- item` lines.
        for (let j = i + 1; j < blockLines.length; j++) {
          const lm = /^\s*-\s*(.+?)\s*$/.exec(blockLines[j]!);
          if (!lm) break;
          rawTags.push(lm[1]!);
        }
      }
    }
  }
  return { text: remaining, kind: kindFromTypeString(rawType), tags: cleanTags(rawTags) };
}

/** Split an inline tag value: `[a, b]` or `a, b` or `a b`. */
function splitTagString(raw: string): string[] {
  let inner = raw.trim();
  if (inner.startsWith("[") && inner.endsWith("]")) inner = inner.slice(1, -1);
  return inner.split(/[\s,]+/);
}

/** Trim, strip leading `#` and surrounding quotes, lowercase, dedupe. */
function cleanTags(parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const cleaned = p.trim().replace(/^#+/, "").replace(/^["']|["']$/g, "").toLowerCase();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function kindFromTypeString(s: string): CGNodeKind | null {
  switch (s.toLowerCase().trim()) {
    case "decision": return "noteDecision";
    case "task": case "todo": return "noteTask";
    case "question": case "open": return "noteQuestion";
    case "fact": return "noteFact";
    case "concept": return "noteConcept";
    case "playbook": case "sop": case "process": return "notePlaybook";
    case "hypothesis": return "noteHypothesis";
    case "event": case "meeting": return "noteEvent";
    case "source": case "reference": return "noteSource";
    default: return null;
  }
}

// --------------------------------------------------------------------------
// body extractors + heuristics
// --------------------------------------------------------------------------

const WIKI_RE = /\[\[([^[\]|\n]+)(?:\|[^[\]\n]*)?\]\]/g;
const HASHTAG_RE = /(?:^|[\s([])#([A-Za-z][A-Za-z0-9_/-]*)/g;
const CHECKBOX_RE = /^\s*-\s*\[[ x]\]\s/m;

export function extractWikiLinks(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(WIKI_RE)) {
    const target = (m[1] ?? "").trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

export function extractHashtags(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(HASHTAG_RE)) {
    const tag = (m[1] ?? "").toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export function classify(heading: string | undefined, body: string): CGNodeKind | null {
  const h = (heading ?? "").toLowerCase();
  if (h.includes("decision")) return "noteDecision";
  if (h.includes("question") || h.endsWith("?")) return "noteQuestion";
  if (h.includes("hypothesis")) return "noteHypothesis";
  if (h.includes("playbook") || h.includes("how to") || h.includes("how-to") || h.includes("runbook") || h.includes("sop")) return "notePlaybook";
  if (h.includes("task") || h.includes("todo") || h.includes("action item")) return "noteTask";
  if (h.includes("fact") || h.includes("metric") || h.includes("number")) return "noteFact";
  if (h.includes("concept") || h.includes("definition") || h.includes("glossary")) return "noteConcept";
  if (h.includes("meeting") || h.includes("standup") || h.includes("retro")) return "noteEvent";
  if (h.includes("source") || h.includes("reference") || h.includes("citation")) return "noteSource";
  if (CHECKBOX_RE.test(body)) return "noteTask";
  return null;
}

function parseHeading(line: string): { level: number; text: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) return null;
  let level = 0;
  while (level < trimmed.length && trimmed[level] === "#") level++;
  if (level < 1 || level > 6 || trimmed[level] !== " ") return null;
  const text = trimmed.slice(level).trim();
  return text ? { level, text } : null;
}

export function containsWholeWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const leftOK = idx === 0 || !isWordChar(haystack[idx - 1]!);
    const rightEnd = idx + needle.length;
    const rightOK = rightEnd === haystack.length || !isWordChar(haystack[rightEnd]!);
    if (leftOK && rightOK) return true;
    from = idx + 1;
  }
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

export function mergeTags(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...a, ...b]) {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// fs + hashing
// --------------------------------------------------------------------------

function ext(p: string): string {
  return extname(p).replace(/^\./, "").toLowerCase();
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function collectDocs(root: string, maxFiles: number, maxFileBytes: number): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      if (name.startsWith(".")) continue; // skip hidden
      if (EXCLUDED_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && SUPPORTED_EXTENSIONS.has(ext(full)) && st.size <= maxFileBytes) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** SHA-256 prefix (16 hex chars / 64 bits) — matches the Swift node-ID scheme. */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// Re-export for callers that build their own paths.
export { sep as pathSep };

// --------------------------------------------------------------------------
// kind display names (mirror of Swift CGNodeKind.displayName, used in metadata)
// --------------------------------------------------------------------------

const DISPLAY_NAMES: Record<CGNodeKind, string> = {
  file: "File", symbol: "Symbol", module: "Module", docPage: "Doc",
  memoryDoc: "Document", memoryChunk: "Note", noteDecision: "Decision",
  noteTask: "Task", noteQuestion: "Question", noteFact: "Fact",
  noteConcept: "Concept", notePlaybook: "Playbook", noteHypothesis: "Hypothesis",
  noteEvent: "Event", noteSource: "Source", function: "Function", classType: "Class",
  config: "Config", service: "Service", table: "Table", endpoint: "Endpoint",
  pipeline: "Pipeline", schemaNode: "Schema", resource: "Resource", domain: "Domain",
  flow: "Flow", step: "Step", article: "Article", entity: "Entity", topic: "Topic",
  claim: "Claim", skill: "Skill", agent: "Agent", other: "Other",
};

export function displayName(kind: CGNodeKind): string {
  return DISPLAY_NAMES[kind];
}
