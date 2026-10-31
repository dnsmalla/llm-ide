// Error envelope handling and the user text for every known error code of the Extensions routes.
// The server's own message is never shown for a known code (the text below is the contract), and for an
// unknown code only the code itself is shown, cleaned: a hostile or odd answer cannot put its words on screen.
import { cleanText } from "./sanitize.ts";

export interface ExtResponse {
  status: number;
  body: unknown;
}

/** A refusal or failure. `code` is the server's error code or a local one (UNREACHABLE, ABORTED, BAD_RESPONSE). */
export class ExtApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, details?: Record<string, unknown>) {
    super(`${status} ${code}`);
    this.name = "ExtApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ error: { code, message?, details? } }`, a bare `{ error: "CODE" }`, or a status-only error. */
export function toExtApiError(res: ExtResponse): ExtApiError {
  const env = isRec(res.body) ? res.body.error : undefined;
  if (isRec(env) && typeof env.code === "string") return new ExtApiError(res.status, cleanText(env.code, 60), isRec(env.details) ? env.details : undefined);
  if (typeof env === "string") return new ExtApiError(res.status, cleanText(env, 60));
  return new ExtApiError(res.status, `HTTP_${res.status}`);
}

export const KNOWN_CODES = [
  "CATALOG_DISABLED",
  "SOURCE_NOT_ALLOWED",
  "SOURCE_BLOCKED",
  "SOURCE_EXCEEDS_CEILING",
  "ALREADY_INSTALLED",
  "ALREADY_CURRENT",
  "MARKETPLACE",
  "NOTHING_INSTALLABLE",
  "BUSY",
  "BYTES_MISSING",
  "IDENTITY_CHANGED",
  "NO_PREVIOUS",
  "PREVIOUS_UNAVAILABLE",
  "INTEGRITY_MISMATCH",
  "CONSENT_REQUIRED",
  "UPSTREAM",
  "COMMIT_NOT_IN_REPO",
  "VERIFY_UNAVAILABLE",
  "UPDATE_CHANGED",
  "INVALID_REF",
  "INVALID_COMMIT",
  "INVALID_URL",
  "INVALID_PATH",
  "STATE_UNREADABLE",
  "TOO_LARGE",
  "UNSAFE_PATH",
  "BAD_ARCHIVE",
  "VALIDATION_FAILED",
  "NOT_FOUND",
] as const;

/** Rate limited: the core answers 429 (any code). */
export const isRateLimited = (e: ExtApiError): boolean => e.status === 429 || e.code === "RATE_LIMITED";

/** Codes after which "try again" is a sensible single button (nothing was changed). */
export function isRetryable(e: ExtApiError): boolean {
  return e.code === "VERIFY_UNAVAILABLE" || e.code === "UPSTREAM" || e.code === "UNREACHABLE" || isRateLimited(e);
}

export function extErrorText(e: ExtApiError): string {
  if (e.status === 401 || e.code === "AUTH_REQUIRED") return "Your session has ended. Sign in again.";
  if (isRateLimited(e)) return "Too many requests to GitHub or the registry in a short time. Wait a minute, then try again. Nothing was changed.";
  switch (e.code) {
    case "CATALOG_DISABLED":
      return "The extension catalog is turned off on this server (LLMIDE_EXT_CATALOG=off). Installing, updating and refreshing are unavailable until it is turned on.";
    case "SOURCE_NOT_ALLOWED":
      return "This source is not on the allowed list. Add owner/repo (or owner/*) in Settings under Extension sources, then try again. If Settings refuses it, the operator's limit does not cover it and the operator has to allow it on the server.";
    case "SOURCE_BLOCKED":
      return "This source is blocked and cannot be installed.";
    case "SOURCE_EXCEEDS_CEILING":
      return "That source pattern is wider than the operator allows. Use owner/repo or owner/*.";
    case "ALREADY_INSTALLED":
      return "This item is already installed at another commit. Use Update instead of installing it again.";
    case "ALREADY_CURRENT":
      return "Already up to date.";
    case "MARKETPLACE":
      return "That repository is a marketplace, not a single extension. Pick one entry from the Browse tab, or enter the folder of one entry.";
    case "NOTHING_INSTALLABLE":
      return "Nothing installable was found there (no skill, plugin or MCP entry).";
    case "BUSY":
      return "Another change to this item is in progress. Try again in a moment.";
    case "BYTES_MISSING":
      return "The stored files for this item are missing or damaged. Run Repair first.";
    case "IDENTITY_CHANGED":
      return "The new commit describes a different item than the one installed, so it was refused.";
    case "NO_PREVIOUS":
      return "There is no previous version to roll back to.";
    case "PREVIOUS_UNAVAILABLE":
      return "The previous version's files are missing or damaged, so rollback is not possible. Update again instead.";
    case "INTEGRITY_MISMATCH":
      return "The re-downloaded files do not match the recorded fingerprint, so nothing was overwritten.";
    case "CONSENT_REQUIRED":
      return "This item can run code. Consent to each kind first.";
    case "UPSTREAM":
      return "GitHub could not be reached or answered with an error. Nothing was changed. Try again later.";
    case "COMMIT_NOT_IN_REPO":
      return "That commit is not on the repository's default branch or the named ref, so it was refused.";
    case "VERIFY_UNAVAILABLE":
      return "GitHub could not confirm that commit right now. Nothing was changed. Try again in a minute.";
    case "UPDATE_CHANGED":
      return "That update changed while you were reviewing it. Review it again.";
    case "INVALID_REF":
      return "That branch or tag name is not valid.";
    case "INVALID_COMMIT":
      return "That commit id is not valid (it must be 40 hexadecimal characters).";
    case "INVALID_URL":
      return "Use a https://github.com/<owner>/<repo> address.";
    case "INVALID_PATH":
      return "That folder inside the repository is not valid.";
    case "STATE_UNREADABLE":
      return "The installed record could not be read, so nothing was changed.";
    case "TOO_LARGE":
      return "That repository is larger than the install limits allow.";
    case "UNSAFE_PATH":
      return "That repository contains file paths that are not allowed, so it was refused.";
    case "BAD_ARCHIVE":
      return "The downloaded archive could not be read, so nothing was installed.";
    case "VALIDATION_FAILED":
      return "The request was not accepted. Check the values and try again.";
    case "NOT_FOUND":
      return "Not found. It may have been removed or changed. Refresh the list.";
    case "UNREACHABLE":
      return "The local core could not be reached. Check that it is running, then try again.";
    case "ABORTED":
      return "Cancelled.";
    case "BAD_RESPONSE":
      return "The core answered in a form this screen does not understand, so nothing was shown.";
  }
  if (e.status === 403) return "That is not allowed.";
  const code = cleanText(e.code, 40);
  return code ? `Request failed (${code}).` : "Request failed.";
}

export const errorText = (e: unknown): string => (e instanceof ExtApiError ? extErrorText(e) : "Something went wrong.");
export const errorCode = (e: unknown): string | null => (e instanceof ExtApiError ? e.code : null);
