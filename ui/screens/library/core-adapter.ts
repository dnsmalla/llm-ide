// Adapts the shell's core client (`../shell/core`: owns the base URL, bearer token and refresh) to the
// two small request shapes this screen needs. Type-only import: no runtime dependency on the shell.
// The webview never holds a token here; failures are reduced to an HTTP status.
import type { CoreClient } from "../shell/core";
import type { IndexCore } from "./index-rebuild.ts";
import type { SearchCore } from "./search.ts";

type Req = { status: number; body: unknown };

async function viaClient(client: Pick<CoreClient, "request">, method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal): Promise<Req> {
  try {
    const res = await client.request<unknown>(path, { method, body, signal });
    return { status: 200, body: res };
  } catch (e) {
    if (signal.aborted) throw e; // the caller cancelled: not a core answer
    const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 0;
    if (status === 0) throw e; // transport failure
    return { status, body: {} };
  }
}

export function searchCoreFrom(client: Pick<CoreClient, "request">): SearchCore {
  return { request: (method, path, body, signal) => viaClient(client, method, path, body, signal) };
}

export function indexCoreFrom(client: Pick<CoreClient, "request">): IndexCore {
  return { request: (method, path, body, signal) => viaClient(client, method, path, body, signal) };
}
