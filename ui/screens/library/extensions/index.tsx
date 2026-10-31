// Mount points for the Library's Extensions group. `libraryExtensions(core)` returns the entries the Library
// nav shows (Plugins, LLM Sources, MCP Plugins and the catalog "Extensions") with their renderers; index.tsx of the
// Library only passes this list through `LibraryScreenProps.extensions`.
import "./extensions.css";
import type { ReactNode } from "react";
import type { CoreClient } from "../../shell/core";
import type { LibraryExtension } from "../LibraryNav";
import { createExtensionsApi, type ExtCore, type ExtensionsApi } from "./api.ts";
import { ExtensionsScreen } from "./ExtensionsScreen";

/** The shell's core client as the Extensions screen's request function. It keeps error bodies (the screen maps codes). */
export function extCoreFrom(client: Pick<CoreClient, "requestRaw">): ExtCore {
  return {
    async request(method, path, body, opts) {
      const res = await client.requestRaw(path, { method, body, signal: opts.signal, timeoutMs: opts.slow ? 120_000 : 30_000 });
      return { status: res.status, body: res.body };
    },
  };
}

export function libraryExtensions(client: Pick<CoreClient, "requestRaw">, base: readonly LibraryExtension[]): LibraryExtension[] {
  let api: ExtensionsApi | null = null;
  const getApi = (): ExtensionsApi => (api ??= createExtensionsApi(extCoreFrom(client)));
  const renderers: Record<string, () => ReactNode> = {
    extensions: () => <ExtensionsScreen api={getApi()} />,
  };
  return base.map((e) => (renderers[e.id] ? { ...e, render: renderers[e.id] } : e));
}

export { ExtensionsScreen } from "./ExtensionsScreen";
