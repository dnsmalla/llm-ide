/**
 * Warm CLI pool: ONE pre-spawned `claude` child for the mode classifier.
 *
 * WHY: on subscription installs every classifier call is a `claude -p` spawn,
 * and ~5 s of its ~10 s is process start/exit, serial before every auto-mode
 * chat turn. A child started with `--input-format stream-json` waits on stdin
 * without the 3 s give-up of plain `-p`, so the prompt can be sent later
 * (spike 2026-10-09: 6–10 s → 2.6–3.5 s).
 *
 * Scope is deliberately tiny (spec 2026-10-09, narrowed 2026-10-16): only
 * callers passing `warm: true` (the classifier), at most one idle child,
 * killed after 2 min idle, never spawned when free memory is low. One child
 * answers exactly one prompt. The pool lives in this process's memory only:
 * the server is a single process by design (kb/db.mjs).
 *
 * Layer: providers (L2). Routes call `flushWarmCliPool()`; this file never
 * imports a route.
 */
import crypto from 'node:crypto';

const STREAM_FLAGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

/** `{ base, prompt }` when argv ends in `-p <prompt>`, else null (any other
 *  shape is not ours to pre-spawn — it runs cold, unchanged). */
export function splitPromptArgs(args) {
  if (!Array.isArray(args) || args.length < 2) return null;
  if (args[args.length - 2] !== '-p') return null;
  return { base: args.slice(0, -2), prompt: args[args.length - 1] };
}

/** The idle child's argv: `base` without `--output-format json`, plus the
 *  stream-json flags. The result line carries the same fields as the json
 *  output, so callers that asked for json get it rebuilt (`runWarm`). */
export function warmArgs(base) {
  const out = [];
  for (let i = 0; i < base.length; i++) {
    if (base[i] === '--output-format' && base[i + 1] === 'json') { i++; continue; }
    out.push(base[i]);
  }
  return [...out, ...STREAM_FLAGS];
}

/** Opaque identity of "a call with exactly these inputs". Env is sorted so
 *  key order cannot split the pool; the hash is the only thing ever kept or
 *  logged (env may hold an API key, argv may hold MCP tokens). */
export function poolKey({ bin, base, env, cwd, userId }) {
  const envEntries = Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const material = JSON.stringify([bin, base, envEntries, cwd || '', userId || '']);
  return crypto.createHash('sha256').update(material).digest('hex');
}

export function isWarmCliEnabled(env = process.env) {
  if (env.LLMIDE_WARM_CLI === '0') return false;
  if (env.NODE_ENV === 'test') return env.LLMIDE_WARM_CLI === '1';
  return true;
}
