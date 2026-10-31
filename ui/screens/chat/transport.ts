// What the Chat screen needs from the Node core, as an interface. The shell's core client (S-A,
// `ui/screens/shell/core.ts`) implements it: it owns the base URL and the bearer token, which the
// webview never sees. Until it lands, tests use fakes and the app wires an adapter at the call site.

export class CoreHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "CoreHttpError";
  }
}

export interface CoreTransport {
  /** JSON request. Rejects with CoreHttpError on a non-2xx answer; honours `signal`. */
  json<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  /**
   * POST that answers with an SSE body: yields the `data:` payload of each complete event (the framing is the
   * transport's job: the shell client's SseDecoder). A non-2xx answer rejects BEFORE the first payload
   * (validation, 409 TURN_IN_PROGRESS, 402 cap...).
   */
  stream(path: string, body: unknown, signal: AbortSignal): AsyncIterable<string>;
}

/** An HTTP-shaped error from any client (our CoreHttpError or the shell's CoreError): duck-typed, no import. */
export function httpLike(err: unknown): { status: number; code: string; message: string } | null {
  if (err instanceof Error) {
    const e = err as Error & { status?: unknown; code?: unknown };
    if (typeof e.status === "number" && typeof e.code === "string") return { status: e.status, code: e.code, message: e.message };
  }
  return null;
}

/** Errors a UI maps to a short human sentence. `status` 0 is a transport failure (shell CoreError). */
export function describeError(err: unknown): { code: string; message: string; retryable: boolean } {
  const h = httpLike(err);
  if (h) {
    if (h.code === "ABORTED") return { code: "ABORTED", message: "Cancelled", retryable: false };
    if (h.status === 0) return { code: h.code === "NETWORK" || h.code === "TIMEOUT" ? "CORE_UNREACHABLE" : h.code, message: h.message, retryable: h.code !== "UNSAFE_URL" && h.code !== "BAD_REQUEST" };
    const retryable = h.status === 409 || h.status === 429 || h.status === 503 || h.status >= 500;
    return { code: h.code, message: h.message, retryable };
  }
  if (err instanceof Error && err.name === "AbortError") return { code: "ABORTED", message: "Cancelled", retryable: false };
  return { code: "CORE_UNREACHABLE", message: err instanceof Error ? err.message : "Cannot reach the local core", retryable: true };
}
