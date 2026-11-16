// Redeem key for POST /internal/clone-credential. Server mode only (LLMIDE_CORE_NONCE set): the core generates 32 random
// bytes at start, keeps them in memory and writes them to <dataDir>/clone-redeem.key (0600). The SSH server helper reads
// the file; nothing else exposes the key. It is never logged, never in /health, a response header or an audit row.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CLONE_REDEEM_KEY_FILE = 'clone-redeem.key';

let redeemKey = null;

/** The in-memory key, or null when this core has none (not server mode, or not started yet). */
export function currentCloneRedeemKey() {
  return redeemKey;
}

/**
 * Create (server mode) or clear (otherwise) the redeem key. In server mode the file is replaced atomically with mode
 * 0600; in any other mode a stale file is removed so the helper cannot read a key this core no longer holds.
 * @param {{ dataDir: string | null, serverMode: boolean }} options Data directory and whether LLMIDE_CORE_NONCE is set.
 * @returns {string | null} The new key, or null.
 */
export function initCloneRedeemKey({ dataDir, serverMode }) {
  const file = dataDir ? path.join(dataDir, CLONE_REDEEM_KEY_FILE) : null;
  if (!serverMode || !file) {
    redeemKey = null;
    if (file) fs.rmSync(file, { force: true });
    return null;
  }
  const key = randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  fs.renameSync(tmp, file);
  redeemKey = key;
  return key;
}

/** Constant-time check of a presented key against the in-memory key. A missing or wrong key is false. */
export function redeemKeyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
