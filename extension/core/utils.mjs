import { AppError } from './errors.mjs';
import { config } from './config.mjs';

// Default = whatever the operator configured (env MEETNOTES_BODY_LIMIT_MB,
// fallback in config.mjs).  Callers can pass a smaller cap explicitly
// (e.g. /auth routes use their own value).  Single source of truth — the
// older 2-MB-vs-8-MB split between server.mjs and config.mjs is gone.
const DEFAULT_BODY_LIMIT = config.bodyLimitMB * 1024 * 1024;
// Slow-client DoS protection: a stalled or trickle-fed upload would
// otherwise pin an event-loop handler indefinitely.  60 s is generous
// for a 2-MB body even on bad networks.
const READ_TIMEOUT_MS = 60_000;

export function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    // Accumulate chunks as Buffers and join once at the end with
    // Buffer.concat().toString().  String concatenation (`body += chunk`)
    // reallocates an ever-growing string on every chunk — for an 8 MB
    // body that means ~16 MB peak live allocation before the old string
    // is GC'd.  Buffer accumulation copies only once.
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn) => (...a) => { if (settled) return; settled = true; clearTimeout(timer); fn(...a); };
    const timer = setTimeout(finish(() => {
      // Pause incoming data rather than destroying the socket — we
      // still want the route handler's catch to write a 408 response
      // before the connection closes. Node will drain the keep-alive
      // body afterwards.
      try { req.pause(); } catch { /* ignore */ }
      reject(new AppError('VALIDATION_FAILED', 'Request body read timed out', { status: 408 }));
    }), READ_TIMEOUT_MS);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Same reasoning as the timeout above: req.destroy() also
        // tears down the response half of the socket, so the route
        // handler's catch can't write the 413 envelope — client sees
        // a half-open connection with no status line. req.pause()
        // stops body consumption while leaving `res` writable.
        try { req.pause(); } catch { /* ignore */ }
        finish(reject)(new AppError('VALIDATION_FAILED', 'Request body too large', { status: 413 }));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', finish(reject));
    req.on('close', () => {
      if (!settled) finish(reject)(new Error('Request closed before body complete'));
    });
  });
}

export function parseJSON(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Fence-marker regex compiled once.  The server wraps user-supplied
// content in <<<BEGIN>>>…<<<END>>> delimiters in every LLM prompt so
// the model knows where the safe zone ends.  If the content itself
// contains these exact strings, a crafted transcript could "close"
// the fence early and inject arbitrary instructions after it.
// Stripping them here is the server-side defence; the loader and
// skill-loader already do the same for plugin content.
const PROMPT_FENCE_RE = /<<<[A-Z_]+>>>/g;

export function sanitizeForPrompt(text) {
  if (typeof text !== 'string') return '';
  // 1. Remove fence markers that could break out of <<<BEGIN>>>…<<<END>>> blocks.
  // 2. Hard-cap at 500 k chars to bound prompt size.
  return text.replace(PROMPT_FENCE_RE, '').slice(0, 500_000);
}

// Hoisted out of `sanitizeLine` so the patterns are compiled once at
// module load instead of being re-evaluated per call.  `sanitizeLine`
// runs per log line and per caption — both per-request-per-row paths —
// so a single shared RegExp object beats relying on the JIT to spot
// the literal-in-hot-function pattern.  Same patterns/flags/behavior
// as the previous inline literals.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
const WHITESPACE_RUN_RE = /\s+/g;

export function sanitizeLine(text, maxLen = 120) {
  if (typeof text !== 'string') return '';
  return text
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(WHITESPACE_RUN_RE, ' ')
    .trim()
    .slice(0, maxLen);
}

export function sendJSON(res, statusCode, data) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
