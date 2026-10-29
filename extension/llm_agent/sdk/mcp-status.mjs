// Live MCP connection state from the SDK itself (`query.mcpServerStatus()`,
// K1 P2 A12). Before this a user MCP server that failed to connect (bad
// command, missing credential, auth needed) was invisible: the init message
// only says `pending`, and the turn simply lacked the tools. Read once per turn
// after the result, like the context-usage read: a control request to the CLI
// subprocess, no model call, no tokens. Best-effort: a fake or older query
// without the method, a failure or a slow answer yields null and the turn is
// untouched (the fallback is the status `init` already carries).
import { RESERVED_MCP_NAME } from './constants.mjs';

const MCP_STATUS_TIMEOUT_MS = 2000;
const PROBLEM = new Set(['failed', 'needs-auth']);

/** The SDK's statuses for the turn's servers, or null when unavailable. */
export async function readMcpServerStatus(q, { timeoutMs = MCP_STATUS_TIMEOUT_MS } = {}) {
  if (typeof q?.mcpServerStatus !== 'function') return null;
  let timer;
  try {
    const res = await Promise.race([
      q.mcpServerStatus(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    return Array.isArray(res) ? res : null;
  } catch (err) {
    console.warn(`mcp status unavailable: ${String(err?.message ?? err).slice(0, 200)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A `notice` event when a USER server (never our own in-process one) is in a
 * problem state, else null. Only names, statuses and tool counts: the SDK's
 * `error` text can carry a command line or a URL, so it is not forwarded.
 */
export function mcpStatusNotice(statuses) {
  if (!Array.isArray(statuses)) return null;
  const user = statuses
    .filter((s) => s && typeof s.name === 'string' && s.name !== RESERVED_MCP_NAME)
    .map((s) => ({ name: s.name.slice(0, 64), status: typeof s.status === 'string' ? s.status.slice(0, 24) : 'unknown',
      tools: Array.isArray(s.tools) ? s.tools.length : null }));
  const bad = user.filter((s) => PROBLEM.has(s.status));
  if (bad.length === 0) return null;
  const list = bad.slice(0, 5).map((s) => `${s.name} (${s.status})`).join(', ');
  return { type: 'notice', kind: 'mcp_status', level: 'warning', text: `MCP server needs attention: ${list}.`, data: { servers: user.slice(0, 20) } };
}
