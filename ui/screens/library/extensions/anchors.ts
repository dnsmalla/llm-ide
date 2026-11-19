// Deep links into the one Extensions entry. Older panes had their own ids (plugins, mcp-plugins, llm-sources); chat
// commands and notices still send them, so each id maps to the entry plus the tab and view it used to be.
import type { LegacyKind } from "./legacy.ts";
import type { Tab } from "./model.ts";

export const EXTENSIONS_ENTRY = "extensions";
export type ExtView = "catalog" | LegacyKind;

const TARGETS: Record<string, { tab: Tab; view: ExtView }> = {
  extensions: { tab: "installed", view: "catalog" },
  plugins: { tab: "installed", view: "plugins" },
  "mcp-plugins": { tab: "installed", view: "mcp-plugins" },
  "llm-sources": { tab: "installed", view: "llm-sources" },
  "extensions:add": { tab: "install", view: "catalog" },
};

/** The tab and view a deep-link anchor selects, or null for an anchor that is not an extensions one. */
export function targetFor(anchor: string | null | undefined): { tab: Tab; view: ExtView } | null {
  return anchor && Object.hasOwn(TARGETS, anchor) ? TARGETS[anchor]! : null;
}

/** The Library entry an anchor opens: every extensions anchor opens the one entry; any other id is its own entry. */
export const entryFor = (anchor: string): string => (targetFor(anchor) ? EXTENSIONS_ENTRY : anchor);
