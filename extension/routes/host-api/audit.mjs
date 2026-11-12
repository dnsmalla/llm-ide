// Host API v1 audit sink (Plan 6 Task 8): rows go to the existing audit_log as `host_api.<event>` (90-day purge
// already runs). Event names are shared with the Mac's HostApiV1AuditLog.swift. Never pass a token, PIN, key or
// frame text: the detail is a short reason only, clamped to AUDIT_DETAIL_MAX characters.
import { getDb } from '../../kb/db.mjs';
import { recordAudit } from '../../server/audit.mjs';
import { logger } from '../../core/logger.mjs';
import { peerKey } from './throttle.mjs';

export const AUDIT_DEDUPE_WINDOW_MS = 60_000;
export const AUDIT_DETAIL_MAX = 200;
/** Hard ceiling per event type, across all peers, per AUDIT_DEDUPE_WINDOW_MS: a flood past it is counted, not written. */
export const AUDIT_EVENT_CAP_PER_MINUTE = 60;
const MAX_DEDUPE_KEYS = 1024;
const SUCCESS = new Set(['pair_ok', 'revoke_self', 'revoke_host', 'identity_created', 'identity_reset', 'chat_options', 'chat_new', 'compose_send', 'loop_start', 'loop_cancel', 'push_register', 'push_unregister', 'push_apns_set', 'push_apns_removed', 'session_replaced']);
const DENIED = new Set(['origin_refused', 'plaintext_refused', 'scope_denied', 'role_denied', 'project_denied']);

export const auditOutcome = (event) => (SUCCESS.has(event) ? 'success' : DENIED.has(event) ? 'denied' : 'failure');

export function createAuditSink({ db = getDb(), log = () => {}, now = Date.now } = {}) {
  const lastWrite = new Map(); // `${event}\0${dedupeKey}` -> ms
  const windows = new Map();   // event -> { start, rows, dropped }
  const write = (event, { peer, userId, deviceId, clientName, detail }) => {
    try {
      recordAudit(db, {
        userId, ip: peer, userAgent: clientName, action: `host_api.${event}`, resource: deviceId,
        outcome: auditOutcome(event), detail: detail ? { reason: String(detail).slice(0, AUDIT_DETAIL_MAX) } : undefined,
      });
    } catch (e) { log(`Host API v1 audit ${event} not written (${e?.code ?? 'error'})`); return; }
    log(`Host API v1 audit ${event} from ${peer ?? '-'}`);
  };
  // true when this event type still has room in its window. The summary of a closed window is written lazily, by
  // the first record of that event after it (shortcut: no timer; a flood that stops leaves its count unwritten until then).
  const admit = (event, t) => {
    let w = windows.get(event);
    if (!w || t - w.start >= AUDIT_DEDUPE_WINDOW_MS) {
      if (w?.dropped) write(`${event}_suppressed`, { detail: `${w.dropped} more ${event} rows dropped in one minute` });
      w = { start: t, rows: 0, dropped: 0 };
      windows.set(event, w);
    }
    if (w.rows >= AUDIT_EVENT_CAP_PER_MINUTE) { w.dropped += 1; return false; }
    w.rows += 1;
    return true;
  };
  return {
    record(event, fields = {}) {
      const t = now();
      if (fields.dedupeKey != null) {
        const key = `${event}\0${fields.dedupeKey}`;
        if (t - (lastWrite.get(key) ?? -Infinity) < AUDIT_DEDUPE_WINDOW_MS) return;
        if (lastWrite.size >= MAX_DEDUPE_KEYS) {
          for (const [k, v] of lastWrite) if (t - v >= AUDIT_DEDUPE_WINDOW_MS) lastWrite.delete(k);
          if (lastWrite.size >= MAX_DEDUPE_KEYS) lastWrite.clear(); // the per-event cap still bounds the rows
        }
        lastWrite.set(key, t);
      }
      if (admit(event, t)) write(event, fields);
    },
  };
}

/** The listener's onRefused(event, peer, detail): de-duplicated per peer (IPv6 per /64), never per origin, so a
 *  new Origin on each upgrade cannot write a row each. */
export const listenerRefusalAuditor = (sink) => (event, peer, detail) =>
  sink.record(event, { peer, detail: detail || undefined, dedupeKey: peerKey(peer) });

/** The identity's onEvent: identity_created / identity_reset, host-side (no peer). */
export const identityEventAuditor = (sink) => (event) => sink.record(event, {});

let shared = null;
/** One sink per process, shared by the listener wiring and the host-only revoke route (which runs listener or not). */
export const sharedAuditSink = () => (shared ??= createAuditSink({ log: (l) => logger.info(l) }));
