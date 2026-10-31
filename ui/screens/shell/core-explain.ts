// Turns the generic NETWORK error into the real reason when the core is not usable. The core client only
// knows "the request failed"; the shell knows the core's status, so screens ask this helper for the text.
//
//   import { describeCoreError } from "@llmide/screens/shell";
//   catch (e) { setError(describeCoreError(e, "Could not load notes.")); }
//
// Plain text only: it names a status word, never a path, URL, token or server text.
import type { CoreStatus } from "./host";

/** The status word to show when the core cannot serve requests, or `null` when it can. */
export function coreNotReadyReason(status: CoreStatus | null): string | null {
  if (!status) return "unknown";
  if (status.state !== "ready") return status.state;
  if (status.trust !== "spawned") return status.trust; // `pending` | `adopted_unverified`
  return null;
}

/**
 * Pure form. A NETWORK `CoreError` becomes "The core is not ready (status: X). See the status bar." while the last
 * known status says the core is not usable; every other error keeps its own message (or `fallback`).
 */
export function describeCoreErrorFor(e: unknown, status: CoreStatus | null, fallback = "Something went wrong."): string {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  const message = e instanceof Error && e.message ? e.message : fallback;
  if (code === "NETWORK") {
    const reason = coreNotReadyReason(status);
    if (reason !== null) return `The core is not ready (status: ${reason}). See the status bar.`;
  }
  return message;
}

/** Plain sentences for the shell's own transport codes (never server text). `null` for a code that is not one of them. */
export function sentenceForCoreCode(code: string, status: CoreStatus | null): string | null {
  switch (code) {
    case "NETWORK": {
      const reason = coreNotReadyReason(status);
      return reason !== null ? `The core is not ready (status: ${reason}). See the status bar.` : "Could not reach the core. It may be restarting; try again.";
    }
    case "TIMEOUT":
      return "The core did not answer in time. It may be busy; try again.";
    case "UNTRUSTED_CORE":
      return "This app has not verified the core it is talking to yet. Confirm it from the status bar, or restart the app so it starts its own core.";
    case "NO_SESSION":
      return "You are not signed in. Sign in again.";
    case "SESSION_EXPIRED":
      return "Your session expired. Sign in again.";
    case "UNSAFE_URL":
      return "The app refused to contact a core that is not on this computer.";
    case "BAD_RESPONSE":
      return "The core sent an answer this version of the app could not read.";
    case "BAD_REQUEST":
      return "The app built a request it is not allowed to send.";
    default:
      return null;
  }
}

/**
 * Pure form of `explainCoreError`: a shell transport failure (NETWORK, TIMEOUT, UNTRUSTED_CORE, NO_SESSION, ...) gets its
 * own plain sentence so the real cause is never flattened into "unreachable"; an abort is `null` (stay silent); any other
 * error keeps its own message, or `fallback`.
 */
export function explainCoreErrorFor(e: unknown, status: CoreStatus | null, fallback = "Something went wrong."): string | null {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code === "ABORTED" || (e instanceof Error && e.name === "AbortError")) return null;
  if (typeof code === "string") {
    const s = sentenceForCoreCode(code, status);
    if (s !== null) return s;
  }
  return e instanceof Error && e.message ? e.message : fallback;
}
