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
