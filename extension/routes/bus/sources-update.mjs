// Bus kind `sources.update` (T1): the server-side Pattern A syncs a user already connected (Google Calendar, Google Drive,
// iCal feeds). Source ids: `gcal:<accountId>`, `gdrive:<accountId>`, `ical:<sourceId>`; no ids = every such source the user has.
// Gmail is Pattern B (the client writes the notes, then confirms the cursor), so it is skipped here, as is anything else
// (box, slack, email) that lives in the Mac app. Each source re-checks AT EXECUTION that its connection and scope still
// exist (runGoogleSync / runIcalSync), so a connection deleted or narrowed after approval is refused before any write.
// Results carry ids, counts and fixed codes only: never a token, URL or message text.
import { listGoogleAccounts } from '../../kb/google-store.mjs';
import { listIcalSources } from '../../kb/ical-store.mjs';
import { runGoogleSync } from '../google-connectors.mjs';
import { runIcalSync } from '../calendar-ical.mjs';

const REFUSED = new Set(['GOOGLE_NOT_FOUND', 'GOOGLE_PRODUCT_NOT_GRANTED', 'ICAL_NOT_FOUND']);
const ID_RE = /^(gcal|gdrive|ical):([a-f0-9]{12})$/;

export async function runSourcesUpdate({ userId, args = {}, signal }) {
  let ids = Array.isArray(args.sourceIds) ? [...new Set(args.sourceIds)] : [];
  if (!ids.length) {
    ids = [
      ...listGoogleAccounts(userId).flatMap((a) => a.products.filter((p) => p === 'gcal' || p === 'gdrive').map((p) => `${p}:${a.accountId}`)),
      ...listIcalSources(userId).map((s) => `ical:${s.sourceId}`),
    ];
  }
  const results = [];
  for (const sourceId of ids) {
    if (signal?.aborted) break;
    const m = ID_RE.exec(sourceId);
    if (!m) { results.push({ sourceId, status: 'skipped', code: 'unsupported' }); continue; }
    try {
      const r = m[1] === 'ical' ? await runIcalSync(userId, m[2]) : await runGoogleSync(userId, m[2], m[1]);
      const count = r.events ?? r.instances ?? r.stats?.files ?? 0;
      results.push({ sourceId, status: 'ok', count, pending: r.pending === true });
    } catch (e) {
      const code = String(e?.code || 'error');
      results.push({ sourceId, status: REFUSED.has(code) ? 'refused' : 'error', code });
    }
  }
  const synced = results.filter((r) => r.status === 'ok').length;
  if (results.length && !synced) {
    const bad = results.find((r) => r.status !== 'skipped');
    throw Object.assign(new Error('sources.update failed'), { code: !bad ? 'invalid_args' : bad.status === 'refused' ? 'not_found' : 'engine_failed', results });
  }
  return { synced, refused: results.filter((r) => r.status === 'refused').length, skipped: results.filter((r) => r.status === 'skipped').length, results, text: `Synced ${synced} of ${results.length} sources.` };
}
