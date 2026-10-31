// Adapts the shell's core client (`ui/screens/shell/core.ts`: owns the base URL, bearer token and refresh)
// to the CoreTransport the chat screen needs. Type-only import: no runtime dependency on the shell.
import type { CoreClient } from "../shell/core";
import type { CoreTransport } from "./transport";

export function coreTransportFrom(client: CoreClient): CoreTransport {
  return {
    json: <T,>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, signal?: AbortSignal) =>
      client.request<T>(path, { method, body, signal }),
    async *stream(path, body, signal) {
      for await (const ev of client.stream(path, { method: "POST", body, signal })) yield ev.data;
    },
  };
}
