// Host API v1 frame codec for the desktop host — the Node twin of SharedProtocol's HostApiFrame.swift.
// Same refusal codes and message templates, so the Mac and desktop hosts answer the same frames alike.
// Messages name schema paths (clamped, possibly a frame key), never a value.
import { randomUUID } from 'node:crypto';
import { validate } from '../bus/schema-validate.mjs';
import { HOST_API_COMMANDS, HOST_API_ENVELOPE, HOST_API_EVENTS, HOST_API_LIMITS, HOST_API_SCHEMAS } from './commands.generated.mjs';

const defs = HOST_API_ENVELOPE.$defs;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODES = new Set(['auth_failed', 'capability_unavailable', 'unknown_command', 'invalid_payload', 'not_found', 'busy', 'denied', 'desktop_only', 'rate_limited', 'host_unreachable', 'internal']);

export function clamp(s, maxUnits) {
  if (s.length <= maxUnits) return s;
  let out = '';
  for (const cp of s) {
    if (out.length + cp.length > maxUnits) break;
    out += cp;
  }
  return out;
}

const fail = (replyTo, code, message) => ({ ok: false, replyTo, code, message });
const internal = (message) => Object.assign(new Error(message), { code: 'internal' });

export function parseRequest(text) {
  if (Buffer.byteLength(text, 'utf8') > HOST_API_LIMITS.maxFrameBytes) return fail(null, 'invalid_payload', 'The frame is larger than 1 MiB.');
  let obj;
  try { obj = JSON.parse(text); } catch { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail(null, 'invalid_payload', 'The frame is not a JSON object.');
  const replyTo = typeof obj.id === 'string' && ID_RE.test(obj.id) ? obj.id : null;
  const env = validate(defs.Request, obj, { defs });
  if (env.length) return fail(replyTo, 'invalid_payload', `The frame does not match the Host API envelope (${clamp(env[0].path, 80)}).`);
  if (!Object.hasOwn(HOST_API_COMMANDS, obj.command)) return fail(replyTo, 'unknown_command', 'This host does not serve that command.');
  const payload = obj.payload ?? {};
  const bad = validate(HOST_API_SCHEMAS[obj.command].request, payload, { defs });
  if (bad.length) return fail(replyTo, 'invalid_payload', `The payload does not match ${obj.command} (${clamp(bad[0].path, 80)}).`);
  if (!replyTo) return fail(null, 'invalid_payload', 'The frame does not match the Host API envelope (.id).');
  return { ok: true, id: replyTo, command: obj.command, payload };
}

function finish(frame, def) {
  const errs = validate(defs[def], frame, { defs });
  if (errs.length) throw internal(`The host built an invalid ${def} frame (${errs[0].path}).`);
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') > HOST_API_LIMITS.maxFrameBytes) throw internal('The host built a frame larger than 1 MiB.');
  return text;
}

export function response(replyTo, command, result, rev, now = Date.now()) {
  const errs = validate(HOST_API_SCHEMAS[command].result, result, { defs });
  if (errs.length) throw internal(`The host built an invalid ${command} result (${errs[0].path}).`);
  return finish({ apiVersion: 1, id: `h-${randomUUID()}`, replyTo, type: 'response', command, result, ts: now, rev }, 'Response');
}

export function event(command, payload, rev, replyTo = null, now = Date.now()) {
  const frame = { apiVersion: 1, id: `h-${randomUUID()}`, type: 'event', command, payload, ts: now, rev };
  if (replyTo) frame.replyTo = replyTo;
  const errs = validate(HOST_API_EVENTS, frame, { defs });
  if (errs.length) throw internal(`The host built an invalid ${command} event (${errs[0].path}).`);
  return finish(frame, 'Event');
}

export function errorFrame({ replyTo, code, message, retryable, retryAfterMs, hint, rev, now = Date.now() }) {
  const error = { code: CODES.has(code) ? code : 'internal', message: clamp(message || 'The host could not handle this request.', 500), retryable: !!retryable };
  const details = {};
  if (retryAfterMs != null) details.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs));
  if (hint) details.hint = clamp(hint, 500);
  if (Object.keys(details).length) error.details = details;
  const frame = { apiVersion: 1, id: `h-${randomUUID()}`, type: 'error', error, ts: now, rev: Math.max(0, rev | 0) };
  if (replyTo && ID_RE.test(replyTo)) frame.replyTo = replyTo;
  return JSON.stringify(frame);
}
