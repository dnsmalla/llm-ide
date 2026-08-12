// extension/mcp/mcp-config.mjs
// Build the --mcp-config JSON for a user's enabled+consented MCP plugins,
// gated by mode (restricted modes → null → caller keeps --strict-mcp-config).
import { listMcpPluginsWithState } from './state.mjs';

export function buildMcpConfigForUser(userId, { mode, restrictsToolsFn }) {
  if (typeof restrictsToolsFn === 'function' && restrictsToolsFn(mode)) return null;
  const active = listMcpPluginsWithState(userId).plugins.filter((p) => p.enabled && p.consented);
  if (active.length === 0) return null;
  const mcpServers = {};
  for (const p of active) {
    mcpServers[p.id] = {
      command: p.command,
      args: p.args || [],
      ...(p.env ? { env: p.env } : {}),
    };
  }
  return { mcpConfigJson: JSON.stringify({ mcpServers }), allowed: true };
}
