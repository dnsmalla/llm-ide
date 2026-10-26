// Turns a server error body into a message for `new Error(...)`.
//
// The server answers errors as `{ error: { code, message } }`. Older routes
// answer `{ error: "text" }`. A plain object here would stringify to
// "[object Object]", so the object form is read through its `message`.
//
// `fallback` is the site's own wording for a body with no usable message;
// it defaults to `Server error: <status>` (or `Server error` with no status).
export function errorText(
  body: unknown,
  status?: number,
  fallback?: string,
): string {
  const defaultFallback = status === undefined ? 'Server error' : `Server error: ${status}`;
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback ?? defaultFallback;
}
