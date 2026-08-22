// extension/mcp/mcp-config.mjs
// Build the --mcp-config JSON for a user's enabled+consented MCP plugins,
// gated by mode (restricted modes → null → caller keeps --strict-mcp-config).
import { listMcpPluginsWithState, transportOf } from './state.mjs';

// The MCP servers chat effectively runs with: enabled AND consented plugins,
// in the exact { mcpServers } shape the claude CLI reads. Shared by
// buildMcpConfigForUser (the live --mcp-config flag) and the
// llm_default_sources snapshot so both show the same truth.
/**
 * Read a plugin's credential through the caller-supplied reader.
 *
 * `readSecret` is injected rather than imported: the vault lives in `server/`,
 * which this layer must not import (CLAUDE.md "Module Boundaries"). Callers
 * that legitimately can — llm_agent and the route layer — build one with
 * `makeSecretReader(db, userId)` and hand it down. Absent reader means "no
 * credentials available", which degrades to a server that reports its own auth
 * failure rather than to a crash.
 */
function credentialValue(plugin, readSecret) {
  const key = plugin?.credential?.vaultKey;
  if (!key || typeof readSecret !== 'function') return '';
  try { return readSecret(key) || ''; } catch { return ''; }
}

/** True when the plugin declares a credential the vault cannot supply. */
export function credentialMissing(plugin, readSecret) {
  if (!plugin?.credential?.vaultKey) return false;
  return credentialValue(plugin, readSecret) === '';
}

/**
 * A plugin-declared server answers to TWO switches: its own enable+consent,
 * and the plugin's per-user enable state. `pluginEnabled` is injected because
 * plugins/ and mcp/ are peers in the layer table and may not import each other
 * — llm_agent (which may import both) supplies it. A caller that cannot answer
 * excludes plugin servers rather than ignoring the plugin toggle.
 */
function pluginGate(pluginEnabled) {
  return (p) => (p.source !== 'plugin'
    ? true
    : typeof pluginEnabled === 'function' && !!pluginEnabled(p.pluginName));
}

export function effectiveMcpServers(userId, { readSecret, pluginEnabled } = {}) {
  const allowedByPlugin = pluginGate(pluginEnabled);
  const active = listMcpPluginsWithState(userId).plugins
    .filter((p) => p.enabled && p.consented)
    .filter(allowedByPlugin);
  const mcpServers = {};
  for (const p of active) {
    const transport = transportOf(p);
    // The secret is fetched here and nowhere else: it never enters the
    // registry file, so this is the only point where a token exists in the
    // emitted config. An empty value omits the header/env rather than sending
    // `Bearer ` — the server then reports a real auth failure instead of a
    // confusing malformed-credential one.
    const secret = credentialValue(p, readSecret);
    const cred = p.credential;

    if (transport === 'http' || transport === 'sse') {
      const headers = { ...(p.headers || {}) };
      if (secret && cred?.target === 'header' && cred.name) {
        headers[cred.name] = typeof cred.template === 'string'
          ? cred.template.replace('${value}', secret)
          : secret;
      }
      mcpServers[p.id] = {
        type: transport,
        url: p.url,
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      continue;
    }

    const env = { ...(p.env || {}) };
    if (secret && cred?.target === 'env' && cred.name) env[cred.name] = secret;
    mcpServers[p.id] = {
      command: p.command,
      args: p.args || [],
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  return mcpServers;
}

export function buildMcpConfigForUser(userId, { mode, restrictsToolsFn, readSecret, pluginEnabled }) {
  if (typeof restrictsToolsFn === 'function' && restrictsToolsFn(mode)) return null;
  const mcpServers = effectiveMcpServers(userId, { readSecret, pluginEnabled });
  if (Object.keys(mcpServers).length === 0) return null;
  return { mcpConfigJson: JSON.stringify({ mcpServers }), allowed: true };
}
