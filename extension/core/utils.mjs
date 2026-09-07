import { AppError } from './errors.mjs';
import { config } from './config.mjs';

// Default = whatever the operator configured (env LLMIDE_BODY_LIMIT_MB,
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
// Zero-width joiner. Inserted INSIDE a bracket run to break the sentinel
// while leaving the text visually identical.
const FENCE_ZWJ = '‍';

/**
 * Neutralise fence sentinels (`<<<` / `>>>`) in untrusted text.
 *
 * This used to DELETE whole `<<<TOKEN>>>` markers, which was exploitable:
 * `String.replace` makes a single pass and never re-scans its own output, so
 * deleting an INNER marker splices the surrounding characters into a NEW
 * outer one. Both of these round-tripped into live sentinels —
 *
 *   '<<<LLM' + '<<<X>>>' + 'IDE_NOTICE>>>'  →  '<<<LLMIDE_NOTICE>>>'
 *   '<<<E<<<X>>>ND>>>'                      →  '<<<END>>>'
 *
 * — so an attached file or pasted log could close the `<<<BEGIN>>>…<<<END>>>`
 * data fence it is wrapped in (see core/prompt-framing.mjs, embedded in the
 * v2 SYSTEM prompt) and have everything after it read as trusted framing.
 *
 * Neutralising instead of deleting is immune by construction: nothing is
 * removed, so no two fragments can ever be spliced together. This is the same
 * strategy llm_agent/runtime/redaction.mjs has always used for tool-result
 * fences — that module's own header says a change to the redaction strategy
 * "must apply everywhere at once", and this is now the one implementation
 * both share.
 *
 * Note it makes text marginally LONGER (joiners inserted) rather than
 * shorter, which is why callers measuring truncation must measure the
 * neutralised string — that is what actually gets sent.
 *
 * The run is matched WHOLE (`{3,}`) and the joiner interleaved through all of
 * it, rather than rewriting each `<<<` triple. Rewriting triples has the very
 * flaw this function exists to remove, one level up: `replaceAll` consumes
 * non-overlapping matches, so `<<<<<<` becomes `<<␣<` + `<<␣<`, whose middle
 * three characters are a live `<<<` again. Matching the maximal run leaves no
 * two brackets adjacent inside it, and its neighbours are by definition not
 * brackets, so nothing can be reconstituted across the boundary either.
 * Runs of one or two brackets are left alone — they are not sentinels, and
 * `a < b` or a C++ `<<` should survive unmangled.
 */
const FENCE_OPEN_RUN_RE = /<{3,}/g;
const FENCE_CLOSE_RUN_RE = />{3,}/g;
const interleave = (run) => run.split('').join(FENCE_ZWJ);

export function neutralizePromptFences(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(FENCE_OPEN_RUN_RE, interleave)
    .replace(FENCE_CLOSE_RUN_RE, interleave);
}

// The documented product-wide prompt cap. Exported so a caller that needs to
// tell the user (or the model) that truncation happened can compare against
// the same number this enforces, instead of keeping a second copy that drifts
// — the v2 engine kept its own 20k copy and silently cut prompts 25× earlier
// than this.
export const PROMPT_CHAR_CAP = 500_000;

export function sanitizeForPrompt(text) {
  // 1. Neutralise fence sentinels so untrusted text cannot close the fence it
  //    is embedded in (see neutralizePromptFences for the exploit this
  //    replaced).
  // 2. Hard-cap to bound prompt size. NOTE this is silent by design at this
  //    layer — it is a last-resort guard shared by every prompt path. Callers
  //    that can surface truncation should measure the neutralised string
  //    against PROMPT_CHAR_CAP and say so; see llm_agent/sdk/engine.mjs.
  return neutralizePromptFences(text).slice(0, PROMPT_CHAR_CAP);
}

// Hoisted out of `sanitizeLine` so the patterns are compiled once at
// module load instead of being re-evaluated per call.  `sanitizeLine`
// runs per log line and per caption — both per-request-per-row paths —
// so a single shared RegExp object beats relying on the JIT to spot
// the literal-in-hot-function pattern.  Same patterns/flags/behavior
// as the previous inline literals.
 
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
