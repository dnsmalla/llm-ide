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
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
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
const RESPAWN_DELAY = () => intEnv('LLMIDE_WARM_CLI_RESPAWN_DELAY_MS', 15_000);
const EXIT_GRACE    = () => intEnv('LLMIDE_WARM_CLI_EXIT_GRACE_MS', 10_000);

const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

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
  // WHY: unref'd pipes too — a one-shot script that imports providers must be
  // able to exit with an idle child around (acquireWarm re-refs on hand-out).
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.unref?.();
  const entry = { key, bin, child, startedAt: Date.now(), lastUsedAt: Date.now(), stdoutLines: [], stderr: '', exited: null, idleTimer: null, graceTimer: null, stdoutBytes: 0, stderrBytes: 0, overflowed: false };
  // WHY: output is buffered from spawn until the answer, so a chatty idle child
  // (or one huge line with no newline, which readline also buffers) must be
  // capped here, not only when runWarm happens to look.
  const overflow = (reason) => {
    if (entry.overflowed) return;
    entry.overflowed = true;
    // Guarded: only remove OUR slot, never a newer entry that took the same key.
    if (idle.get(key) === entry) idle.delete(key);
    kill(entry, reason);
    entry.onOverflow?.();
  };
  child.stdout.on('data', (chunk) => {
    entry.stdoutBytes += chunk.length;
    if (entry.stdoutBytes > OUTPUT_CAP_BYTES) overflow('stdout_cap');
  });
  // Buffer lines from the start: the CLI may print rate-limit or init lines
  // before the prompt arrives; runWarm scans the buffer first.
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => { if (entry.overflowed) return; entry.stdoutLines.push(line); entry.onLine?.(line); });
  child.stderr.on('data', (d) => {
    if (entry.overflowed) return;
    entry.stderrBytes += Buffer.byteLength(d);
    if (entry.stderrBytes > OUTPUT_CAP_BYTES) { overflow('stderr_cap'); return; }
    entry.stderr += String(d);
  });
  // Guarded for the same reason as in overflow(): a finished child that was
  // already acquired must not unseat a replacement prewarmed for the same key.
  child.on('error', (err) => { entry.exited = { code: null, signal: null, error: err }; if (idle.get(key) === entry) idle.delete(key); entry.onExit?.(); });
  // 'close', not 'exit': it fires after stdout is drained, so a final large line
  // is seen (and judged against maxBuffer) before the exit is reported.
  child.on('close', (code, signal) => { if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; } entry.exited = { code, signal }; if (idle.get(key) === entry) idle.delete(key); entry.onExit?.(); });
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

/** value null = the last probe failed (cached too, so a broken vm_stat is not
 *  retried on every call); readers then fall back to os.freemem(). */
let memCache = { at: 0, value: null };
const MEM_CACHE_MS = 30_000;

/** Reclaimable bytes from `vm_stat` text. Throws when it cannot be parsed.
 *  Only FILE-backed inactive pages are counted: anonymous inactive pages need
 *  compression or swap before they can be reused, so they are not free. */
