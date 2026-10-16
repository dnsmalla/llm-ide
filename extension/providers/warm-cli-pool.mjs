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
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { logger } from '../core/logger.mjs';

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

const log = logger.child ? logger.child({ mod: 'warm-cli-pool' }) : logger;

const intEnv = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt; };
const MAX_IDLE      = () => Math.max(0, intEnv('LLMIDE_WARM_CLI_MAX', 1));
const IDLE_MS       = () => intEnv('LLMIDE_WARM_CLI_IDLE_MS', 120_000);
const MIN_FREE      = () => intEnv('LLMIDE_WARM_CLI_MIN_FREE_BYTES', 1024 * 1024 * 1024);

/** key → WarmChild. Idle children only; a child leaves the map on acquire. */
const idle = new Map();
let spawning = false;

function makeChild(spec) {
  const { bin, base, env, cwd, userId } = spec;
  const key = poolKey({ bin, base, env, cwd, userId });
  const child = spawn(bin, warmArgs(base), {
    env, ...(cwd ? { cwd } : {}), stdio: ['pipe', 'pipe', 'pipe'],
  });
  // unref: an idle child must never keep the server alive at shutdown.
  child.unref();
  const entry = { key, bin, child, startedAt: Date.now(), lastUsedAt: Date.now(), stdoutLines: [], stderr: '', exited: null, idleTimer: null, stdoutBytes: 0 };
  // Buffer lines from the start: the CLI may print rate-limit or init lines
  // before the prompt arrives; runWarm scans the buffer first.
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => { entry.stdoutBytes += line.length + 1; entry.stdoutLines.push(line); entry.onLine?.(line); });
  child.stderr.on('data', (d) => { entry.stderr += String(d); });
  child.on('error', (err) => { entry.exited = { code: null, signal: null, error: err }; idle.delete(key); entry.onExit?.(); });
  // 'close', not 'exit': it fires after stdout is drained, so a final large line
  // is seen (and judged against maxBuffer) before the exit is reported.
  child.on('close', (code, signal) => { entry.exited = { code, signal }; idle.delete(key); entry.onExit?.(); });
  return entry;
}

function kill(entry, reason) {
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  try { entry.child.stdin?.destroy(); } catch { /* already closed */ }
  try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
  log.debug?.('warm_cli_killed', { reason });
}

function evictLru() {
  let oldest = null;
  for (const e of idle.values()) if (!oldest || e.lastUsedAt < oldest.lastUsedAt) oldest = e;
  if (oldest) { idle.delete(oldest.key); kill(oldest, 'evict_lru'); }
}

let memCache = { at: 0, value: 0 };
const MEM_CACHE_MS = 30_000;

/** Bytes of memory the OS could hand out without swapping.
 *  WHY: macOS keeps reclaimable file cache in "inactive"/"speculative"/"purgeable",
 *  so os.freemem() reads near zero on a healthy machine and would block every
 *  prewarm. Cached 30 s because vm_stat is a process spawn. Any failure, or a
 *  non-darwin platform, falls back to os.freemem(). */
export function availableMemoryBytes({ platform = process.platform, runVmStat, now = Date.now } = {}) {
  if (platform !== 'darwin') return os.freemem();
  const t = now();
  if (memCache.at && t - memCache.at < MEM_CACHE_MS) return memCache.value;
  try {
    const text = runVmStat ? runVmStat() : execFileSync('vm_stat', { timeout: 2000, encoding: 'utf8' });
    const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
    if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error('no page size');
    let pages = 0;
    for (const label of ['free', 'inactive', 'speculative', 'purgeable']) {
      pages += Number(new RegExp(`Pages ${label}:\\s+(\\d+)\\.`).exec(text)?.[1] || 0);
    }
    memCache = { at: t, value: pages * pageSize };
    return memCache.value;
  } catch {
    return os.freemem();
  }
}

/** Spawn one idle child for `spec` when allowed. Never throws. */
export function prewarm(spec, { now = Date.now, freemem = availableMemoryBytes } = {}) {
  if (!isWarmCliEnabled()) return false;
  if (spawning) return false;
  if (MAX_IDLE() === 0) return false;
  const key = poolKey(spec);
  if (idle.has(key)) return false;
  // WHY: the point is to make chat faster, never to push a swapping machine
  // over the edge. Below the floor the cold path runs — same result, slower.
  if (freemem() < MIN_FREE()) { log.info('warm_cli_skipped_low_memory'); return false; }
  while (idle.size >= MAX_IDLE()) evictLru();
  spawning = true;
  let entry;
  try { entry = makeChild(spec); } catch (err) { spawning = false; log.warn('warm_cli_spawn_failed', { error: err?.message }); return false; }
  spawning = false;
  entry.lastUsedAt = now();
  idle.set(key, entry);
  entry.idleTimer = setTimeout(() => { if (idle.get(key) === entry) { idle.delete(key); kill(entry, 'idle'); } }, IDLE_MS());
  entry.idleTimer.unref?.();
  return true;
}

/** The idle child for `spec`'s key, removed from the pool, or null. A child
 *  that already exited is dropped here so a dead one is never handed out. */
