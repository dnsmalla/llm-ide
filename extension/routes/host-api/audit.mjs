// Host API v1 audit sink (Plan 6 Task 8): rows go to the existing audit_log as `host_api.<event>` (90-day purge
// already runs). Event names are shared with the Mac's HostApiV1AuditLog.swift. Never pass a token, PIN, key or
// frame text: the detail is a short reason only, clamped to DETAIL_MAX characters.
import { getDb } from '../../kb/db.mjs';
import { recordAudit } from '../../server/audit.mjs';

export const AUDIT_DEDUPE_WINDOW_MS = 60_000;
export const AUDIT_DETAIL_MAX = 200;
const MAX_DEDUPE_KEYS = 1024;
const SUCCESS = new Set(['pair_ok', 'revoke_self', 'revoke_host', 'identity_created', 'identity_reset']);
const DENIED = new Set(['origin_refused', 'plaintext_refused', 'scope_denied']);

export const auditOutcome = (event) => (SUCCESS.has(event) ? 'success' : DENIED.has(event) ? 'denied' : 'failure');

export function createAuditSink({ db = getDb(), log = () => {}, now = Date.now } = {}) {
  const lastWrite = new Map(); // `${event}\0${dedupeKey}` -> ms
  return {
    record(event, { peer, userId, deviceId, clientName, detail, dedupeKey } = {}) {
      const t = now();
      if (dedupeKey != null) {
        const key = `${event}\0${dedupeKey}`;
        if (t - (lastWrite.get(key) ?? -Infinity) < AUDIT_DEDUPE_WINDOW_MS) return;
        if (lastWrite.size >= MAX_DEDUPE_KEYS) {
          for (const [k, v] of lastWrite) if (t - v >= AUDIT_DEDUPE_WINDOW_MS) lastWrite.delete(k);
          if (lastWrite.size >= MAX_DEDUPE_KEYS) lastWrite.clear(); // shortcut: a flood of distinct keys resets de-dup; the table still grows one row per key
        }
        lastWrite.set(key, t);
      }
      try {
        recordAudit(db, {
          userId, ip: peer, userAgent: clientName, action: `host_api.${event}`, resource: deviceId,
          outcome: auditOutcome(event), detail: detail ? { reason: String(detail).slice(0, AUDIT_DETAIL_MAX) } : undefined,
        });
      } catch (e) { log(`Host API v1 audit ${event} not written (${e?.code ?? 'error'})`); return; }
      log(`Host API v1 audit ${event} from ${peer ?? '-'}`);
    },
  };
}
