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
  const name = basename(dir);
  let hashFailed = false;
  let before = null;
  try {
    before = existsSync(dir) ? hash(dir) : null;
  } catch {
    hashFailed = true;
  }
  const result = doImport();
  if (!result?.ok) return { ...result, trustReset: false };
  let after = null;
  try {
    after = hash(dir);
  } catch {
    hashFailed = true;
  }
  const trustReset = hashFailed || before === null || before !== after;
  if (trustReset) {
    clearTrust(name);
    clearMcpConsents(name);
  }
  return { ...result, trustReset };
}
