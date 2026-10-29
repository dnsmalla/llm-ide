/**
 * /code-assist's error envelope. A provider-config refusal (runtime.mjs tags
 * it PROVIDER_UNAVAILABLE: the named provider is missing/disabled/keyless) is
 * the caller's choice, not an upstream fault, so it is a 400 with the code and
 * its Settings hint kept — the Mac's tier-routed replay retries once without
 * the route on exactly this code. Everything else stays the generic 502:
 * internal paths, model names and CLI details never leak to clients (the full
 * error is logged server-side by the caller). Exported for tests.
 */
export function codeAssistErrorResponse(err) {
  if (err?.code === 'PROVIDER_UNAVAILABLE') {
    return { status: 400, body: { error: { code: 'PROVIDER_UNAVAILABLE', message: String(err.message || '') } } };
  }
  return {
    status: 502,
    body: { error: { code: 'INTERNAL_ERROR', message: 'The assistant is temporarily unavailable. Please try again.' } },
  };
}
