// Every error text on the Settings screen comes from here. The server's own message is
// never displayed (it can echo provider output or paths); only its code is used.
import { ApiError } from "./core-api.ts";

export interface ErrorContext {
  /** A user-supplied entry (allowlist source, folder) to name in the sentence. */
  entry?: string;
}

const named = (ctx: ErrorContext | undefined, fallback: string): string => (ctx?.entry ? `"${ctx.entry}"` : fallback);

/** Code -> sentence. `ctx.entry` is inserted where a sentence names what the user typed. */
const BY_CODE: Record<string, (ctx?: ErrorContext) => string> = {
  // Agent history
  PREVIEW_EXPIRED: () => "The preview expired, so the history was counted again. Check the new counts before you confirm.",
  PREVIEW_INVALID: () => "The preview no longer matches, so the history was counted again. Check the new counts before you confirm.",
  preview_stale: () => "The history changed after the preview, so it was counted again. Check the new counts before you confirm.",
  busy: () => "A chat turn or meeting-agent run is in progress. Try again when it finishes.",
  BUSY: () => "A chat turn or meeting-agent run is in progress. Try again when it finishes.",
  disk_space: () => "Not enough free disk space to compact the agent history. Free some space and try again.",
  AGENT_STORE_UNAVAILABLE: () => "The agent history store is not available. Restart the backend to reopen it.",
  // Extension allowlist
  INVALID_SOURCE: (c) =>
    `${named(c, "That entry")} is not a valid source. Use owner/repo for one repository or owner/* for everything one owner publishes.`,
  TOO_MANY_SOURCES: () => "You have reached the most sources one account can save. Remove one before adding another.",
  SOURCE_EXCEEDS_CEILING: (c) =>
    `${named(c, "That entry")} is wider than the operator allows. Use owner/repo or owner/* inside the limit shown above; anything wider has to be allowed by the operator on the server.`,
  SOURCE_NOT_ALLOWED: (c) => `${named(c, "That source")} is not on the allowlist, so it cannot be installed. Ask the operator to allow it, or add it to your list if the limit above permits.`,
  // Installs / updates
  COMMIT_NOT_IN_REPO: () => "The pinned commit is not in that repository, so nothing was installed.",
  VERIFY_UNAVAILABLE: () => "The commit could not be verified right now (the host was not reachable). Nothing was installed; try again later.",
  UPDATE_CHANGED: () => "The update changed after you reviewed it. Review it again before you confirm.",
  // Providers and catalog
  CATALOG_DISABLED: () => "The extension catalog is turned off on this server.",
  LIMIT: () => "You have reached the most provider connections one account can have. Remove one first.",
  PROVIDER_BLOCKED: () => "That address is refused by the network guard. Use an https address, or allow a private-network address on purpose.",
  PROVIDER_NOT_CONNECTED: () => "That provider is not connected.",
  PROVIDER_NO_KEY: () => "That provider needs an API key. Enter one and connect again.",
  // Folders
  INVALID_PATH: () => "That folder is too broad to trust as one project. Pick the project folder itself.",
  NOT_FOUND: () => "That item no longer exists. Reload the list.",
  // Generic
  VALIDATION_FAILED: () => "The server did not accept that. Check the values and try again.",
  AUTH_REQUIRED: () => "You are signed out or the session expired. Sign in again.",
  RATE_LIMITED: () => "Too many requests. Wait a moment and try again.",
  FEATURE_DISABLED: () => "That feature is turned off in this build.",
  feature_disabled: () => "That feature is turned off in this build.",
  UNREACHABLE: () => "Could not reach the backend. Check that it is running and try again.",
  ABORTED: () => "The request was cancelled.",
  TIMEOUT: () => "The backend did not answer in time. It may be busy; try again.",
  UNTRUSTED_CORE: () => "This app has not verified the core it is talking to yet. Open the status bar and confirm the core, or restart the app so it starts its own.",
  NO_SESSION: () => "You are not signed in. Sign in again.",
  SESSION_EXPIRED: () => "Your session expired. Sign in again.",
  UNSAFE_URL: () => "The app refused to contact a core that is not on this computer.",
  BAD_RESPONSE: () => "The backend sent an answer this version of the app could not read. Update the app or the backend.",
  BAD_REQUEST: () => "The app built a request it is not allowed to send. Please report this.",
};

const BY_STATUS = (status: number): string => {
  if (status === 401) return BY_CODE.AUTH_REQUIRED!();
  if (status === 403) return "That is not allowed for this account.";
  if (status === 404) return BY_CODE.NOT_FOUND!();
  if (status === 429) return BY_CODE.RATE_LIMITED!();
  if (status >= 500) return "The backend hit an error. Try again, and restart it if this keeps happening.";
  return "The request could not be completed. Check the values and try again.";
};

export const KNOWN_ERROR_CODES: readonly string[] = Object.keys(BY_CODE);

/** Plain sentence for a server code (and status as the fallback for unknown codes). */
export function messageForCode(code: string, status = 0, ctx?: ErrorContext): string {
  const f = BY_CODE[code];
  return f ? f(ctx) : BY_STATUS(status);
}

/** Plain sentence for anything thrown by the API layer. Non-API errors never leak their text. */
export function describeError(e: unknown, ctx?: ErrorContext): string {
  if (e instanceof ApiError) return messageForCode(e.code, e.status, ctx);
  return "Something went wrong. Try again.";
}

/** Codes that mean "the preview you confirmed no longer applies". */
export const STALE_PREVIEW_CODES: ReadonlySet<string> = new Set(["PREVIEW_EXPIRED", "PREVIEW_INVALID", "preview_stale"]);
