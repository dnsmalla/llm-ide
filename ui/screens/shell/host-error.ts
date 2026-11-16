// The text and code of an error the desktop host rejected with. Local commands reject with a string (CommandError);
// SSH-mode project commands reject with `{ code, message }` (FsError). Every reader takes both the same way, so the
// host's message is never lost to a generic fallback.

/** The host's message: a string, an Error's message, or a `{ message }` object. Empty when there is none. */
export function hostErrorText(e: unknown): string {
  if (typeof e === "string") return e.trim();
  if (e instanceof Error) return e.message.trim();
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message.trim();
  }
  return "";
}

/** The host's error code from a `{ code }` object, or "" when the error has none. */
export function hostErrorCode(e: unknown): string {
  if (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return "";
}
