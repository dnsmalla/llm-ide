// Tiny structured logger.  Writes one JSON object per line to stdout in
// production, a colorized human form in dev.  Designed to be drop-in
// for console.log-style call sites.
//
// Why JSON-per-line: it's the lingua franca for log aggregation (Loki,
// Datadog, even `jq | grep`).  Why not pino/winston: those bring a
// transitive-dep tree we don't need for a localhost server, and one
// of the project's stated values is "zero deps for the HTTP layer."

import { randomBytes } from 'crypto';
import { appendFileSync, statSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const isPretty = process.stdout.isTTY && !process.env.LLMIDE_LOG_JSON;
const minLevel = LEVELS[(process.env.LLMIDE_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

// File sink for warn+ lines. The Mac app supervises the Node server and only
// captures its stdout/stderr in an in-memory buffer — when the server crashes
// (uncaught_exception → process.exit(1)) that buffer is the ONLY record, and
// it's invisible outside the running app. Persisting warn/error to disk makes
// an intermittent backend crash diagnosable after the fact.
//
// Writes are SYNCHRONOUS on purpose: the uncaught-exception handler logs and
// then immediately process.exit(1)s, so an async/streamed write would never
// flush. appendFileSync guarantees the crash line hits disk before we exit.
//
// Default path sits next to the dev DB under <repo>/kb/. Override with
// LLMIDE_LOG_FILE=<path>, or LLMIDE_LOG_FILE='' / 'none' to disable.
const MAX_LOG_BYTES = 2 * 1024 * 1024; // rotate (single .old) past 2 MB
const FILE_MIN_LEVEL = LEVELS.warn;    // only persist warn + error
const logFilePath = resolveLogFile();
let _fileBytes = initialLogSize(logFilePath);

function resolveLogFile() {
  const env = process.env.LLMIDE_LOG_FILE;
  if (env !== undefined) {
    const t = env.trim();
    return (t === '' || t.toLowerCase() === 'none') ? null : t;
  }
  // core/logger.mjs → repo root is one dir up from core/.
  try {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    return join(root, 'kb', 'server.log');
  } catch {
    return null;
  }
}

function initialLogSize(file) {
  if (!file) return 0;
  try { return statSync(file).size; } catch { return 0; }
}

// Append one already-formatted line to the log file, rotating once past the
// cap. Fully best-effort — a logging failure must never break the server, so
// every fs op is guarded and a failure just disables the sink for this line.
function writeToFile(line) {
  if (!logFilePath) return;
  try {
    if (_fileBytes > MAX_LOG_BYTES) {
      try { renameSync(logFilePath, `${logFilePath}.old`); } catch { /* ignore */ }
      _fileBytes = 0;
    }
    if (_fileBytes === 0) {
      try { mkdirSync(dirname(logFilePath), { recursive: true }); } catch { /* ignore */ }
    }
    appendFileSync(logFilePath, line);
    _fileBytes += Buffer.byteLength(line);
  } catch { /* sink disabled for this line — never throw from logging */ }
}

const COLORS = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info:  '\x1b[32m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
};

function format(level, msg, fields) {
  const ts = new Date().toISOString();
  if (!isPretty) {
    return JSON.stringify({ ts, level, msg, ...(fields || {}) }) + '\n';
  }
  const c = COLORS[level] || '';
  const parts = [`${COLORS.dim}${ts}${COLORS.reset}`, `${c}${level.padEnd(5)}${COLORS.reset}`, msg];
  if (fields) {
    const trimmed = { ...fields };
    if (trimmed.requestId) parts.push(`${COLORS.dim}[${trimmed.requestId}]${COLORS.reset}`);
    delete trimmed.requestId;
    const rest = Object.keys(trimmed);
    if (rest.length > 0) {
      parts.push(`${COLORS.dim}${JSON.stringify(trimmed)}${COLORS.reset}`);
    }
  }
  return parts.join(' ') + '\n';
}

function log(level, msg, fields) {
  const lvl = LEVELS[level];
  // Persist warn+ to the on-disk crash log ALWAYS — independent of the console
  // minLevel — so a crash line survives even if the console is quieted, and is
  // readable after the supervising app exits. Always JSON so it stays greppable.
  if (lvl >= FILE_MIN_LEVEL) {
    writeToFile(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields || {}) }) + '\n');
  }
  if (lvl < minLevel) return;
  const stream = lvl >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(format(level, msg, fields));
}

export const logger = {
  trace: (msg, fields) => log('trace', msg, fields),
  debug: (msg, fields) => log('debug', msg, fields),
  info:  (msg, fields) => log('info',  msg, fields),
  warn:  (msg, fields) => log('warn',  msg, fields),
  error: (msg, fields) => log('error', msg, fields),
  child: (bound) => ({
    trace: (msg, fields) => log('trace', msg, { ...bound, ...(fields || {}) }),
    debug: (msg, fields) => log('debug', msg, { ...bound, ...(fields || {}) }),
    info:  (msg, fields) => log('info',  msg, { ...bound, ...(fields || {}) }),
    warn:  (msg, fields) => log('warn',  msg, { ...bound, ...(fields || {}) }),
    error: (msg, fields) => log('error', msg, { ...bound, ...(fields || {}) }),
  }),
};

export function newRequestId() {
  // Short request IDs — long enough to disambiguate a busy minute,
  // short enough to fit cleanly in log lines.  Encoded base16 so they
  // survive being grep'd without escape tricks.
  return randomBytes(6).toString('hex');
}
