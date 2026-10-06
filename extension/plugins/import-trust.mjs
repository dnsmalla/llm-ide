// Trust reset around a plugin re-import. Hook trust and MCP consents were
// granted for the executable parts of ONE copy; any import path that swaps in
// different executables (update, Claude import, Codex import) must drop them,
// or a re-import silently inherits a grant the user never gave the new code.
//
// The MCP side is passed in: plugins/ may not import mcp/ (layer rule).
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { hashExecutables } from './executable-hash.mjs';

/**
 * Snapshot the executables hash of the copy about to be replaced.
 *
 * Pre: `dir` is the plugin directory (basename = plugin name).
 * Post: `before` is the hash, or null when no copy exists; hash errors set
 * `hashFailed` (fail closed in finishTrustCheck).
 * @param {string} dir - plugin directory
 * @param {{hash?: (dir: string) => string}} [opts] - `hash` is a test seam
 * @returns {{name: string, dir: string, before: string|null, hashFailed: boolean, hash: Function}} token
 */
export function beginTrustCheck(dir, { hash = hashExecutables } = {}) {
  let hashFailed = false;
  let before = null;
  try {
    before = existsSync(dir) ? hash(dir) : null;
  } catch {
    hashFailed = true;
  }
  return { name: basename(dir), dir, before, hashFailed, hash };
}

/**
 * Compare the new copy against the snapshot and reset trust when needed.
 *
 * Pre: `token` from beginTrustCheck; the swap has finished (or failed).
 * Post: when `ok`, trust is reset if the hash differs, no prior copy existed,
 * or hashing failed. When not `ok`, nothing is cleared (the old copy stays).
 * @param {object} token - from beginTrustCheck
 * @param {{ok: boolean, clearTrust: (name: string) => void, clearMcpConsents: (name: string) => void}} opts
 * @returns {boolean} trustReset
 */
export function finishTrustCheck(token, { ok, clearTrust, clearMcpConsents }) {
  if (!ok) return false;
  let hashFailed = token.hashFailed;
  let after = null;
  try {
    after = token.hash(token.dir);
  } catch {
    hashFailed = true;
  }
  const trustReset = hashFailed || token.before === null || token.before !== after;
  if (trustReset) {
    clearTrust(token.name);
    clearMcpConsents(token.name);
  }
  return trustReset;
}

/**
 * Run `doImport` and reset trust when the plugin's executables changed.
 *
 * Pre: `dir` is the plugin directory the import writes (its basename is the
 * plugin name trust is keyed by); `doImport` is synchronous and returns
 * `{ ok: boolean, ... }`; `clearTrust` / `clearMcpConsents` take the name.
 * Post: on a successful import, trust is reset when the hash differs, when no
 * copy existed before (stale grants from a removed same-named plugin), or
 * when hashing failed — fail closed. A failed import resets nothing (the
 * swap keeps the old copy).
 * @param {{dir: string, doImport: () => {ok: boolean}, clearTrust: (name: string) => void,
 *   clearMcpConsents: (name: string) => void, hash?: (dir: string) => string}} opts - `hash` is a test seam
 * @returns {object} the import result plus `trustReset: boolean`
 */
export function importWithTrustCheck({ dir, doImport, clearTrust, clearMcpConsents, hash = hashExecutables }) {
  const token = beginTrustCheck(dir, { hash });
  const result = doImport();
  const trustReset = finishTrustCheck(token, { ok: !!result?.ok, clearTrust, clearMcpConsents });
  return { ...result, trustReset };
}
