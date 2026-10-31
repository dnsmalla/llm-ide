// Typed client for the Rust `project_search_*` commands (desktop/src-tauri/src/project_search.rs).
// The webview sends a query and relative globs / file names only; results stream back on a Tauri Channel
// created by a desktop-side module (`@tauri-apps/api` is not resolvable from `ui/screens`).
import { invokeHost } from "../../shell/host";
import { toFsError } from "../fs";
import type { WireEvent } from "./model";

export interface SearchRequest {
  query: string;
  regex: boolean;
  case_sensitive: boolean;
  whole_word: boolean;
  include: string[];
  exclude: string[];
  only_paths: string[] | null;
  include_hidden: boolean;
  use_ignore: boolean;
}

export interface SearchApi {
  /** Starts a search; events (carrying the returned id) arrive on `onEvent`, possibly before this resolves. */
  start(req: SearchRequest, onEvent: (e: WireEvent) => void): Promise<{ id: number }>;
  cancel(id: number): Promise<void>;
}

/** `channelFactory` builds the Tauri Channel (desktop/src/search/searchBridge.ts), loaded lazily. */
export function createHostSearch(channelFactory: (cb: (e: WireEvent) => void) => unknown | Promise<unknown>): SearchApi {
  return {
    async start(req, onEvent) {
      try {
        const ch = await channelFactory(onEvent);
        return await invokeHost<{ id: number }>("project_search_start", { req, onEvent: ch });
      } catch (e) {
        throw toFsError(e);
      }
    },
    cancel: (id) => invokeHost<void>("project_search_cancel", { id }).then(() => undefined, () => undefined),
  };
}
