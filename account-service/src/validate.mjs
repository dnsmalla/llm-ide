import { HttpError } from './http.mjs';

const TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_email');
  const email = value.trim().toLowerCase();
  // Exactly one bare mailbox. Reject display-name/mailbox-list syntax (<>, comma, semicolon, colon, quote)
  // and whitespace/control characters: nodemailer parses those to a different envelope recipient, which
  // would bypass the per-address mail cap and send mail from our domain to arbitrary addresses.
  if (email.length > 254 || /[<>\s,;:\"\u0000-\u001f\u007f]/.test(email)) throw new HttpError(400, 'invalid_email');
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) throw new HttpError(400, 'invalid_email');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new HttpError(400, 'invalid_email');
  }
  if (domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    throw new HttpError(400, 'invalid_email');
  }
  return email;
}

export function displayName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_display_name');
  const name = value.trim();
  if (name.length < 1 || name.length > 80 || /\p{Cc}/u.test(name)) throw new HttpError(400, 'invalid_display_name');
  return name;
}

export function language(value) {
  if (typeof value !== 'string' || value.length > 35 || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
    throw new HttpError(400, 'invalid_language');
  }
  return value;
}

export function timeZone(value) {
  if (typeof value !== 'string' || !TIME_ZONES.has(value)) throw new HttpError(400, 'invalid_time_zone');
  return value;
}

export function deviceLabel(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_label');
  const label = value.trim();
  if (label.length < 1 || label.length > 80 || /\p{Cc}/u.test(label)) throw new HttpError(400, 'invalid_label');
  return label;
}

// Public keys are opaque text (base64url SPKI or PEM, per relay 4.2); the service never parses
// them, it only bounds them and rejects control characters other than PEM line breaks.
export function publicKeyText(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_key');
  const key = value.trim();
  if (key.length < 32 || key.length > 8192 || !/^[\x20-\x7e\r\n\t]+$/.test(key)) throw new HttpError(400, 'invalid_key');
  return key;
}

// Closed request objects, as in Host API v1: an unknown field is an error, not ignored.
export function onlyKeys(body, allowed) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, 'invalid_payload');
}
