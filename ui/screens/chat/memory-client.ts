// The memory viewer (explorer/memory) talks to the core through a CoreClient, which resolves to { status, body }.
// The chat only has the CoreTransport, which resolves to the body and rejects on a non-2xx answer. This adapter
// bridges the two: a resolved body is a 200, and a refusal keeps rejecting so the viewer shows its own error text.
import type { CoreClient } from "../settings/core-api.ts";
import type { CoreTransport } from "./transport";

export function memoryClient(core: CoreTransport): CoreClient {
  return {
    async request(method, path, body, signal) {
      const payload = await core.json<unknown>(method, path, body, signal);
      return { status: 200, body: payload };
    },
  };
}
