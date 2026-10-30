// The user's own MCP servers for one turn, in the shape both engines consume.
// Lives outside llm_agent/sdk/ because it needs nothing from the Claude SDK and
// a provider-adapter turn (llm_agent/adapter/) mounts the same servers.
import { getDb } from '../../kb/db.mjs';
import { makeSecretReader } from '../../server/vault.mjs';
import { effectiveMcpServers } from '../../mcp/mcp-config.mjs';
import { restrictsTools } from '../modes/mode-personas.mjs';
import { pluginEnabledFor } from '../skills/index.mjs';
import { RESERVED_MCP_NAME } from '../sdk/constants.mjs';
import { gateFor, mcpServerGate } from './gate.mjs';
import { activeInstalled } from './installed-runtime.mjs';

// The in-process llmide server owns RESERVED_MCP_NAME (./constants.mjs); a
// user server answering to it would REPLACE llm-ide's own tool surface for
// the turn.

/**
 * The user's own MCP servers for one turn, in SDK `mcpServers` shape, plus the
 * tool specs that pre-approve them.
 *
 * Until now the v2 engine mounted only the in-process `llmide` server, so a
 * user who had consented to (say) Linear got its tools on the legacy CLI path
 * and silently nothing here. Policy is deliberately identical to
 * buildMcpConfigForUser: enabled AND consented, and NOTHING in a restricted
 * mode (plan/review/document) — a mode that narrows llm-ide's own tools must
 * not hand over an unbounded third-party surface instead.
 *
 * Pre-approval uses the SDK's server-level spec (`mcp__<server>`) because the
 * tool names of a server are unknowable before connecting — and without it
 * every call would land in canUseTool, which denies anything it doesn't
 * recognize (DENY_UNKNOWN_TOOL).
 */
export function buildUserMcpServers(userId, mode, {
  restrictsToolsFn = restrictsTools,
  readSecret,
  pluginEnabled,
  gate,
} = {}) {
  const empty = { servers: {}, allowedTools: [] };
  const requestedMode = typeof mode === 'string' && mode ? mode : 'execute';
  if (typeof restrictsToolsFn === 'function' && restrictsToolsFn(requestedMode)) return empty;
  // The extensions catalog's switches (LLMIDE_EXT_ACTIVE_SET; an explicit null
  // forces none). They only remove servers the legacy rules would mount.
  const g = gate === undefined ? gateFor(userId) : gate;
  let effective;
  try {
    effective = effectiveMcpServers(userId, {
      readSecret: readSecret || makeSecretReader(getDb(), userId),
      pluginEnabled: pluginEnabled || pluginEnabledFor(userId, { gate: g }),
      serverActive: g ? mcpServerGate(g) : undefined,
    });
  } catch (err) {
    // A turn must not die because the MCP registry is unreadable — the user
    // loses their MCP tools for this turn, not the reply.
    console.warn('[agent-v2] user MCP unavailable:', err?.message || err);
    return empty;
  }
  const servers = {};
  for (const [id, cfg] of Object.entries(effective)) {
    if (id === RESERVED_MCP_NAME) {
      console.warn(`[agent-v2] MCP server '${id}' shadows llm-ide's own tool server — not mounted`);
      continue;
    }
    servers[id] = cfg;
  }
  const allowedTools = Object.keys(servers).map((id) => `mcp__${id}`);
  // Servers of items installed from the catalog (switched on AND consented for the
  // item's pinned commit). A third party wrote them, so they are NOT pre-approved:
  // every call asks (`askServers`; the SDK engine's canUseTool and the provider
  // adapter both park an approval). The key is absent when there are none, so a
  // user with nothing installed gets exactly the legacy result.
  if (g) {
    const asked = [];
    for (const s of activeInstalled(userId, g).mcp) {
      if (s.id === RESERVED_MCP_NAME || Object.hasOwn(servers, s.id)) continue;
      servers[s.id] = s.config;
      asked.push(s.id);
    }
    if (asked.length) return { servers, allowedTools, askServers: asked };
  }
  return { servers, allowedTools };
}
