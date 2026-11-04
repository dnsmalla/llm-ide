// Host API v1 pairing PIN (desktop host): minted by the desktop UI for the signed-in user, one use,
// 10 minutes, one live PIN per user. In memory only: a core restart retires every PIN.
import { randomInt, timingSafeEqual } from 'node:crypto';

export const PIN_TTL_MS = 600_000;
const pins = new Map(); // userId -> { pin, expiresAt }

export function mintPin(userId, now = Date.now()) {
  pins.delete(userId);
  let pin;
  do pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  while ([...pins.values()].some((e) => e.pin === pin)); // a PIN must identify one user
  const entry = { pin, expiresAt: now + PIN_TTL_MS };
  pins.set(userId, entry);
  return { ...entry };
}

export function consumePin(pin, now = Date.now()) {
  if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) return null;
  let match = null;
  for (const [userId, e] of pins) {
    if (e.expiresAt < now) { pins.delete(userId); continue; }
    if (timingSafeEqual(Buffer.from(e.pin), Buffer.from(pin))) match = userId;
  }
  if (match !== null) pins.delete(match);
  return match;
}

export function __resetPinsForTest() { pins.clear(); }
