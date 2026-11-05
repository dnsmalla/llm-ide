import { HttpError } from './http.mjs';

const TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_email');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid_email');
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

// Closed request objects, as in Host API v1: an unknown field is an error, not ignored.
export function onlyKeys(body, allowed) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, 'invalid_payload');
}
