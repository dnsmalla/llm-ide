// Shared plumbing for the HTTP route modules that take a direct DB handle
// (server/auth-routes.mjs, routes/extension-routes.mjs): JSON/raw body
// readers, the response writer, client-IP resolution and the audit wrapper.
// Lifted verbatim out of auth-routes.mjs so both modules behave identically.

import { config } from '../core/config.mjs';
import { readBody, parseJSON } from '../core/utils.mjs';
import { isVaultError } from './vault.mjs';
import { recordAudit } from './audit.mjs';

// Map any error (including VaultError) to a client-safe message.
// VaultError carries a `publicMessage` precisely so its internal
// detail (blob length, decipher failure, key version) never reaches
// the client; everything else uses err.message as before.
export function publicMessageFor(err) {
  if (isVaultError(err)) return err.publicMessage || 'Vault operation failed';
  return err?.message || 'Request failed';
}

export function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Hardened body reader: delegates to core/utils readBody (uses req.pause()
// on overflow, not req.destroy()) so the route handler's catch block can
// still write a 413/400 JSON response to the now-unblocked res socket.
// Returns a parsed object; throws with a descriptive message on errors.
export async function readJson(req, max) {
  let raw;
  try {
    raw = await readBody(req, max);
  } catch (err) {
    // Map readBody's AppError (status 413/408) to something the existing
    // callers already handle: they catch any Error and send a 400/413 response.
    const e = new Error(err.message || 'Body too large');
    e.status = err.status || 413;
    throw e;
  }
  if (!raw) return {};
  const parsed = parseJSON(raw);
  if (parsed === null) throw new Error('Body must be valid JSON');
  return parsed;
}

// Raw-bytes reader for binary uploads (plugin install zips). Uses
// req.pause() instead of req.destroy() on overflow so the route
// handler still has a writable `res` to send the 413 envelope — same
// fix we applied to core/utils.mjs#readBody.
export async function readRawBody(req, max) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        try { req.pause(); } catch { /* ignore */ }
        const err = new Error('Request body too large');
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function clientIp(req) {
  // We respect X-Forwarded-For ONLY when LLMIDE_TRUST_PROXY is on.
  // Otherwise we use the socket address — anything else is spoofable.
  //
  // XFF is built left-to-right as "client, proxy1, proxy2, …": each hop
  // APPENDS the address it saw. The leftmost value is therefore the value
  // the original client CLAIMED and is fully attacker-controlled (a client
  // can pre-set the header; our trusted proxy just appends to it). The only
  // entry we can trust is the RIGHTMOST one — the address our single
  // trusted proxy actually observed. Taking the first entry would let any
  // client spoof its IP in the audit log. (This assumes one trusted proxy
  // hop, which is the documented LLMIDE_TRUST_PROXY deployment.)
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Audit a write — failures captured too so denied registrations show
// up in the log.  Wraps the DB row so a recordAudit failure can never
// drop the actual response.
export function safeAudit(db, fields) {
  try { recordAudit(db, fields); }
  catch (err) {
    process.stderr.write(JSON.stringify({ level: 'warn', msg: 'audit_write_failed', action: fields.action, error: err.message }) + '\n');
  }
}
