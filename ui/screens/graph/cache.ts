// In-memory layout cache keyed by the graph file's SHA-256 plus the layout version, so reopening the screen
// or re-reading an unchanged graph.json costs nothing. Bounded by an estimate of retained bytes (typed
// arrays exactly, strings approximately) and by entry count; least recently used goes first.
import type { GraphModel, LayoutResult } from "./model.ts";

/** Bump when the kernel, the decoder or the rank rules change the result for the same file. */
export const LAYOUT_VERSION = "k1";

export interface CacheEntry {
  model: GraphModel;
  layout: LayoutResult;
  notices: string[];
}

export function estimateBytes(e: CacheEntry): number {
  const { model: m, layout: l } = e;
  let b = m.kindOf.byteLength + m.from.byteLength + m.to.byteLength + m.edgeKind.byteLength + m.conf.byteLength;
  b += l.pos.byteLength + l.radius.byteLength + l.community.byteLength + l.degree.byteLength + l.inDegree.byteLength + l.rank.byteLength + l.communityRank.byteLength;
  b += m.n * 160; // ids, titles, paths, meta: average string cost
  return b;
}

export class LayoutCache {
  private map = new Map<string, CacheEntry>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  constructor(maxBytes = 256 * 1024 * 1024, maxEntries = 3) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  static key(sha256Hex: string): string {
    return `${LAYOUT_VERSION}:${sha256Hex}`;
  }

  get(key: string): CacheEntry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e); // most recently used goes last
    return e;
  }

  set(key: string, e: CacheEntry): void {
    const old = this.map.get(key);
    if (old) {
      this.bytes -= estimateBytes(old);
      this.map.delete(key);
    }
    const size = estimateBytes(e);
    if (size > this.maxBytes) return; // never cache one entry bigger than the whole budget
    this.map.set(key, e);
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.bytes -= estimateBytes(this.map.get(first.value)!);
      this.map.delete(first.value);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }
  get retainedBytes(): number {
    return this.bytes;
  }
}

export async function sha256Hex(text: string, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
