// Self-Heal incident rules (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md), ported from the retired Mac
// app (IncidentRedactor, IncidentSignature, IncidentClassifier). Pure: no I/O, no DB. Incident text is data, never
// instructions: nothing in plan A hands it to a model, logs it or sends it anywhere.
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { redactSecretsForStorage } from './redact-secrets.mjs';

export const INCIDENT_SOURCES = Object.freeze(['ui', 'log', 'crash', 'server']);
export const INCIDENT_STATUSES = Object.freeze(['new', 'fixing', 'proposed', 'ignored', 'needsHuman', 'fixed']);
/** The category of a report the user made from Chat (`/self-heal`): they attest it is an app problem. */
export const USER_REPORT_CATEGORY = 'chat report';
export const MAX_MESSAGE = 2000;
export const MAX_STACK = 8000;
export const MAX_CATEGORY = 200;
// Raw input is cut before the regexes run, so a huge field cannot make redaction slow.
const RAW_MAX = 50_000;

const KEY_VALUE = /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|passwd))(["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The Mac redactor: shared secret shapes, JWTs, `name=value` secrets, emails, the home folder; then the cap. */
export function redactIncidentText(text, limit, home = homedir()) {
  let out = redactSecretsForStorage(String(text ?? '').slice(0, RAW_MAX));
  out = out.replace(JWT, '[REDACTED]').replace(KEY_VALUE, '$1$2[REDACTED]').replace(EMAIL, '[EMAIL]');
  if (home && home.length > 1) out = out.split(home).join('~');
  return out.length > limit ? `${out.slice(0, limit)}…[truncated]` : out;
}

// Order matters: quoted strings and UUIDs before the hex and number rules eat their parts.
const RULES = [
  [/"[^"\n]*"|'[^'\n]*'/g, '<str>'],
  [/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g, '<uuid>'],
  [/(?<![A-Za-z0-9])(?:~\/|\/)[^\s"':,()]+/g, '<path>'],
  [/\b[0-9A-Fa-f]{8,}\b/g, '<hex>'],
  [/\b\d+(?:\.\d+)?\b/g, '<n>'],
  [/\s+/g, ' '],
];

export function normalizeIncidentText(text) {
  let out = String(text ?? '');
  for (const [re, template] of RULES) out = out.replace(re, template);
  return out.trim();
}

const OWN = ['extension/', 'desktop/', 'ui/'];

/** The first stack line that is our code (the extension core, the desktop host or the desktop UI). */
export function topOwnFrame(stack) {
  if (!stack) return null;
  return String(stack).split('\n').map((l) => l.trim())
    .find((l) => !l.includes('node_modules') && OWN.some((o) => l.includes(o))) ?? null;
}

/** Two reports with the same signature are the same incident. */
export function incidentSignature({ source, category, message, stack }) {
  const frame = topOwnFrame(stack);
  const material = [source, category, normalizeIncidentText(message), frame ? normalizeIncidentText(frame) : ''].join('\0');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

// Environment problems, not app bugs (plan B never sends them to the fix agent). The Mac's NSURLErrorDomain needles
// are replaced by the Node error codes; the Loop verdict and configuration phrases are kept verbatim.
const ENV_RULES = [
  ['offline', ['appears to be offline', 'could not connect to the server', 'network connection was lost', 'the request timed out',
    'fetch failed', 'econnrefused', 'enotfound', 'etimedout', 'econnreset']],
  ['auth', ['http 401', 'http 403', 'status 401', 'status 403', 'unauthorized', 'forbidden', 'not signed in']],
  ['permission', ['operation not permitted', 'permission denied', 'eperm', 'eacces']],
  ['disk', ['no space left on device', 'enospc']],
  ['refactor loop', ['failed and does not allow repair', 'to fall; it did not', 'structure regressed:', 'graph not regenerated (']],
  ['configuration', ['has no runnable command', 'has no skill chosen', 'has no checks configured', 'needs a newer version of llm-ide']],
  ['cancelled', ['request was cancelled', 'operation was cancelled', 'cancellationerror', 'cancelled by user', 'user cancelled',
    'the operation was aborted', 'aborterror']],
];

export function environmentalReason(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.startsWith('usage:') || text.includes('no model matching')) return 'usage';
  return ENV_RULES.find(([, needles]) => needles.some((n) => text.includes(n)))?.[0] ?? null;
}

/** A report as stored: validated, redacted, capped, signed, classified. `null` for anything unusable. */
export function cleanIncident(input, home = homedir()) {
  if (!input || typeof input !== 'object') return null;
  const { source, category, message, stack } = input;
  if (!INCIDENT_SOURCES.includes(source)) return null;
  if (typeof category !== 'string' || typeof message !== 'string') return null;
  if (stack != null && typeof stack !== 'string') return null;
  const cat = redactIncidentText(category.trim(), MAX_CATEGORY, home);
  const msg = redactIncidentText(message.trim(), MAX_MESSAGE, home);
  if (!cat || !msg.trim()) return null;
  const stk = stack ? redactIncidentText(stack, MAX_STACK, home) : null;
  const clean = { source, category: cat, message: msg, stack: stk || null };
  // A user's own report is never filtered as an environment problem: their words may mention a timeout or a permission.
  return { id: incidentSignature(clean), ...clean, environmental: cat === USER_REPORT_CATEGORY && source === 'ui' ? null : environmentalReason(msg) };
}
