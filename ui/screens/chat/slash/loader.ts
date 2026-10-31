// Lazy loader for the "/" catalog. Fetched when the menu OPENS (not on every keystroke), cached 60 s, retried
// after a 5 s backoff when any source failed, never overlapping (the shared fetch is not tied to one caller's abort). A source that fails keeps its previous items
// instead of wiping them; the snapshot is stamped fresh only when every source succeeded (the Mac's rule).
import type { CoreTransport } from "../transport";
import {
  buildCatalogItems, buildCommandItems, buildHookItems, buildLibraryItems, buildMcpItems, decodeCommands,
  type MenuItem,
} from "./items";

export interface CatalogSnapshot {
  commands: MenuItem[];
  skills: MenuItem[];
  subagents: MenuItem[];
  library: MenuItem[];
  hooks: MenuItem[];
  mcp: MenuItem[];
  /** Every source loaded in full on the last round. */
  complete: boolean;
}

export const CATALOG_TTL_MS = 60_000;
export const CATALOG_RETRY_MS = 5_000;

export function emptySnapshot(): CatalogSnapshot {
  return { commands: buildCommandItems([]), skills: [], subagents: [], library: [], hooks: [], mcp: [], complete: false };
}

export interface CatalogLoader {
  snapshot(): CatalogSnapshot;
  /** Loads when stale; resolves with the (possibly unchanged) snapshot. Safe to call on every menu open. */
  ensure(): Promise<CatalogSnapshot>;
  /** The next `ensure` refetches (plugins or sources changed). */
  invalidate(): void;
  subscribe(fn: () => void): () => void;
}

export function createCatalogLoader(core: CoreTransport, now: () => number = Date.now): CatalogLoader {
  let snap = emptySnapshot();
  let lastOk = -Infinity, lastAttempt = -Infinity;
  let inflight: Promise<CatalogSnapshot> | null = null;
  const subs = new Set<() => void>();

  async function run(): Promise<CatalogSnapshot> {
    lastAttempt = now();
    const get = (path: string) => core.json<unknown>("GET", path).then((v) => ({ ok: true as const, v }), () => ({ ok: false as const, v: null }));
    const [cmds, cat, lib, plug, mcp] = await Promise.all([
      get("/kb/agent/commands"), get("/kb/agent/catalog"), get("/kb/agent/skill-library"), get("/auth/me/plugins"), get("/auth/me/mcp-plugins"),
    ]);
    const next: CatalogSnapshot = { ...snap };
    if (cmds.ok) next.commands = buildCommandItems(decodeCommands(cmds.v));
    if (cat.ok) { const c = buildCatalogItems(cat.v); next.skills = c.skills; next.subagents = c.subagents; }
    if (lib.ok) next.library = buildLibraryItems(lib.v);
    if (plug.ok) next.hooks = buildHookItems(plug.v);
    if (mcp.ok) next.mcp = buildMcpItems(mcp.v);
    next.complete = cmds.ok && cat.ok && lib.ok && plug.ok && mcp.ok;
    if (next.complete) lastOk = now();
    snap = next;
    for (const f of [...subs]) f();
    return snap;
  }

  return {
    snapshot: () => snap,
    ensure() {
      if (inflight) return inflight;
      if (now() - lastOk < CATALOG_TTL_MS) return Promise.resolve(snap);
      if (now() - lastAttempt < CATALOG_RETRY_MS) return Promise.resolve(snap);
      inflight = run().finally(() => { inflight = null; });
      return inflight;
    },
    invalidate() { lastOk = -Infinity; lastAttempt = -Infinity; },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
