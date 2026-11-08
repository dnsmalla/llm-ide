// Bus kind `sources.update` (T1): the server-side Pattern A syncs a user already connected (Google Calendar, Google Drive,
// iCal feeds, Box). Source ids: `gcal:<accountId>`, `gdrive:<accountId>`, `ical:<sourceId>`, `box:default`; no ids =
// every such source the user has. Gmail is Pattern B (the client writes the notes, then confirms the cursor), and
// Slack/email are fetch-only (no scheduled pull), so they are skipped. Each source re-checks AT EXECUTION that its
// connection and scope still exist (runGoogleSync / runIcalSync / the stored Box connection), so a connection deleted
// or narrowed after approval is refused before any write. Results carry ids, counts and fixed codes only: never a
// token, URL or message text.
import { listGoogleAccounts } from '../../kb/google-store.mjs';
import { listIcalSources } from '../../kb/ical-store.mjs';
import { runGoogleSync } from '../google-connectors.mjs';
import { runIcalSync } from '../calendar-ical.mjs';
import { indexBoxFolder } from '../../connectors/box.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';

const REFUSED = new Set(['GOOGLE_NOT_FOUND', 'GOOGLE_PRODUCT_NOT_GRANTED', 'ICAL_NOT_FOUND', 'BOX_NOT_FOUND']);
// Not an error: the per-user Box interval has not elapsed, so this run deliberately does nothing.
const SKIPPED = new Set(['BOX_TOO_SOON']);
const ID_RE = /^(gcal|gdrive|ical):([a-f0-9]{12})$|^box:default$/;
// Per-user cost/rate policy for the scheduled Box re-index: one full folder walk at most every 6 hours (a standing
// approval can fire hourly), and the connector's own MAX_FILES/MAX_DEPTH caps bound one run. A manual
// `/kb/connect-box` is not throttled (the user is waiting for it).
export const BOX_SCHEDULED_MIN_INTERVAL_MS = 6 * 3600_000;

/** The stored Box connection, or null when any piece is missing. */
export function storedBoxConnection(userId) {
  const db = getDb();
  const clientId = getSecret(db, userId, 'box.clientId');
  const clientSecret = getSecret(db, userId, 'box.clientSecret');
  const subjectType = getSecret(db, userId, 'box.subjectType') || 'enterprise';
  const subjectId = getSecret(db, userId, 'box.subjectId');
  const folderId = getSecret(db, userId, 'box.folderId');
  if (!clientId || !clientSecret || !subjectId || !folderId) return null;
  return { clientId, clientSecret, subjectType, subjectId, folderId };
}

async function runBoxSync(userId, now = Date.now(), index = indexBoxFolder) {
  const creds = storedBoxConnection(userId);
  if (!creds) throw Object.assign(new Error('no stored Box connection'), { code: 'BOX_NOT_FOUND' });
  const last = Number(getSecret(getDb(), userId, 'box.lastIndexedAt') || 0);
  if (last > 0 && now - last < BOX_SCHEDULED_MIN_INTERVAL_MS) {
    throw Object.assign(new Error('the Box folder was indexed recently'), { code: 'BOX_TOO_SOON' });
  }
  const result = await index(userId, creds);
  setSecret(getDb(), userId, 'box.lastIndexedAt', String(now));
  return result;
}

export async function runSourcesUpdate({ userId, args = {}, signal, now = Date.now(), indexBox = indexBoxFolder }) {
  let ids = Array.isArray(args.sourceIds) ? [...new Set(args.sourceIds)] : [];
  if (!ids.length) {
    ids = [
      ...listGoogleAccounts(userId).flatMap((a) => a.products.filter((p) => p === 'gcal' || p === 'gdrive').map((p) => `${p}:${a.accountId}`)),
      ...listIcalSources(userId).map((s) => `ical:${s.sourceId}`),
      ...(storedBoxConnection(userId) ? ['box:default'] : []),
    ];
  }
  const results = [];
  for (const sourceId of ids) {
    if (signal?.aborted) break;
    const m = ID_RE.exec(sourceId);
    if (!m) { results.push({ sourceId, status: 'skipped', code: 'unsupported' }); continue; }
    try {
      const r = m[0] === 'box:default'
        ? await runBoxSync(userId, now, indexBox)
        : m[1] === 'ical' ? await runIcalSync(userId, m[2]) : await runGoogleSync(userId, m[2], m[1]);
      const count = r?.events ?? r?.instances ?? r?.indexed ?? r?.stats?.files ?? 0;
      results.push({ sourceId, status: 'ok', count, pending: r.pending === true });
    } catch (e) {
      const code = String(e?.code || 'error');
      results.push({ sourceId, status: SKIPPED.has(code) ? 'skipped' : REFUSED.has(code) ? 'refused' : 'error', code });
    }
  }
  const synced = results.filter((r) => r.status === 'ok').length;
  const bad = results.find((r) => r.status !== 'skipped');
  // Nothing failed and something was deliberately skipped (the Box interval, an unsupported id) is a success.
  if (results.length && !synced && bad) {
    throw Object.assign(new Error('sources.update failed'), { code: bad.status === 'refused' ? 'not_found' : 'engine_failed', results });
  }
  return { synced, refused: results.filter((r) => r.status === 'refused').length, skipped: results.filter((r) => r.status === 'skipped').length, results, text: `Synced ${synced} of ${results.length} sources.` };
}
