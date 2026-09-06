// Walks .md / .mdx / .markdown / .txt files and generates "memory chunks" —
// heading-bounded sections of text. Each chunk is a graph node; chunks link to
// their doc via `contains` (doc → chunk), and to each other via wiki-links (`references`),
// shared tags (`relatedTo`, capped), and whole-word title mentions (`relatedTo`).
// Faithful port of the Swift `MemoryGenerator`. v1: no LLM, no embeddings.

import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, realpathSync } from "node:fs";
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
  /** Frontmatter `graph-only: true` — graph the doc, keep it out of the
   *  agent-facing memory artifacts. Mirrors Swift `MemoryChunk.graphOnly`. */
  graphOnly: boolean;
  /** Frontmatter `related-modules:` — declared code-module affinity, consumed
   *  by the merge step to emit documents/EXTRACTED doc→code edges. Case is
   *  preserved for display; consumers match case-insensitively. Mirrors Swift
   *  `MemoryChunk.relatedModules`. */
  relatedModules: string[];
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
  // Symlinks are resolved, not just `..`/`.` normalised, because the doc id is
  // sha256 of this string and Swift's `URL.path` yields the REAL path. Without
  // realpath the two implementations id the same file differently the moment a
  // symlink is anywhere in the tree — on macOS `/var` → `/private/var` alone is
  // enough — and every join on node ids (cross-links, incremental cache reuse,
  // the merge step) silently stops matching.
  const abs = realpathOrResolve(docPath);
  return {
    abs,
    fileURL: pathToFileURL(abs).href,
    docID: "doc:" + shortHash(abs),
    docTitle: basename(abs, extname(abs)),
  };
}

/** Real path when the file exists, plain resolution otherwise. A doc can be
 *  passed in that no longer exists (a stale cache entry, a caller-supplied
 *  list); id derivation must stay total rather than throwing. */
function realpathOrResolve(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
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
  const emit = (
    from: string,
    to: string,
    kind: CGEdge["kind"],
    confidence: CGEdge["confidence"] = "EXTRACTED",
  ) => {
    const key = `${from}→${to}:${kind}`;
    if (from === to || emitted.has(key)) return;
    emitted.add(key);
    edges.push({ fromId: from, toId: to, kind, confidence });
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
      for (let j = i + 1; j < head.length; j++)
        emit(head[i]!, head[j]!, "relatedTo", "INFERRED");
    }
  }

  // (3) Whole-word title fallback for chunks lacking explicit wiki-links
  const titleByID = new Map(allChunks.map((c) => [c.id, c.title] as const));
  for (const c of allChunks) {
    if (c.wikiLinks.length > 0) continue;
    // Fences stripped here too, matching Swift: an identifier mentioned only
    // inside a code sample is not a topical reference to another chunk.
    const body = strippingFencedBlocks(c.body).toLowerCase();
    for (const [otherID, otherTitle] of titleByID) {
      if (otherID === c.id) continue;
      const needle = otherTitle.toLowerCase();
      if (needle.length < 5) continue;
      if (containsWholeWord(body, needle)) emit(c.id, otherID, "relatedTo", "AMBIGUOUS");
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
    // Scan with fenced code blocks removed, as Swift does. A code sample that
    // happens to contain `[[Foo]]` or `#bar` is quoting, not authoring: left in,
    // it manufactures reference edges and tags the document never meant.
    const scanText = strippingFencedBlocks(bounded);
    const tags = mergeTags(frontmatterTags, extractHashtags(scanText));
    const wikiLinks = extractWikiLinks(scanText);
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
      // Doc-level frontmatter applies to every chunk of that doc, as in Swift.
      graphOnly: fm.graphOnly,
      relatedModules: fm.relatedModules,
    });
    bodyBuf = [];
  };

  let inFence = false;
  for (const line of lines) {
    // Fence state gates heading detection, as it does in Swift. A `#` line
    // inside a code fence is sample text, not a section: treated as a heading
    // it splits the document into a chunk that exists in one implementation and
    // not the other — and because chunk ids hash the heading path, that changes
    // NODE IDENTITY, not just content.
    const fenceMark = line.trim();
    if (fenceMark.startsWith("```") || fenceMark.startsWith("~~~")) {
      inFence = !inFence;
      bodyBuf.push(line);
      continue;
    }
    const heading = inFence ? null : parseHeading(line);
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

interface ParsedFrontmatter {
  text: string;
  kind: CGNodeKind | null;
  tags: string[];
  graphOnly: boolean;
  relatedModules: string[];
}

const EMPTY_FRONTMATTER = { kind: null, tags: [], graphOnly: false, relatedModules: [] };

/**
 * Minimal YAML-ish frontmatter mapping parser — a port of Swift
 * `MemoryGenerator.parseSimpleFrontmatterMapping`.
 *
 * Only top-level `key: value` lines are read; everything after the first colon
 * is kept verbatim (descriptions may contain colons), and an INDENTED line is a
 * continuation of the current key's value.
 *
 * That indentation rule is load-bearing, not incidental. Matching a trimmed
 * line instead promoted keys nested under another mapping to top level — so a
 * `schema:` block containing `graph-only: true` (a shape skill and agent files
 * routinely have) made this implementation withhold a document that Swift kept.
 * It is also what makes a NON-indented `- item` sequence yield an empty value
 * on both sides rather than a list on one.
 *
 * Deliberately not a real YAML parser: Swift avoids Yams here because agent
 * files carry unquoted colons and nested mappings that can trap it mid-parse
 * during a background graph build.
 */
function parseFrontmatterMapping(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentValue = "";
  const flush = () => {
    if (currentKey !== null) out[currentKey] = currentValue.trim();
    currentKey = null;
    currentValue = "";
  };
  for (const line of block.split("\n")) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (currentKey !== null) {
        if (currentValue !== "") currentValue += "\n";
        currentValue += line.trim();
      }
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    currentKey = key.toLowerCase();
    currentValue = line.slice(colon + 1);
  }
  flush();
  return out;
}

