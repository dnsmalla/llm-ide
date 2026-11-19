// How many items each Library Extensions group has switched on, for the sidebar's count badges. Read-only: it
// uses the same list calls as the panes. A group whose list cannot be read gets null (no badge), never 0.
import type { ExtensionsApi } from "./api.ts";
import type { LegacyApi } from "./legacy.ts";

export type ExtensionCounts = Readonly<Record<string, number | null>>;

const onCount = async <T>(rows: Promise<readonly T[]>, isOn: (r: T) => boolean): Promise<number | null> => {
  try {
    return (await rows).filter(isOn).length;
  } catch {
    return null;
  }
};

/** Switched-on counts per kind (plugins, llm-sources, mcp-plugins, catalog); `extensions` is their total, the one sidebar entry's count (null when any list could not be read, so a partial total is never shown). */
export async function loadExtensionCounts(legacy: LegacyApi, api: ExtensionsApi, signal?: AbortSignal): Promise<ExtensionCounts> {
  const [plugins, sources, mcp, catalog] = await Promise.all([
    onCount(legacy.plugins(signal), (r) => r.enabled),
    onCount(legacy.llmSources(signal), (r) => r.enabled),
    // An MCP server is on only when it actually loads in chats: switched on, consented, and (for a plugin-declared
    // server) its plugin on — the core's `effective`. An older core without it falls back to enabled + consented.
    onCount(legacy.mcpPlugins(signal), (r) => r.enabled && r.consented && r.effective !== false),
    onCount(api.installed(signal).then((l) => l.items), (r) => r.enabled),
  ]);
  signal?.throwIfAborted();
  const all = [plugins, sources, mcp, catalog];
  const known = all.filter((n): n is number => n !== null);
  return { plugins, "llm-sources": sources, "mcp-plugins": mcp, catalog, extensions: known.length < all.length ? null : known.reduce((a, b) => a + b, 0) };
}
