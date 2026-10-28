// The engine's auth ladder and per-user engine home, kept free of the Agent
// SDK so modules that only need these (models.mjs for the model picker,
// transcripts.mjs for session cleanup, spike-engine.mjs) do not import
// engine.mjs. Importing engine.mjs loads the SDK and the whole engine graph;
// routes/router.mjs reaches models.mjs and transcripts.mjs at boot, so before
// this split every server boot paid that cost before the first chat turn.
// engine.mjs re-exports both functions — one definition, existing importers
// unchanged.

import path from 'node:path';
import { config } from '../../core/config.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret } from '../../server/vault.mjs';

// --- Auth: per-user vault key first, operator env as fallback -------------
// (Moved here from spike-engine.mjs via engine.mjs — the v2 runner, the Loop
// and the spike share one auth ladder.)

export function resolveAnthropicKey(userId) {
  if (userId) {
    try {
      const key = getSecret(getDb(), userId, 'claude.apiKey');
      if (key) return { key, source: 'vault' };
    } catch {
      // Vault miss/unavailable — fall through to the environment.
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: 'env' };
  return { key: null, source: 'none' };
}

// --- Per-user engine homes (spec §6/§11) --------------------------------------
//
// CLAUDE_CONFIG_DIR = <dataDir>/agent-sdk/<userId>/ isolates each tenant's
// SDK transcripts and credentials (settingSources: [] isolates the operator's
// SETTINGS; the config dir isolates everything else the SDK writes). Applied
// to KEYED turns only: an ambient-auth turn relies on the operator's
// `claude login`, which lives under the operator's default config dir, so
// redirecting it would leave the subprocess "Not logged in". The base is
// config.agentSdkDir (core/data-dir.mjs: LLMIDE_DATA_DIR/agent-sdk, else the
// DB's directory, <repo>/kb by default) — so engine homes sit next to the
// other per-install runtime data. User ids are server-minted hex
// (users.mjs); the charset guard keeps even a hand-edited id from escaping
// the base via path traversal. Shared by the runner (composes the env every
// keyed turn) and the route's transcript cleanup — one derivation, never two.

const USER_ID_RE = /^[A-Za-z0-9_-]+$/;

export function agentSdkHomeFor(userId) {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return null;
  return path.join(config.agentSdkDir, userId);
}
