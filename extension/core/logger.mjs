// Tiny structured logger.  Writes one JSON object per line to stdout in
// production, a colorized human form in dev.  Designed to be drop-in
// for console.log-style call sites.
//
// Why JSON-per-line: it's the lingua franca for log aggregation (Loki,
// Datadog, even `jq | grep`).  Why not pino/winston: those bring a
// transitive-dep tree we don't need for a localhost server, and one
// of the project's stated values is "zero deps for the HTTP layer."

import { randomBytes } from 'crypto';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const isPretty = process.stdout.isTTY && !process.env.MEETNOTES_LOG_JSON;
const minLevel = LEVELS[(process.env.MEETNOTES_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

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
  if (LEVELS[level] < minLevel) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
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