/**
 * Interpret a mapping value that may be a YAML block sequence, a flow sequence
 * or a plain scalar. Port of Swift `normalizeFrontmatterList`.
 */
function normalizeFrontmatterList(raw: string | undefined): string[] | string | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (!s) return null;
  // Block sequence: the line parser joined `- item` lines with newlines.
  if (s.startsWith("- ") || s.startsWith("-\n") || s.includes("\n- ")) {
    return s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => unquote(l.slice(1)))
      .filter((l) => l !== "");
  }
  // Flow sequence: [a, b] / ["a", "b"].
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((p) => unquote(p))
      .filter((p) => p !== "");
  }
  return unquote(s);
}

/** A normalised list value as parts: an array stays as-is, a scalar splits on
 *  whitespace or comma. Mirrors the shared head of Swift's
 *  `parseFrontmatterTags` / `parseModuleList`. */
function listParts(value: string[] | string | null): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[\s,]+/).filter((p) => p !== "");
  return [];
}

function stripFrontmatter(text: string): ParsedFrontmatter {
  if (!text.startsWith("---\n")) return { text, ...EMPTY_FRONTMATTER };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { text, ...EMPTY_FRONTMATTER };
  const block = text.slice(4, end);
  // Trimmed, as Swift trims: the closing fence's trailing newline belongs to
  // the fence, not the body, so an untrimmed slice gave every chunk of every
  // frontmatter-bearing document a different body than Swift produced.
  const remaining = text.slice(end + 5).trim();

  const map = parseFrontmatterMapping(block);
  const rawType = unquote(map["type"] ?? map["kind"] ?? "");
  const tags = cleanTags(listParts(normalizeFrontmatterList(map["tags"])));
  const graphOnly = parseBool(map["graph-only"] ?? map["graphonly"] ?? "") ?? false;
  const relatedModules = cleanModules(
    listParts(normalizeFrontmatterList(map["related-modules"] ?? map["relatedmodules"])),
  );

  return { text: remaining, kind: kindFromTypeString(rawType), tags, graphOnly, relatedModules };
}

/** YAML-ish booleans, matching Swift `MemoryGenerator.parseBool`. */
function parseBool(raw: string): boolean | null {
  switch (unquote(raw).toLowerCase()) {
    case "true":
    case "yes":
    case "1":
      return true;
    case "false":
    case "no":
    case "0":
      return false;
    default:
      return null;
  }
}

/** Strip surrounding single/double quotes from a scalar. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length < 2) return s;
  for (const q of ['"', "'"]) {
    if (s.startsWith(q) && s.endsWith(q)) return s.slice(1, -1);
  }
  return s;
}

/** Trim, unquote and de-duplicate a declared module list, preserving case and
 *  order. Path-form normalisation (`./kb`, `kb/`, `kb/*`) is the merge step's
 *  job, matching where Swift does it. */
function cleanModules(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw) {
    const cleaned = unquote(part).trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
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

/**
 * Drop fenced code blocks so quoted text is not scanned for links or tags.
 *
 * Mirrors Swift `MemoryGenerator.strippingFencedBlocks`, including its
 * limitations: fence toggling matches on the PRESENCE of a marker, not on
 * matching character or length, so a stray `~~~` inside a ``` fence desyncs the
 * toggle for the rest of the document; indentation is not considered either.
 * Kept deliberately identical — a heuristic that differs between the two
 * implementations is worse than one that is imperfect in the same way in both.
 */
export function strippingFencedBlocks(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

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
