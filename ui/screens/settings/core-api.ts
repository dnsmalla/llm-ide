// The page's only door to the Node core: a request function injected by the shell
// (S-A's core client owns the base URL, the bearer token and the nonce check). This
// module never sees a token and never builds a URL from user input.

export interface CoreResponse {
  status: number;
  body: unknown;
}

export interface CoreClient {
  request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<CoreResponse>;
}

/** A refusal or failure. `code` is the server's error code (or a local one), never shown raw. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, details?: Record<string, unknown>) {
    // The server's own message is deliberately not kept: UI text comes from errors.ts.
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Error envelope: `{ error: { code, message?, details? } }`. Anything else becomes a status-only error. */
export function toApiError(res: CoreResponse): ApiError {
  const env = isRecord(res.body) ? res.body.error : undefined;
  if (isRecord(env) && typeof env.code === "string") {
    return new ApiError(res.status, env.code, isRecord(env.details) ? env.details : undefined);
  }
  if (typeof env === "string") return new ApiError(res.status, env);
  return new ApiError(res.status, `HTTP_${res.status}`);
}

/** Runs a request; non-2xx throws ApiError, a transport failure throws ApiError(0, "UNREACHABLE"). */
export async function call(client: CoreClient, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: CoreResponse;
  try {
    res = await client.request(method, path, body, signal);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (signal?.aborted) throw new ApiError(0, "ABORTED");
    throw new ApiError(0, "UNREACHABLE");
  }
  if (res.status < 200 || res.status >= 300) throw toApiError(res);
  return res.body;
}
