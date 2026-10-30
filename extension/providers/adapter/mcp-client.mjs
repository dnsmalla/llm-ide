// An MCP client for provider-adapter turns: connect to the servers a user has
// enabled and consented to, list their tools, call them. It imports the
// official MCP SDK (pinned in package.json; the import is fenced to this folder
// and connectors/mcp-client.mjs by eslint.config.mjs) and nothing of ours above
// the providers layer.
//
// What it does NOT decide: which servers are active (the catalog's active set),
// the permission gate, the untrusted-data framing, the approval prompt. Those
// are the caller's (llm_agent/adapter/mcp-mount.mjs), so this file can be
// swapped for the library's own MCP client without touching policy.
//
// Everything a server tells us is untrusted: tool descriptions and schemas can
// carry instructions aimed at the model. Descriptions are capped and stripped of
// hidden and control characters here; the caller adds the data framing. A tool
// whose schema is oversized or malformed is skipped, not trusted.
//
// Bounds (so one hostile or broken server cannot stall or flood a turn):
//   connect + list    15 s per server, in parallel
//   one tool call     60 s
//   tools             48 per server, 96 per turn
//   one tool result   30 000 characters kept, the rest dropped
//   tool schema       16 000 characters of JSON
// A server that streams more than that in one message is still read in full by
// the SDK before it reaches us; the call timeout is what bounds that.

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { assertProviderBaseUrl } from '../../server/base-url-guard.mjs';
import { makePinnedFetch, SsrfBlockedError } from '../../server/pinned-fetch.mjs';

export const MCP_LIMITS = Object.freeze({
  connectMs: 15_000,
  callMs: 60_000,
  toolsPerServer: 48,
  toolsPerTurn: 96,
  resultChars: 30_000,
  schemaChars: 16_000,
  descriptionChars: 1_000,
  pages: 4,
});

