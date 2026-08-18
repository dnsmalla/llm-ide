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
// Only modules in this directory (llm_agent/sdk/) may import
// '@anthropic-ai/claude-agent-sdk' (the isolation rule from the
// staying-current design: upstream churn is confined to this surface).
// The spike is no longer the sole SDK importer: engine.mjs (the v2 chat
// engine's option composition + shared auth ladder) lives here too, and its
// runner layer joins this file in importing the SDK. The SDK is exact-pinned
// in package.json — a bump is a deliberate, reviewed change (canary CI is
// the plan for P1.5).
//
// Event model: the pure mapper lives in events.mjs (the single definition
// of the v2 event vocabulary) and is re-exported here so existing spike
// consumers keep importing it from this module. The llmide in-process MCP
// server lives in tools.mjs. Auth (resolveAnthropicKey) lives in engine.mjs
// and is re-exported below for existing importers.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { mapSdkMessage } from './events.mjs';
import { buildLlmIdeServer } from './tools.mjs';
import { resolveAnthropicKey } from './engine.mjs';

export { mapSdkMessage };
export { resolveAnthropicKey };

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
