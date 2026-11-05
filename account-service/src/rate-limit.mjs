import { HttpError } from './http.mjs';

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

// shortcut: in-memory fixed windows for the one service process; counters reset on restart.
// Move to a SQLite table if the service ever runs more than one process.
export function createRateLimiter({ now = Date.now, maxKeys = 100_000 } = {}) {
  const windows = new Map();
  function sweep(t) {
    for (const [key, w] of windows) if (t >= w.resetAt) windows.delete(key);
    if (windows.size >= maxKeys) windows.clear();
  }
  return {
    hit(key, limit, windowMs) {
      const t = now();
      let w = windows.get(key);
      if (!w || t >= w.resetAt) {
        if (windows.size >= maxKeys) sweep(t);
        w = { count: 0, resetAt: t + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count > limit) {
        throw new HttpError(429, 'rate_limited', { 'retry-after': String(Math.max(1, Math.ceil((w.resetAt - t) / 1000))) });
      }
    },
  };
}

// Caps mail to one address across every route (sign-up and recovery), so the service
// cannot be used to flood someone's inbox.
export function limitMailTo(limiter, email) {
  limiter.hit(`mail-hour:${email}`, 3, HOUR);
  limiter.hit(`mail-day:${email}`, 10, DAY);
}
