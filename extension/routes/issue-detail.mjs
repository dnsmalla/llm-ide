// GET /kb/issues/detail: one issue with its comments for the desktop detail sheet. Always-on like the board read;
// provider writes stay in issue-writes.mjs behind the gantt_issues feature.
import * as kb from '../kb/db.mjs';
import { verifyBusHostProof } from '../core/host-approval.mjs';
import { getSecret } from '../server/vault.mjs';
import { sendJSON } from '../core/utils.mjs';
import { NAME, WEB_ORIGIN, readIssueDetail } from '../agents/issue-writer.mjs';

const fail = (res, status, code, message) => { sendJSON(res, status, { error: { code, message } }); return true; };

export async function handleIssueDetailRoute(req, res, { userId, url }) {
  if (req.method !== 'GET') return false;
  const u = new URL(url, 'http://127.0.0.1');
  if (u.pathname !== '/kb/issues/detail') return false;
  if (!verifyBusHostProof(req)) return fail(res, 403, 'HOST_PROOF_REQUIRED', 'This route is for the desktop app only');
  const provider = u.searchParams.get('provider');
  const repo = u.searchParams.get('repo') || '';
  const number = Number(u.searchParams.get('number'));
  if (provider !== 'github' && provider !== 'gitlab') return fail(res, 400, 'VALIDATION_FAILED', 'provider must be github or gitlab');
  if (!Number.isSafeInteger(number) || number <= 0) return fail(res, 400, 'VALIDATION_FAILED', 'number must be a positive integer');
  const known = kb.findTicket(userId, { provider, repo, number, origin: WEB_ORIGIN[provider] });
  if (!known) return fail(res, 403, 'REPO_NOT_ALLOWED', 'This issue is not on your Issues board. Import its repository first.');
  const token = getSecret(kb.getDb(), userId, `${provider}.token`);
  if (!token) return fail(res, 400, `${provider.toUpperCase()}_TOKEN_MISSING`, `Add a ${NAME[provider]} token in Settings → Built-in keys first.`);
  const out = await readIssueDetail({ provider, repo, number, token });
  sendJSON(res, out.status, out.body);
  return true;
}