export function acquireWarm(spec) {
  const key = poolKey(spec);
  const entry = idle.get(key);
  if (!entry) return null;
  idle.delete(key);
  if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
  if (entry.exited) return null;
  return entry;
}

function execFileShaped(message, entry, fields) {
  const err = new Error(message);
  err.code = null; err.killed = false; err.signal = null;
  err.stdout = entry.stdoutLines.join('\n'); err.stderr = entry.stderr; err.bin = entry.bin;
  return Object.assign(err, fields);
}

/** Send one prompt to an acquired child and settle like execFile would. */
export function runWarm(entry, prompt, { timeoutMs, signal, maxBuffer = 4 * 1024 * 1024, wantJson }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      entry.onLine = null; entry.onExit = null;
      fn(value);
    };
    const onAbort = () => { kill(entry, 'abort'); finish(reject, Object.assign(execFileShaped('spawnCli: aborted', entry, {}), { name: 'AbortError' })); };
    if (signal?.aborted) { onAbort(); return; }
    if (entry.exited) { finish(reject, execFileShaped('warm cli exited before use', entry, { code: entry.exited.code, signal: entry.exited.signal, warmExitedBeforeUse: true })); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const handleLine = (line) => {
      if (entry.stdoutBytes > maxBuffer) { kill(entry, 'maxbuffer'); finish(reject, execFileShaped('stdout maxBuffer length exceeded', entry, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })); return; }
      let obj; try { obj = JSON.parse(line); } catch { return; }
      if (obj?.type !== 'result' || typeof obj.result !== 'string') return;
      if (obj.is_error === true) {
        // Same as a cold `claude -p` exiting 1 with the message on stdout:
        // formatCliSpawnError / isCliOverloaded read it from there.
        finish(reject, execFileShaped(`Command failed: ${entry.bin}`, entry, { code: 1, stdout: wantJson ? line : obj.result }));
        return;
      }
      finish(resolve, { stdout: wantJson ? line : obj.result, stderr: entry.stderr, bin: entry.bin });
    };
    entry.onLine = handleLine;
    entry.onExit = () => {
      const ex = entry.exited || { code: null, signal: null };
      finish(reject, execFileShaped(`Command failed: ${entry.bin}`, entry, { code: ex.code, signal: ex.signal, killed: false }));
    };
    if (timeoutMs) {
      timer = setTimeout(() => { kill(entry, 'timeout'); finish(reject, execFileShaped('timed out', entry, { killed: true, signal: 'SIGTERM', code: null })); }, timeoutMs);
    }
    // Replay anything already printed (rate-limit lines, a result from a
    // child that answered an empty prompt), then send ours and close stdin —
    // the CLI treats EOF as "no more turns".
    for (const line of entry.stdoutLines) handleLine(line);
    const message = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n';
    entry.child.stdin.write(message, (err) => {
      if (err) { kill(entry, 'write_error'); finish(reject, execFileShaped(err.message, entry, { code: err.code || 'EPIPE' })); return; }
      entry.child.stdin.end();
    });
    entry.child.stdin.on('error', (err) => { kill(entry, 'stdin_error'); finish(reject, execFileShaped(err.message, entry, { code: err.code || 'EPIPE' })); });
  });
}

/** Failures the cold path should retry once: the child was gone or never
 *  answered (nothing was consumed), or it answered "log in" (a stale login in
 *  the idle child; a fresh spawn sees the current one). Overload and timeout
 *  are NOT retried here — runtime.mjs owns that policy. */
export function isWarmRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.killed) return false;
  if (err.warmExitedBeforeUse) return true;
  if (err.code === 'EPIPE') return true;
  if (typeof err.code === 'number' && err.code !== 1) return true;   // died without a result line
  const text = `${err.stdout || ''}\n${err.stderr || ''}`;
  return /not logged in|\/login\b|\b401\b|unauthori[sz]ed/i.test(text);
}

/** Kill every idle child. Called on shutdown, logout, SDK/plugin update and
 *  MCP consent revoke (routes), and when the binary changes. */
export function flushWarmCliPool(reason) {
  for (const entry of idle.values()) kill(entry, reason);
  idle.clear();
}

process.on('exit', () => flushWarmCliPool('process_exit'));

export function _resetMemCacheForTests() { memCache = { at: 0, value: 0 }; }
export function _warmPoolStateForTests() { return { idle: idle.size, spawning }; }
export function _sweepIdleForTests({ now = Date.now } = {}) {
  for (const [key, entry] of idle) {
    if (now() - entry.lastUsedAt > IDLE_MS()) { idle.delete(key); kill(entry, 'idle'); }
  }
}

let binStamp = null;
/** True (and the pool flushed) when the CLI binary's identity changed. */
export function rememberBinStamp(resolvedPath, mtimeMs) {
  const next = `${resolvedPath}:${mtimeMs}`;
  if (binStamp !== null && binStamp !== next) { flushWarmCliPool('bin_changed'); binStamp = next; return true; }
  binStamp = next;
  return false;
}
