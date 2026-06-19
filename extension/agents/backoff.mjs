// Shared retry/backoff primitives. runtime.mjs (Anthropic path) and
// providers.mjs (OpenAI/Google path) and the dispatcher all use the same
// jittered exponential backoff — keep it in one place so the policy can't
// drift between them.

// attempt 1 → 2 (after ~1s), attempt 2 → 3 (after ~3s): 3 attempts total.
export const RETRY_DELAYS_MS = [1_000, 3_000];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ±25% jitter so concurrent retries from many callers don't thundering-herd.
export function jittered(ms) {
  const factor = 0.75 + Math.random() * 0.5;
  return Math.round(ms * factor);
}
