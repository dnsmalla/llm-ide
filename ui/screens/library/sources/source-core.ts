// Typed access to the core's source routes (secrets vault, email/slack/box/mcp connectors, connector catalog,
// repo allow-list) and the mapping of every failure to a code the UI words itself. Pure apart from the injected
// `SourcesCore`; the real one wraps the shell's core client (adapter.ts), which holds the token.
//
// Secret handling: secret VALUES only ever travel in the body of `POST /auth/me/secrets` (and, for a one-off
// "test this typed value", in the body of the test route). They are never returned by any route, never kept in
// state after the request, never logged. The server's own error text is not shown; only our wording plus the
// server's error CODE (a short constant such as `BOX_CONNECT_FAILED`) for support.

export interface SourcesCore {
  /** Resolves with the HTTP status and decoded body for any answer; throws only on transport failure/abort/timeout. */
  call(method: "GET" | "POST" | "DELETE", path: string, body: unknown, signal: AbortSignal, timeoutMs?: number): Promise<{ status: number; body: unknown }>;
}

export type SourceErrorCode =
  | "unauthorized"
  | "validation"
  | "no_secret"
  | "not_approved"
  | "upstream_auth"
  | "upstream"
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "feature_disabled"
  | "cancelled"
  | "failed";

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  /** The server's error code constant (never its message), for support. */
  readonly serverCode: string | null;
  constructor(code: SourceErrorCode, serverCode: string | null = null) {
    super(code);
    this.name = "SourceError";
    this.code = code;
    this.serverCode = serverCode;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function envelopeCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return isRecord(body) && typeof body.error === "string" ? body.error.slice(0, 64) : null;
  return typeof body.error.code === "string" ? body.error.code.slice(0, 64) : null;
}

/** Maps an HTTP failure (status + body) to a `SourceError`. */
export function mapFailure(status: number, body: unknown): SourceError {
  const sc = envelopeCode(body);
  if (sc === "feature_disabled") return new SourceError("feature_disabled", sc);
  if (sc === "PATH_NOT_APPROVED") return new SourceError("not_approved", sc);
  if (sc && /NO_SECRET$/.test(sc)) return new SourceError("no_secret", sc);
  if (sc === "MCP_UNAUTHORIZED" || (sc && /(_AUTH_FAILED|_AUTH_EXPIRED)$/.test(sc))) return new SourceError("upstream_auth", sc);
  if (status === 401 || status === 403) return new SourceError("unauthorized", sc);
  if (status === 429) return new SourceError("rate_limited", sc);
  if (status === 408 || status === 504) return new SourceError("timeout", sc);
  if (status === 400 || status === 422) return new SourceError("validation", sc);
  if (status === 502 || status === 503) return new SourceError("upstream", sc);
  return new SourceError("failed", sc);
}

/** Maps a thrown transport error (or an abort) to a `SourceError`. */
export function mapThrown(e: unknown, signal?: AbortSignal): SourceError {
  if (e instanceof SourceError) return e;
  if (signal?.aborted) return new SourceError("cancelled");
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ABORTED") return new SourceError("cancelled");
  if (code === "TIMEOUT") return new SourceError("timeout");
  if (code === "NO_SESSION" || code === "SESSION_EXPIRED") return new SourceError("unauthorized");
  return new SourceError("unavailable");
}

export function sourceErrorText(code: SourceErrorCode, what = "the source"): string {
  switch (code) {
    case "unauthorized":
      return "Sign in to the core again, then retry.";
    case "validation":
      return `The core rejected these settings for ${what}. Check the fields above.`;
    case "no_secret":
      return `No credential is saved for ${what} yet. Save it first.`;
    case "not_approved":
      return "That folder is not on your approved repository list. Add it first.";
    case "upstream_auth":
      return `Signing in to ${what} failed or expired. Check the credential, or sign in again.`;
    case "upstream":
      return `${what} could not be reached or refused the request. Nothing was imported from this attempt.`;
    case "timeout":
      return "This took too long. The server may still be working; check again in a moment. Nothing was lost.";
    case "rate_limited":
      return "Too many requests right now. Wait a moment and try again.";
    case "unavailable":
      return "The core is not reachable. Nothing was changed.";
    case "feature_disabled":
      return "This feature is switched off in this build of the core.";
    case "cancelled":
      return "Stopped. Anything already saved is kept; nothing is half-written.";
    default:
      return "That did not work. Nothing was changed.";
  }
}

/** Calls the core and returns the body of a 2xx answer; any other outcome throws a `SourceError`. */
export async function callOk<T = unknown>(core: SourcesCore, method: "GET" | "POST" | "DELETE", path: string, body: unknown, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await core.call(method, path, body, signal, timeoutMs);
  } catch (e) {
    throw mapThrown(e, signal);
  }
  if (signal.aborted) throw new SourceError("cancelled");
  if (res.status < 200 || res.status >= 300) throw mapFailure(res.status, res.body);
  return res.body as T;
}

// ---- secrets vault ---------------------------------------------------------------------------

/** The vault keys the source panes may write (a subset of the server's allow-list). */
export const SOURCE_SECRET_KEYS = ["email.imapPassword", "slack.botToken", "slack.userToken", "box.clientSecret"] as const;
export type SourceSecretKey = (typeof SOURCE_SECRET_KEYS)[number];

/** Which vault keys are present (names only; values are never returned by the core). */
export async function listSecretKeys(core: SourcesCore, signal: AbortSignal): Promise<Set<string>> {
  const body = await callOk<unknown>(core, "GET", "/auth/me/secrets", undefined, signal);
  const out = new Set<string>();
  const list = isRecord(body) && Array.isArray(body.secrets) ? body.secrets : [];
  for (const s of list) if (isRecord(s) && typeof s.key === "string") out.add(s.key);
  return out;
}

export function isSourceSecretKey(k: string): k is SourceSecretKey {
  return (SOURCE_SECRET_KEYS as readonly string[]).includes(k);
}

/** Writes (or, with `null`, deletes) one vault secret. The value is passed straight through and not retained. */
export async function saveSecret(core: SourcesCore, key: SourceSecretKey, value: string | null, signal: AbortSignal): Promise<void> {
  if (!isSourceSecretKey(key)) throw new SourceError("validation");
  await callOk(core, "POST", "/auth/me/secrets", { key, value: value ?? "" }, signal);
}

/** Link state shown on each pane: from the vault keys plus whether the (non-secret) config exists. */
export type LinkState = "linked" | "credentials_needed" | "not_configured";

export function linkState(configured: boolean, keys: ReadonlySet<string>, secretKeys: readonly string[]): LinkState {
  if (!configured) return "not_configured";
  return secretKeys.some((k) => keys.has(k)) ? "linked" : "credentials_needed";
}

export function linkStateText(s: LinkState): string {
  return s === "linked" ? "Connected" : s === "credentials_needed" ? "Credentials needed" : "Not set up";
}
