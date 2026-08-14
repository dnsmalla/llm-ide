// extension/mcp/mcp-config.mjs
// Build the --mcp-config JSON for a user's enabled+consented MCP plugins,
// gated by mode (restricted modes → null → caller keeps --strict-mcp-config).
import { listMcpPluginsWithState } from './state.mjs';

// The MCP servers chat effectively runs with: enabled AND consented plugins,
// in the exact { mcpServers } shape the claude CLI reads. Shared by
// buildMcpConfigForUser (the live --mcp-config flag) and the
// llm_default_sources snapshot so both show the same truth.
export function effectiveMcpServers(userId) {
  const active = listMcpPluginsWithState(userId).plugins.filter((p) => p.enabled && p.consented);
  const mcpServers = {};
  for (const p of active) {
    mcpServers[p.id] = {
      command: p.command,
      args: p.args || [],
      ...(p.env ? { env: p.env } : {}),
    };
  }
  return mcpServers;
}

export function buildMcpConfigForUser(userId, { mode, restrictsToolsFn }) {
  if (typeof restrictsToolsFn === 'function' && restrictsToolsFn(mode)) return null;
  const mcpServers = effectiveMcpServers(userId);
  if (Object.keys(mcpServers).length === 0) return null;
  return { mcpConfigJson: JSON.stringify({ mcpServers }), allowed: true };
}
