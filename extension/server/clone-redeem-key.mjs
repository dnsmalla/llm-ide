// Redeem key for POST /internal/clone-credential, only on an SSH server core. The core generates 32 random bytes at
// start, keeps them in memory and writes them to <dataDir>/clone-redeem.key (0600). The SSH server helper reads that file.
// The key is never logged, never in /health, a response header or an audit row. The /health identity nonce is NOT this key:
// it is served to any local process, so it never redeems a grant.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../core/logger.mjs';

export const CLONE_REDEEM_KEY_FILE = 'clone-redeem.key';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

let redeemKey = null;

/** The in-memory key, or null when this core has none (not an SSH server core, or the write failed). */
export function currentCloneRedeemKey() {
  return redeemKey;
}

/**
 * Whether this core is an SSH server core that holds the redeem key. The local desktop core also sets
 * LLMIDE_CORE_NONCE, so the nonce cannot tell the two apart; the START script sets LLMIDE_SSH_SERVER=1 instead. A hub
 * never holds the key, and the core must be bound to loopback.
 * @param {{ env?: NodeJS.ProcessEnv, hub: boolean, host: string }} options Environment, hub flag and bind host.
 * @returns {boolean} True only for an SSH server core on a loopback bind that is not a hub.
 */
export function isCloneRedeemServerMode({ env = process.env, hub, host }) {
  return env.LLMIDE_SSH_SERVER === '1' && !hub && LOOPBACK_HOSTS.has(String(host || '').toLowerCase());
}

/**
 * Create (server mode) or clear (otherwise) the redeem key. The file is written to a temp name created with flag
 * `wx` and mode 0600, then renamed into place. Any write or remove error is logged without the key and leaves the
 * core running with no key (the redeem then answers 404); it never aborts the boot.
 * @param {{ dataDir: string | null, serverMode: boolean }} options Data directory and whether this is an SSH server core.
 * @returns {string | null} The new key, or null.
 */
export function initCloneRedeemKey({ dataDir, serverMode }) {
  redeemKey = null;
  if (!dataDir) return null;
  const file = path.join(dataDir, CLONE_REDEEM_KEY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    if (!serverMode) {
      fs.rmSync(file, { force: true });
      return null;
    }
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32).toString('hex');
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, key);
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    redeemKey = key;
    return key;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort: the key is not in use */ }
    logger.warn('clone_redeem_key_unavailable', { code: err?.code ?? 'error' });
    return null;
  }
}

/** Constant-time check of a presented key against the in-memory key. A missing or wrong key is false. */
export function redeemKeyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
