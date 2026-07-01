// Issue scheduling overlay routes — the gantt-parity store for GitHub.
// GitHub issues have no start/due/estimate/dependency fields; these
// endpoints let the Mac client read and write that scheduling metadata in
// our own backend, keyed by (provider, repo, issueNumber).
//
// Contract:
//   handleIssueScheduleRoutes(req, res, ctx) → boolean
//     ctx = { userId, url }
//     true  = route handled (response written)
//     false = not an issue-schedule route — caller continues dispatch
//
// All operations are user_id-scoped in kb/issue-schedule.mjs (IDOR-safe).

import * as kb from '../db.mjs';
import { sendJSON, readBody, parseJSON } from '../../core/utils.mjs';

const BASE = '/kb/issue-schedule';

export async function handleIssueScheduleRoutes(req, res, ctx) {
  const { userId, url } = ctx;
  if (!url.startsWith(BASE)) return false;

  // GET /kb/issue-schedule?provider=github&repo=owner/name
  if (req.method === 'GET') {
    const u = new URL(url, 'http://127.0.0.1');
    const provider = u.searchParams.get('provider') || 'github';
    const repo = u.searchParams.get('repo') || '';
    try {
      const schedules = kb.listIssueSchedules(userId, { provider, repo });
      sendJSON(res, 200, { schedules, count: schedules.length });
    } catch (err) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message || 'Invalid request' } });
    }
    return true;
  }

  // PUT /kb/issue-schedule  { provider, repo, issueNumber, startDate?, dueDate?, estimateDays?, dependsOn? }
  if (req.method === 'PUT') {
    try {
      // Inside the try: readBody rejects (413/408) on an oversize/slow body —
      // surface that as the 400 envelope, not an unhandled 500.
      const body = parseJSON(await readBody(req, 64 * 1024));
      const saved = kb.upsertIssueSchedule(userId, {
        provider: body?.provider,
        repo: body?.repo,
        issueNumber: body?.issueNumber,
        startDate: body?.startDate,
        dueDate: body?.dueDate,
        estimateDays: body?.estimateDays,
        dependsOn: body?.dependsOn,
      });
      sendJSON(res, 200, saved);
    } catch (err) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message || 'Invalid schedule' } });
    }
    return true;
  }

  // DELETE /kb/issue-schedule  { provider, repo, issueNumber }
  if (req.method === 'DELETE') {
    try {
      const body = parseJSON(await readBody(req, 8 * 1024));
      const deleted = kb.deleteIssueSchedule(userId, {
        provider: body?.provider,
        repo: body?.repo,
        issueNumber: body?.issueNumber,
      });
      sendJSON(res, 200, { deleted });
    } catch (err) {
      sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message || 'Invalid request' } });
    }
    return true;
  }

  return false;
}
