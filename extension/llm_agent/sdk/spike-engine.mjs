// P0 SPIKE — Claude Agent SDK engine behind /agent-sdk/spike.
//
// Purpose: prove the three load-bearing assumptions of the Mac-chat engine
// swap with running code, before designing the P1 wire protocol:
//   1. A streaming query() (includePartialMessages) can be forwarded as SSE.
//   2. An LLM-IDE domain function (KB search) registers as an in-process
//      SDK MCP tool (createSdkMcpServer) and the model actually calls it.
//   3. Vault per-user ANTHROPIC_API_KEY auth works through the SDK `env`
//      option.
//
// This module is the ONLY file that imports '@anthropic-ai/claude-agent-sdk'
// (the isolation rule from the staying-current design: upstream churn is
// confined to one module). The SDK is exact-pinned in package.json — a bump
// is a deliberate, reviewed change (canary CI is the plan for P1.5).
//
// Event model: `mapSdkMessage()` emits a small, engine-agnostic set
// (init/delta/tool_use_start/tool_args_delta/tool_result/result) plus a
// generic `sdk` passthrough carrying the raw message for anything unmapped —
// the forward-compatibility rule ("open set, ignore unknown values") so new
// upstream capabilities are observable on the wire from day one.

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as kb from '../../kb/db.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret } from '../../server/vault.mjs';
import { redactFence } from '../runtime/redaction.mjs';

const MAX_TOOL_RESULT_CHARS = 20_000;

// --- Pure event mapping (unit-tested; no SDK objects required) ------------

function textOfToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text);
  return parts.join('\n');
}

// Map one SDK message → array of wire events (usually 0..2). Exported pure
// so tests can drive it with fabricated messages and the P1 protocol design
// can be reviewed against real transcripts without a live engine.
export function mapSdkMessage(msg) {
  if (!msg || typeof msg !== 'object') return [];

  if (msg.type === 'system' && msg.subtype === 'init') {
    return [{
      type: 'init',
      sessionId: msg.session_id ?? null,
      claudeCodeVersion: msg.claude_code_version ?? null,
      model: msg.model ?? null,
      tools: Array.isArray(msg.tools) ? msg.tools : [],
      capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : [],
      mcpServers: Array.isArray(msg.mcp_servers)
        ? msg.mcp_servers.map((s) => ({ name: s?.name, status: s?.status }))
        : [],
    }];
  }

  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (!ev || typeof ev !== 'object') return [];
    if (ev.type === 'content_block_start') {
      const block = ev.content_block;
      if (block?.type === 'tool_use') {
        return [{ type: 'tool_use_start', id: block.id ?? null, name: block.name ?? null }];
      }
      return [];
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        return [{ type: 'delta', text: d.text }];
      }
      if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        return [{ type: 'tool_args_delta', partialJson: d.partial_json }];
      }
      return [];
    }
    return [];
  }

  if (msg.type === 'user') {
    const blocks = msg?.message?.content;
    if (!Array.isArray(blocks)) return [];
    return blocks
      .filter((b) => b?.type === 'tool_result')
      .map((b) => ({
        type: 'tool_result',
        toolUseId: b.tool_use_id ?? null,
        isError: b.is_error === true,
        // Tool outputs can be huge; the Mac renders a summary, the raw stays
        // server-side. Truncation is marked so the UI can say "truncated".
        text: textOfToolResultContent(b.content).slice(0, MAX_TOOL_RESULT_CHARS),
        truncated: textOfToolResultContent(b.content).length > MAX_TOOL_RESULT_CHARS,
      }));
  }

  if (msg.type === 'result') {
    return [{
      type: 'result',
      subtype: msg.subtype ?? null,
      costUsd: msg.total_cost_usd ?? null,
      numTurns: msg.num_turns ?? null,
      durationMs: msg.duration_ms ?? null,
      sessionId: msg.session_id ?? null,
      stopReason: msg.stop_reason ?? null,
    }];
  }

  // Everything else (compact_boundary, informational, api_retry, complete
  // assistant messages, …) rides the observation channel unchanged.
  return [{ type: 'sdk', sdkType: msg.type, subtype: msg.subtype ?? null, raw: msg }];
}

// --- Domain tool: KB search as an in-process SDK MCP tool -----------------

function buildLlmIdeServer(userId) {
  const kbSearch = tool(
    'kb_search',
    'Full-text search across the user\'s LLM-IDE knowledge base (meetings, decisions, action items, ingested sources). Use this whenever a question might be answered by past meetings or project notes.',
    {
      query: z.string().describe('Free-text search query'),
      limit: z.number().int().max(50).default(10).describe('Max hits to return'),
    },
    async (args) => {
      const raw = await Promise.resolve(kb.search(userId, { q: args.query, kind: null, limit: args.limit }));
      const list = Array.isArray(raw) ? raw : [];
      const hits = list.map((h) => ({
        kind: redactFence(h.kind),
        id: h.id != null ? redactFence(String(h.id)) : '',
        title: redactFence(h.title || ''),
        snippet: redactFence(h.snippet || ''),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ hits, total: list.length }) }] };
    },
    { annotations: { readOnlyHint: true }, alwaysLoad: true },
  );

  return createSdkMcpServer({
    name: 'llmide',
    version: '0.1.0',
    instructions: 'LLM-IDE domain tools. kb_search queries the local knowledge base.',
    tools: [kbSearch],
  });
}

// --- Auth: per-user vault key first, operator env as fallback -------------

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

// --- The spike query -------------------------------------------------------

export async function runSpikeQuery({ prompt, userId, onEvent, signal, resume, allowAmbientAuth = false }) {
  const { key, source } = resolveAnthropicKey(userId);
  // Same auth ladder as runClaude: per-user vault key → operator ambient
  // auth (the SDK subprocess finds the operator's own `claude` login).
  // Ambient auth is opt-in so hermetic tests can assert the no-key error.
  if (!key && !allowAmbientAuth) {
    throw new Error('No Anthropic API key available (set vault claude.apiKey or ANTHROPIC_API_KEY)');
  }

  const q = query({
    prompt,
    options: {
      // Live token + tool-args deltas — the stream a chat UI needs.
      includePartialMessages: true,
      // Full isolation from the operator's own Claude config: no user
      // hooks/skills/plugins/CLAUDE.md leak in (same policy as the CLI
      // fallback's --setting-sources ''). Credentials are not settings —
      // ambient auth still works through the subprocess.
      settingSources: [],
      // Only our read-only domain tool is pre-approved; everything else a
      // headless turn might reach for stays un-allowed (and the spike
      // provides no canUseTool, so it would be denied rather than hang).
      allowedTools: ['mcp__llmide__kb_search'],
      mcpServers: { llmide: buildLlmIdeServer(userId) },
      // Spike guardrails: short leash, no resume yet.
      maxTurns: 8,
      // `env` REPLACES the subprocess environment — always spread process.env.
      ...(key ? { env: { ...process.env, ANTHROPIC_API_KEY: key } } : {}),
      ...(signal ? { signal } : {}),
      ...(resume ? { resume } : {}),
    },
  });

  let lastResult = null;
  let sessionId = null;
  for await (const msg of q) {
    if (sessionId === null && msg?.session_id) sessionId = msg.session_id;
    for (const ev of mapSdkMessage(msg)) {
      if (ev.type === 'result') lastResult = ev;
      onEvent?.(ev);
    }
  }
  return { sessionId, result: lastResult, keySource: source };
}
