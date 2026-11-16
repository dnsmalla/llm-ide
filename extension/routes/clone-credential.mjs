// Clone credential for the SSH server helper. POST /kb/repos/clone-grant (JWT) mints a single-use grant for the user's
// saved GitHub/GitLab token; POST /internal/clone-credential redeems it over loopback with the redeem key (the file-only
// key in server/clone-redeem-key.mjs) and answers { token }. The token never reaches the desktop, a log, an audit row or
// an error. Only the redeem answer carries it.
import * as kb from '../kb/db.mjs';
import { getSecret } from '../server/vault.mjs';
import { issueCloneGrant, redeemCloneGrant } from '../server/clone-grants.mjs';
import { currentCloneRedeemKey, redeemKeyMatches } from '../server/clone-redeem-key.mjs';
import { recordAudit } from '../server/audit.mjs';
import { safeAudit, clientIp } from '../server/route-http.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';

const GRANT_SHAPE = /^[0-9a-f]{64}$/;
const PROVIDERS = new Set(['github', 'gitlab']);
const REFUSED = { error: 'clone_credential_refused' };

/** Loopback peers only: the socket address, never a forwarded header. */
function isLoopbackPeer(req) {
  const addr = String(req?.socket?.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** POST /kb/repos/clone-grant { provider } -> { grant } | { grant: null } when the user has no saved token. */
export async function handleCloneGrant(req, res, { userId }) {
  let body;
  try { body = parseJSON(await readBody(req, 16 * 1024)); } catch { body = null; }
  const provider = body?.provider;
  if (!PROVIDERS.has(provider)) {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'provider must be github or gitlab' } });
    return;
  }
  const db = kb.getDb();
  const hasToken = Boolean(getSecret(db, userId, `${provider}.token`));
  const grant = hasToken ? issueCloneGrant(userId, provider) : null;
  safeAudit(db, {
    userId, ip: clientIp(req), userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 200) || null,
    action: 'repos.clone_grant', outcome: grant ? 'success' : 'denied', detail: { provider },
  });
  sendJSON(res, 200, { grant });
}

/**
 * POST /internal/clone-credential { grant } with header x-llmide-redeem-key. No JWT: the loopback peer, the redeem key
 * and the single-use grant are the proof. 404 when the core has no redeem key (not server mode); every other refusal is
 * the same 403 with no reason, so a probe learns nothing about which check failed.
 */
export async function handleCloneCredentialRedeem(req, res) {
  const expected = currentCloneRedeemKey();
  if (!expected) {
    sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    return;
  }
  const refuse = () => {
    res.setHeader('Cache-Control', 'no-store');
    sendJSON(res, 403, REFUSED);
  };
  if (!isLoopbackPeer(req)) { refuse(); return; }
  if (!redeemKeyMatches(req.headers?.['x-llmide-redeem-key'], expected)) { refuse(); return; }
  let body;
  try { body = parseJSON(await readBody(req, 4 * 1024)); } catch { body = null; }
  const grant = body?.grant;
  if (typeof grant !== 'string' || !GRANT_SHAPE.test(grant)) { refuse(); return; }
  const binding = redeemCloneGrant(grant);
  if (!binding) { refuse(); return; }
  const db = kb.getDb();
  const token = getSecret(db, binding.userId, `${binding.provider}.token`);
  // The audit row names the grant's user and provider only, and records whether a token was handed out.
  try {
    recordAudit(db, {
      userId: binding.userId, action: 'repos.clone_credential', outcome: token ? 'success' : 'denied',
      detail: { provider: binding.provider, ok: Boolean(token) },
    });
  } catch { /* an audit failure must not change the answer */ }
  if (!token) { refuse(); return; }
  res.setHeader('Cache-Control', 'no-store');
  sendJSON(res, 200, { token });
}