function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error('no page size');
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)\\.`).exec(text)?.[1] || 0);
  const inactive = pages('Pages inactive');
  const fileLine = /File-backed pages:\s+(\d+)\./.exec(text);
  const reclaimableInactive = fileLine ? Math.min(inactive, Number(fileLine[1])) : inactive;
  return (pages('Pages free') + pages('Pages speculative') + pages('Pages purgeable') + reclaimableInactive) * pageSize;
}

const vmStatAsync = () => new Promise((resolve, reject) => {
  execFile('vm_stat', { timeout: 2000, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** Bytes of memory the OS could hand out without swapping.
 *  WHY: macOS keeps reclaimable file cache in "inactive"/"speculative"/"purgeable",
 *  so os.freemem() reads near zero on a healthy machine and would block every
 *  prewarm. Never spawns vm_stat itself unless `runVmStat` is injected: it reads
 *  the cache that `refreshMemoryProbe` fills off the event loop. Any failure, a
 *  missing cache, or a non-darwin platform falls back to os.freemem(). */
export function availableMemoryBytes({ platform = process.platform, runVmStat, now = Date.now } = {}) {
  if (platform !== 'darwin') return os.freemem();
  const t = now();
  const fresh = memCache.at && t - memCache.at < MEM_CACHE_MS;
  if (fresh || !runVmStat) return memCache.value ?? os.freemem();
  try {
    memCache = { at: t, value: parseVmStat(runVmStat()) };
  } catch {
    memCache = { at: t, value: null };
  }
  return memCache.value ?? os.freemem();
}

/** Fill the memory cache without blocking the event loop (30 s, failures too). */
export async function refreshMemoryProbe({ platform = process.platform, runVmStatAsync = vmStatAsync, now = Date.now } = {}) {
  if (platform !== 'darwin') return;
  const t = now();
  if (memCache.at && t - memCache.at < MEM_CACHE_MS) return;
  try {
    memCache = { at: t, value: parseVmStat(await runVmStatAsync()) };
  } catch {
    memCache = { at: t, value: null };
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
  // WHY: with one slot, two users would otherwise evict each other every turn
  // and spawn a child nobody uses. A slot used within IDLE_MS is not ours to take.
  if (idle.size >= MAX_IDLE()) {
    let oldest = null;
    for (const e of idle.values()) if (!oldest || e.lastUsedAt < oldest.lastUsedAt) oldest = e;
    if (oldest && now() - oldest.lastUsedAt < IDLE_MS()) return false;
  }
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
  if (entry.exited || entry.overflowed) return null;
  entry.child.ref();
  for (const pipe of [entry.child.stdin, entry.child.stdout, entry.child.stderr]) pipe?.ref?.();
  return entry;
}

/** After an answer the CLI should exit by itself; if teardown hangs, reap it so
 *  a stuck process never lingers (~220 MB each). */
function armExitGrace(entry) {
  if (entry.exited || entry.graceTimer) return;
  entry.graceTimer = setTimeout(() => { entry.graceTimer = null; if (!entry.exited) kill(entry, 'exit_grace'); }, EXIT_GRACE());
  entry.graceTimer.unref?.();
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
      entry.onLine = null; entry.onExit = null; entry.onOverflow = null;
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
        armExitGrace(entry);
        return;
      }
      finish(resolve, { stdout: wantJson ? line : obj.result, stderr: entry.stderr, bin: entry.bin });
      armExitGrace(entry);
    };
    entry.onOverflow = () => finish(reject, execFileShaped('stdout maxBuffer length exceeded', entry, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
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

let respawnTimer = null;
let flushGeneration = 0;

/** Respawn the idle child after use, but not right away: the classifier call
 *  ends just as the main chat turn starts its own `claude`, and a second CLI
 *  start at that moment slows the turn the user is waiting on. One pending
 *  timer at most; `generation` voids it if a flush happened since the call began. */
function scheduleRespawn(spec, generation) {
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = setTimeout(async () => {
    respawnTimer = null;
    try {
      await refreshMemoryProbe();
      if (generation === flushGeneration) prewarm(spec);
    } catch (err) {
      log.warn('warm_cli_respawn_failed', { error: err?.message });
    }
  }, RESPAWN_DELAY());
  respawnTimer.unref?.();
}

/** Kill every idle child. Called on shutdown, logout, SDK/plugin update and
 *  MCP consent revoke (routes), and when the binary changes. */
export function flushWarmCliPool(reason) {
  // WHY: a respawn landing right after a logout/SDK-update flush would undo it.
  flushGeneration++;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  for (const entry of idle.values()) kill(entry, reason);
  idle.clear();
}

process.on('exit', () => flushWarmCliPool('process_exit'));

export function _resetMemCacheForTests() { memCache = { at: 0, value: null }; }
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

/** Resolve `bin` on PATH (absolute paths as-is). Null when not found. */
function resolveBin(bin, env) {
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  for (const dir of String(env?.PATH || process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, bin);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

/**
 * The warm branch of spawnCli: use an idle child for this exact call when
 * there is one, else run `cold()`; either way leave one idle child behind
 * for the next identical call. `cold` is spawnCli's own execFile promise
 * factory, so result shapes are the cold path's by construction.
 */
export async function spawnWithWarm({ bin, args, env, cwd, userId, timeoutMs, signal, cold, withSlot = (fn) => fn() }) {
  const split = splitPromptArgs(args);
  if (!split) return cold();
  const resolved = resolveBin(bin, env);
  if (resolved) {
    try { rememberBinStamp(resolved, fs.statSync(resolved).mtimeMs); } catch { /* unreadable → treat as unchanged */ }
  }
  const generation = flushGeneration;
  const spec = { bin, base: split.base, env, cwd, userId };
  // Computed BEFORE acquireWarm: nothing may throw between acquiring an idle
  // child and handing it to runWarm (which kills it on failure).
  const wantJson = split.base.includes('--output-format') && split.base[split.base.indexOf('--output-format') + 1] === 'json';
  const entry = acquireWarm(spec);
  let result;
  try {
    if (entry) {
      try {
        // withSlot wraps ONLY the warm answer; cold() below takes its own slot.
        result = await withSlot(() => runWarm(entry, split.prompt, { timeoutMs, signal, wantJson }));
      } catch (err) {
        if (!isWarmRetryable(err)) throw err;
        log.info('warm_cli_retry_cold', { code: err.code ?? null });
        result = await cold();
      }
    } else {
      result = await cold();
    }
  } finally {
    // Respawn after every use (the classifier runs every turn), delayed.
    // prewarm itself refuses when disabled, full, or memory is low.
    if (isWarmCliEnabled()) scheduleRespawn(spec, generation);
  }
  return result;
}
export const _spawnWithWarmForTests = spawnWithWarm;
