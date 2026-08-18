// Pure SDK-message → wire-event mapping for the v2 chat engine.
//
// This module is deliberately dependency-free (no SDK import, no DB): the
// mapper consumes plain message objects, so tests drive it with fabricated
// input and the protocol design can be reviewed against real transcripts
// without a live engine. SDK-facing modules (spike-engine.mjs, the v2
// engine) import the mapper from here — it is the single definition of the
// v2 event vocabulary.
//
// Event model: `mapSdkMessage()` emits a small, engine-agnostic set
// (init/delta/tool_use_start/tool_args_delta/tool_result/usage/result) plus
// a generic `sdk` passthrough carrying the raw message for anything
// unmapped — the forward-compatibility rule ("open set, ignore unknown
// values") so new upstream capabilities are observable on the wire from
// day one.

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
// so tests can drive it with fabricated messages and the v2 protocol design
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
      // Block index disambiguates concurrent tool calls in one assistant
      // turn (the Mac buffers partial args per index).
      if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        return [{ type: 'tool_args_delta', index: ev.index ?? 0, partialJson: d.partial_json }];
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

  if (msg.type === 'assistant') {
    const u = msg?.message?.usage;
    if (u && (u.input_tokens != null || u.output_tokens != null)) {
      return [{ type: 'usage', inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0 }];
    }
    // A complete assistant message without a usage block adds nothing — its
    // text already streamed as delta events.
    return [];
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

  // Everything else (compact_boundary, informational, api_retry, …) rides
  // the observation channel unchanged.
  return [{ type: 'sdk', sdkType: msg.type, subtype: msg.subtype ?? null, raw: msg }];
}
