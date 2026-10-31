// Adapts the shell's core client (owns the base URL, bearer token and refresh) to the small interfaces the
// write side needs. Type-only import: no runtime dependency on the shell, and no token ever passes through here.
import type { CoreClient } from "../../shell/core";
import type { SummarizeCore } from "../write/resummarize.ts";
import type { SourcesCore } from "./source-core.ts";

export function sourcesCoreFrom(client: Pick<CoreClient, "requestRaw">): SourcesCore {
  return {
    call: (method, path, body, signal, timeoutMs) => client.requestRaw(path, { method, body, signal, ...(timeoutMs ? { timeoutMs } : null) }),
  };
}

/** Summarising can take minutes: the server's own ceiling is 3 minutes, so wait a little longer than that. */
export const SUMMARIZE_TIMEOUT_MS = 200_000;

export function summarizeCoreFrom(client: Pick<CoreClient, "requestRaw">): SummarizeCore {
  return { summarize: (body, signal) => client.requestRaw("/kb/summarize", { method: "POST", body, signal, timeoutMs: SUMMARIZE_TIMEOUT_MS }) };
}