const CLIENT_INFO = { name: 'llm-ide', version: '1.0.0' };
// Zero-width, bidi controls, BOM and C0/C1 controls (except tab/newline): the
// characters a description can use to hide text from a human reviewer.
const HIDDEN_RANGES = [[0, 8], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff]];
const hex4 = (n) => n.toString(16).padStart(4, '0');
const HIDDEN_RE = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]`, 'g');

/** Server-supplied text reduced to something safe to show a model as data. */
export function cleanServerText(value, max = MCP_LIMITS.descriptionChars) {
  const s = typeof value === 'string' ? value : '';
  return s.replace(HIDDEN_RE, '').replace(/<<<[^>]*>>>/g, '').trim().slice(0, max);
}

const SAFE_PART = /[^a-zA-Z0-9_-]/g;
/**
 * The name the model sees, namespaced like the Claude path (`mcp__<server>__<tool>`),
 * within the 64-character limit providers impose; a long pair keeps a hash so two
 * different tools never collide after truncation.
 */
export function modelToolName(server, tool) {
  const s = String(server).replace(SAFE_PART, '_');
  const t = String(tool).replace(SAFE_PART, '_');
  const full = `mcp__${s}__${t}`;
  if (full.length <= 64) return full;
  const h = createHash('sha256').update(`${server}\u0000${tool}`).digest('hex').slice(0, 8);
  return `${full.slice(0, 64 - 9)}_${h}`;
}

function schemaOf(tool) {
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return null;
  let text;
  try { text = JSON.stringify(schema); } catch { return null; }
  if (!text || text.length > MCP_LIMITS.schemaChars) return null;
  return JSON.parse(text);
}

function withDeadline(promise, ms, label, onTimeout) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => { try { onTimeout?.(); } catch { /* best effort */ } reject(Object.assign(new Error(`${label} timed out`), { code: 'MCP_TIMEOUT' })); }, ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** The transport for one server config, or throws. HTTP goes through the pinned fetch (SSRF guard). */
export function transportFor(cfg, { allowPrivate = false, makeFetch = makePinnedFetch } = {}) {
  if (cfg && (cfg.type === 'http' || cfg.type === 'sse')) {
    let url;
    try { url = new URL(cfg.url); } catch { throw new Error('the server url is not valid'); }
    // The base-url guard refuses a query string; an MCP url may legitimately carry one, so vet the rest.
    const bare = new URL(url); bare.search = ''; bare.hash = '';
    try { assertProviderBaseUrl(bare.toString(), { allowPrivate }); }
    catch (e) { throw new SsrfBlockedError(e.message); }
    const fetchImpl = makeFetch({ allowPrivate });
    const headers = { ...(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}) };
    const requestInit = { headers, redirect: 'error' };
    return cfg.type === 'sse'
      ? new SSEClientTransport(url, { requestInit, fetch: fetchImpl, eventSourceInit: { fetch: (u, init) => fetchImpl(u, { ...init, headers: { ...(init?.headers || {}), ...headers }, redirect: 'error' }) } })
      : new StreamableHTTPClientTransport(url, { requestInit, fetch: fetchImpl });
  }
  if (!cfg || typeof cfg.command !== 'string' || !cfg.command) throw new Error('the server has no command');
  const env = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(cfg.env && typeof cfg.env === 'object' ? cfg.env : {})) if (typeof v === 'string') env[k] = v;
  return new StdioClientTransport({
    command: cfg.command,
    args: Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === 'string') : [],
    env,
    stderr: 'ignore',
  });
}

/** MCP result content to text, bounded. */
export function resultToText(result, max = MCP_LIMITS.resultChars) {
  const parts = [];
  let used = 0;
  let truncated = false;
  const push = (text) => {
    if (truncated) return;
    const room = max - used;
    if (text.length > room) { parts.push(text.slice(0, Math.max(0, room))); used = max; truncated = true; return; }
    parts.push(text); used += text.length;
  };
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') push(block.text);
    else if (block?.type === 'resource' && block.resource && typeof block.resource.text === 'string') push(block.resource.text);
    else if (block?.type === 'resource_link' && typeof block.uri === 'string') push(`[resource link: ${block.uri.slice(0, 200)}]`);
    else if (block?.type) push(`[${String(block.type).slice(0, 20)} content omitted]`);
    if (truncated) break;
  }
  if (!parts.length && result?.structuredContent !== undefined) {
    try { push(JSON.stringify(result.structuredContent)); } catch { /* skip */ }
  }
  return { text: parts.join('\n'), truncated, isError: result?.isError === true };
}

/**
 * Connect to every server in `servers` ({ id: cfg }) in parallel and list their tools.
 *
 * @param {Record<string, object>} servers
 * @param {{ signal?: AbortSignal, allowPrivate?: boolean, deps?: { transport?: Function, makeFetch?: Function, limits?: object } }} [o]
 * @returns {Promise<{ tools: Array<{ name: string, server: string, tool: string, description: string, parameters: object,
 *   call: (args: object, o?: { signal?: AbortSignal }) => Promise<{ text: string, truncated: boolean, isError: boolean }> }>,
 *   statuses: Array<{ name: string, status: 'connected'|'failed', toolCount: number, reason?: string }>,
 *   close: () => Promise<void> }>}
 */
export async function connectMcpServers(servers, { signal, allowPrivate = false, deps = {} } = {}) {
  const limits = { ...MCP_LIMITS, ...(deps.limits || {}) };
  const clients = [];
  const statuses = [];
  const found = [];   // { id, client, transport, tools: [{ t, parameters }] }

  const one = async (id, cfg) => {
    let client;
    let transport;
    try {
      transport = deps.transport ? deps.transport(id, cfg) : transportFor(cfg, { allowPrivate, makeFetch: deps.makeFetch });
      client = new Client(CLIENT_INFO, { capabilities: {} });
      clients.push({ client, transport });
      await withDeadline(client.connect(transport, { timeout: limits.connectMs, signal }), limits.connectMs, 'connect', () => transport.close?.());
      const listed = [];
      let cursor;
      for (let page = 0; page < limits.pages; page += 1) {
        const res = await withDeadline(client.listTools(cursor ? { cursor } : {}, { timeout: limits.connectMs, signal }), limits.connectMs, 'list tools');
        listed.push(...(Array.isArray(res?.tools) ? res.tools : []));
        cursor = res?.nextCursor;
        if (!cursor || listed.length >= limits.toolsPerServer * 2) break;
      }
      const usable = [];
      for (const t of listed) {
        if (usable.length >= limits.toolsPerServer) break;
        if (typeof t?.name !== 'string' || !t.name || t.name.length > 128) continue;
        const parameters = schemaOf(t);
        if (parameters) usable.push({ t, parameters });
      }
      found.push({ id, client, transport, tools: usable });
    } catch (err) {
      const blocked = err?.code === 'SSRF_BLOCKED' || err instanceof SsrfBlockedError;
      statuses.push({ name: id, status: 'failed', toolCount: 0, reason: blocked ? 'blocked' : (err?.code === 'MCP_TIMEOUT' ? 'timeout' : 'error') });
      try { await transport?.close?.(); } catch { /* already gone */ }
    }
  };

  await Promise.all(Object.entries(servers).map(([id, cfg]) => one(id, cfg)));

  // Assemble in a fixed order (server id, then tool name) so names, collisions
  // and the per-turn cap do not depend on which server answered first.
  const tools = [];
  const taken = new Set();
  found.sort((a, b) => a.id.localeCompare(b.id));
  for (const { id, client, transport, tools: usable } of found) {
    let mounted = 0;
    for (const { t, parameters } of [...usable].sort((a, b) => a.t.name.localeCompare(b.t.name))) {
      if (tools.length >= limits.toolsPerTurn) break;
      let name = modelToolName(id, t.name);
      for (let n = 2; taken.has(name); n += 1) name = `${modelToolName(id, t.name).slice(0, 58)}_${n}`;
      taken.add(name);
      const rawName = t.name;
      mounted += 1;
      tools.push({
        name, server: id, tool: rawName,
        description: cleanServerText(t.description ?? t.title ?? '', limits.descriptionChars),
        parameters,
        async call(args, { signal: callSignal } = {}) {
          const res = await withDeadline(
            client.callTool({ name: rawName, arguments: args && typeof args === 'object' ? args : {} }, undefined,
              { timeout: limits.callMs, signal: callSignal ?? signal }),
            limits.callMs, 'tool call', () => transport.close?.());
          return resultToText(res, limits.resultChars);
        },
      });
    }
    statuses.push({ name: id, status: 'connected', toolCount: mounted });
  }
  statuses.sort((a, b) => a.name.localeCompare(b.name));
  return {
    tools, statuses,
    async close() {
      await Promise.allSettled(clients.map(({ client, transport }) => Promise.resolve().then(() => client.close?.()).then(() => transport?.close?.())));
    },
  };
}
