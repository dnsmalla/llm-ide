// Resolves shape-qualified code mentions in doc chunks against a code symbol
// inventory, producing doc→code link candidates. Port of Swift
// `GraphKit.DocCodeLinker`.
//
// This is the deterministic replacement for wikilink-only doc→code linking,
// which requires authors to write `[[Target]]` — something real docs never do.
//
// A "mention" is an inline backtick span (`like/this.mjs`, `backupTo`):
// backticks are the author explicitly marking a code entity, which is what
// keeps precision high — plain prose words never match. Fenced blocks are
// stripped first, since code samples quote many identifiers incidentally.

import { strippingFencedBlocks } from "./memoryGenerator.js";

/**
 * The chunk fields the merge actually reads.
 *
 * Deliberately structural rather than the full `MemoryChunk`: chunks reaching
 * the merge over the wire are encoded by whichever engine produced them, and
 * Swift emits `docURL` where this implementation emits `docPath`. Requiring the
 * full type would reject a payload the merge does not even look at.
 */
export interface MergeChunk {
  id: string;
  /** Every field but `id` is optional on purpose. Swift's `MemoryChunk` decoder
   *  defaults each of these, and says why: the type is a wire format between
   *  implementations, so "requiring exact parity would mean a perfectly good
   *  engine's output failed to decode". Dereferencing them raw made this side
   *  die with a TypeError on a payload Swift merges without complaint — and
   *  after minification the message named a mangled identifier, not the field. */
  body?: string;
  wikiLinks?: string[];
  relatedModules?: string[];
}

export interface DocCodeLink {
  chunkId: string;
  codeNodeId: string;
  /** As written in the doc. */
  mention: string;
  /** 0.9 path-shaped, 0.7 symbol-shaped.
   *
   *  Note: "." is a cheap proxy for path/file-extension shape, not a true path
   *  check — a dotted symbol reference (`self.foo`) or a version string also
   *  scores 0.9. This only affects RANKING, never WHETHER a link is emitted;
   *  the inventory lookup is the sole gate on that. */
  confidence: number;
}

/**
 * `inventory`: lowercased code-entity name → code node ids. Callers key by
 * relative file path ("kb/db.mjs"), file basename ("db.mjs"), and symbol name
 * ("backupto") as they see fit — the linker just matches lowercased mention
 * text against the keys.
 */
export function docCodeLinks(
  chunks: MergeChunk[],
  inventory: Map<string, string[]>,
): DocCodeLink[] {
  if (inventory.size === 0) return [];
  const out: DocCodeLink[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const scanText = strippingFencedBlocks(chunk.body ?? "");
    for (const mention of inlineCodeSpans(scanText)) {
      const ids = inventory.get(mention.toLowerCase());
      if (!ids) continue;
      const confidence = mention.includes("/") || mention.includes(".") ? 0.9 : 0.7;
      for (const id of ids) {
        const key = `${chunk.id}->${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ chunkId: chunk.id, codeNodeId: id, mention, confidence });
      }
    }
  }
  return out;
}

/**
 * Inline `` `span` `` contents that look like code entities: 2-120 chars, no
 * whitespace (prose in backticks is not an identifier).
 */
export function inlineCodeSpans(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /`([^`\n]{2,120})`/g;
  for (const match of text.matchAll(re)) {
    const span = match[1]!.trim();
    if (!span) continue;
    if (span.includes(" ") || span.includes("\t")) continue;
    if (seen.has(span)) continue;
    seen.add(span);
    out.push(span);
  }
  return out;
}
