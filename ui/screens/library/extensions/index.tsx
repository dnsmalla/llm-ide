// Mount points for the Library's Extensions group. `libraryExtensions(core)` returns the entries the Library
// nav shows (Plugins, LLM Sources, MCP Plugins and the catalog "Extensions") with their renderers; index.tsx of the
// Library only passes this list through `LibraryScreenProps.extensions`.
import "./extensions.css";
import type { ReactNode } from "react";
import type { CoreClient } from "../../shell/core";
import type { LibraryExtension } from "../LibraryNav";
import { createExtensionsApi, type ExtCore, type ExtensionsApi } from "./api.ts";
import { ExtensionsScreen } from "./ExtensionsScreen";
import { createLegacyApi, LegacyScreen } from "./LegacyPane";
import type { LegacyApi } from "./legacy.ts";
import { projectRelativeOf, type LocationReveal } from "./legacy-labels.ts";
import { host as shellHost, invokeHost, projectStore } from "@llmide/screens/shell";
import { publicHttpsUrl } from "../safe-url.ts";
import { loadExtensionCounts, type ExtensionCounts } from "./counts.ts";

/** The shell's core client as the Extensions screen's request function. It keeps error bodies (the screen maps codes). */
export function extCoreFrom(client: Pick<CoreClient, "requestRaw">): ExtCore {
  return {
    async request(method, path, body, opts) {
      const res = await client.requestRaw(path, { method, body, signal: opts.signal, timeoutMs: opts.slow ? 120_000 : 30_000 });
      return { status: res.status, body: res.body };
    },
  };
}

/** Reveal in the file manager: only a source folder inside the open project (the host resolves paths against the project root). */
const projectReveal: LocationReveal = {
  canReveal: (location) => projectRelativeOf(location, projectStore.getSnapshot().project?.root ?? null) !== null,
  reveal: (location) => {
    const rel = projectRelativeOf(location, projectStore.getSnapshot().project?.root ?? null);
    if (rel !== null) void invokeHost("reveal_in_os", { relPath: rel }).catch(() => undefined);
  },
};

/** Opens a catalog repository link through the host (it asks the user once per site). Only public https addresses. */
export function openRepository(url: string): void {
  const safe = publicHttpsUrl(url);
  if (!safe) return;
  if (!shellHost.isAvailable()) {
    window.open(safe, "_blank", "noopener,noreferrer");
    return;
  }
  void invokeHost("open_external_url", { url: safe }).catch(() => undefined);
}

/** The sidebar's switched-on counts, through the same core calls the panes use. */
export function extensionCounter(client: Pick<CoreClient, "requestRaw">): (signal?: AbortSignal) => Promise<ExtensionCounts> {
  const core = extCoreFrom(client);
  const legacy = createLegacyApi(core);
  const api = createExtensionsApi(core);
  return (signal) => loadExtensionCounts(legacy, api, signal);
}

export function libraryExtensions(client: Pick<CoreClient, "requestRaw">, base: readonly LibraryExtension[]): LibraryExtension[] {
  let api: ExtensionsApi | null = null;
  const getApi = (): ExtensionsApi => (api ??= createExtensionsApi(extCoreFrom(client)));
  let legacy: LegacyApi | null = null;
  const getLegacy = (): LegacyApi => (legacy ??= createLegacyApi(extCoreFrom(client)));
  const renderers: Record<string, () => ReactNode> = {
    extensions: () => <ExtensionsScreen api={getApi()} openRepository={openRepository} />,
    plugins: () => <LegacyScreen api={getLegacy()} kind="plugins" />,
    "llm-sources": () => <LegacyScreen api={getLegacy()} kind="llm-sources" revealer={projectReveal} />,
    "mcp-plugins": () => <LegacyScreen api={getLegacy()} kind="mcp-plugins" />,
  };
  return base.map((e) => (renderers[e.id] ? { ...e, render: renderers[e.id] } : e));
}

export { ExtensionsScreen } from "./ExtensionsScreen";
