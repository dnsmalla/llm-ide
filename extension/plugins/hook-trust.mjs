// Granting and revoking hook trust — the decision layer behind
// POST /auth/me/plugins/hook-trust.
//
// Trusting a plugin's hooks authorizes shell execution on the user's behalf,
// so a grant is only allowed for a plugin that is installed AND actually
// declares runnable hooks. Revocation has no such preconditions: taking a
// grant back must always work, including for a plugin that has since been
// uninstalled (whose trust entry would otherwise linger until the next prune).
//
// Kept out of the route module so it is unit-testable without an HTTP server,
// and out of plugins/state.mjs, which is storage only and knows nothing about
// what the installed plugins declare.

import { setHooksTrusted } from './state.mjs';

/**
 * @param {string} userId
 * @param {string} pluginName
 * @param {boolean} trusted
 * @param {{listPlugins: function}} deps — supplies the installed-plugin view.
 *   Injected rather than imported: the registry that knows what a plugin
 *   declares lives in llm_agent/, a peer layer this module may not import
 *   (CLAUDE.md "Module Boundaries"). The route layer, which may import both,
 *   passes it in.
 * @returns {{ok: true, hooksTrusted: boolean} | {error: string, status?: number}}
 */
export function setPluginHookTrust(userId, pluginName, trusted, { listPlugins } = {}) {
  if (!userId) return { error: 'no user', status: 401 };
  if (typeof pluginName !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(pluginName)) {
    return { error: 'name must be a valid plugin slug', status: 400 };
  }
  if (typeof trusted !== 'boolean') return { error: 'trusted must be a boolean', status: 400 };

  // Revocation is unconditional: taking back a shell-execution grant must
  // never depend on the plugin still being installed or still declaring hooks.
  if (!trusted) {
    setHooksTrusted(userId, pluginName, false);
    return { ok: true, hooksTrusted: false };
  }

  if (typeof listPlugins !== 'function') {
    return { error: 'hook trust cannot be verified without the plugin list', status: 500 };
  }
  const found = listPlugins(userId).find((p) => p.name === pluginName);
  if (!found) return { error: `plugin '${pluginName}' is not installed`, status: 400 };
  // Nothing to trust: granting here would leave a standing shell-execution
  // grant attached to a plugin that could acquire hooks in a later update
  // without the user ever being asked again.
  if (!found.hookCount) {
    return { error: `plugin '${pluginName}' declares no hooks that llm-ide can run`, status: 400 };
  }
  setHooksTrusted(userId, pluginName, true);
  return { ok: true, hooksTrusted: true };
}
