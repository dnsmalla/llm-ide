// How many items each Library Extensions group has switched on, for the sidebar's count badges. Read-only: it
// uses the same list calls as the panes. A group whose list cannot be read gets null (no badge), never 0.
import type { ExtensionsApi } from "./api.ts";
import type { LegacyApi } from "./legacy.ts";

export type ExtensionCounts = Readonly<Record<string, number | null>>;

const enabledCount = async (rows: Promise<readonly { enabled: boolean }[]>): Promise<number | null> => {
  try {
    return (await rows).filter((r) => r.enabled).length;
  } catch {
    return null;
  }
};

/** Switched-on counts keyed by the Library extension ids (plugins, llm-sources, mcp-plugins, extensions). */
export async function loadExtensionCounts(legacy: LegacyApi, api: ExtensionsApi, signal?: AbortSignal): Promise<ExtensionCounts> {
  const [plugins, sources, mcp, catalog] = await Promise.all([
    enabledCount(legacy.plugins(signal)),
    enabledCount(legacy.llmSources(signal)),
    enabledCount(legacy.mcpPlugins(signal)),
    enabledCount(api.installed(signal).then((l) => l.items)),
  ]);
  signal?.throwIfAborted();
  return { plugins, "llm-sources": sources, "mcp-plugins": mcp, extensions: catalog };
}
