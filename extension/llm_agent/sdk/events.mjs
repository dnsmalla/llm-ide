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

import { adoptEnabled } from './adopt.mjs';

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
        // `index` is the same block index `tool_args_delta` carries. Without it
        // the client cannot tell WHICH open tool call a partial-args delta
        // belongs to, so it could not assemble arguments at all — which is why
        // the Mac used to drop them. See schema/agent-v2/SCHEMA.md.
        return [{
          type: 'tool_use_start',
          index: ev.index ?? 0,
          id: block.id ?? null,
          name: block.name ?? null,
        }];
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
      // `cache_creation_input_tokens` is the one that was missing, and it is
      // the expensive one: tokens written INTO the cache bill at ~1.25x, and
      // they are created by exactly the prompt-prefix churn this app wants to
      // see. Without it the ledger reported a turn's fresh input only.
      // `messageId`: streamed, each content block of ONE API response is its
      // own assistant message carrying that response's usage snapshot — the
      // runner counts each response once, not once per block.
      return [{ type: 'usage', messageId: msg.message.id ?? null,
        inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0 }];
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
      // Per-model token totals for the whole query — the SDK's documented
      // field for accounting (see the runner's usage handling).
      modelUsage: msg.modelUsage ?? null,
      // Main-loop usage for this turn (snake_case, as the API reports it).
      usage: msg.usage ?? null,
    }];
  }

  // SDK signals the app understands (retry, rate limit, permission denial,
  // refusal and model fallback) become one `notice` event. A switched-off
  // capability, a malformed message and every type we do not know fall through
  // to the observation channel below, unchanged.
  const notice = mapNotice(msg);
  if (notice) return [notice];

  // Thinking-token estimates arrive many times per turn. They are metered by
  // the engine from the raw message (usageTotals.thinkingTokens), not shown, so
  // they do not ride the observation channel either once adopted.
  if (msg.type === 'system' && msg.subtype === 'thinking_tokens' && adoptEnabled('THINKING_TOKENS')
    && Number.isFinite(msg.estimated_tokens_delta)) return [];

  // Everything else (compact_boundary, informational, …) rides
  // the observation channel unchanged.
  return [{ type: 'sdk', sdkType: msg.type, subtype: msg.subtype ?? null, raw: msg }];
}

// --- Notices (K1 P2: A2 retry, A3 rate limit, A4 permission denied, A7 refusal)

const NOTICE_TEXT_CAP = 300;
const clip = (v, cap = NOTICE_TEXT_CAP) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, cap) : '');
const str = (v, cap = 128) => (typeof v === 'string' && v ? v.slice(0, cap) : null);
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

// `level` is the only thing a client needs to decide visibility: `info` is a
// state signal for the server (audit, limits) that no UI should show;
// `warning` and `error` are meant for the user. A `notice` never carries the
// key `model`: the route meters under the first event's `model`, and a
// fallback notice must not rename the turn's metered model.
function notice(kind, level, text, data) {
  return { type: 'notice', kind, level, text: clip(text), data };
}

/**
 * One adopted SDK message → a `notice` event, or null when the message is not
 * one of them, its capability is switched off, or it is too malformed to
 * describe (those stay on the `sdk` observation channel). Exported pure for
 * tests.
 */
export function mapNotice(msg) {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'rate_limit_event' && adoptEnabled('RATE_LIMIT')) {
    const info = msg.rate_limit_info;
    if (!info || typeof info !== 'object') return null;
    // An unknown status is never read as `allowed`: it is reported as 'unknown'
    // and shown as a warning, so a newer SDK's new value cannot look healthy.
    const status = ['allowed', 'allowed_warning', 'rejected'].includes(info.status) ? info.status : 'unknown';
    const level = status === 'allowed' ? 'info' : (status === 'rejected' ? 'error' : 'warning');
    const kindLabel = str(info.rateLimitType, 40);
    const text = status === 'rejected' ? `Claude usage limit reached${kindLabel ? ` (${kindLabel})` : ''}.`
      : status === 'allowed' ? 'Claude usage within limits.'
      : `Approaching the Claude usage limit${kindLabel ? ` (${kindLabel})` : ''}.`;
    return notice('rate_limit', level, text, {
      status, rateLimitType: kindLabel, resetsAt: int(info.resetsAt),
      utilization: Number.isFinite(info.utilization) ? info.utilization : null,
      isUsingOverage: info.isUsingOverage === true || info.overageInUse === true,
    });
  }

  if (msg.type !== 'system') return null;

  if (msg.subtype === 'api_retry' && adoptEnabled('RETRY')) {
    const attempt = int(msg.attempt);
    const max = int(msg.max_retries);
    if (attempt === null || max === null) return null;
    const delay = int(msg.retry_delay_ms) ?? 0;
    return notice('retry', 'warning',
      `The model API is not responding (attempt ${attempt} of ${max}); retrying in ${seconds(delay)}.`,
      { attempt, maxRetries: max, retryDelayMs: delay, errorStatus: int(msg.error_status), noResponse: !!msg.no_response });
  }

  if (msg.subtype === 'permission_denied' && adoptEnabled('PERMISSION_DENIED')) {
    const tool = str(msg.tool_name);
    if (!tool) return null;
    // Audit only: the denied call already shows as an errored tool step, so the
    // UI does not need a second line (level info).
    return notice('permission_denied', 'info', `Permission denied for ${tool}.`, {
      toolName: tool, toolUseId: str(msg.tool_use_id),
      reasonType: str(msg.decision_reason_type, 64), subagent: typeof msg.agent_id === 'string' && msg.agent_id !== '',
    });
  }

  if (msg.subtype === 'model_refusal_fallback' && adoptEnabled('REFUSAL')) {
    const from = str(msg.original_model);
    const to = str(msg.fallback_model);
    if (!from || !to) return null;
    return notice('model_fallback', 'warning',
      `${from} declined this request; continued on ${to}.`,
      { fromModel: from, toModel: to, direction: str(msg.direction, 16), scope: str(msg.scope, 16) ?? 'session',
        category: str(msg.api_refusal_category, 64),
        retractedMessages: Array.isArray(msg.retracted_message_uuids) ? msg.retracted_message_uuids.length : 0 });
  }

  if (msg.subtype === 'model_refusal_no_fallback' && adoptEnabled('REFUSAL')) {
    const from = str(msg.original_model);
    return notice('refusal', 'error',
      `${from ?? 'The model'} declined this request and there is no fallback model.`,
      { fromModel: from, category: str(msg.api_refusal_category, 64) });
  }

  return null;
}

/**
 * SDK `getContextUsage()` response → the `context_usage` wire event.
 *
 * Every value is the SDK's own: the window is `rawMaxTokens` (the one
 * auto-compaction measures against), and category names and kinds pass
 * through untouched so a category a newer SDK adds shows up with no change
 * here or in the Mac app. No `model` field on purpose — the route takes any
 * event's `model` as the turn's metered model.
 */
export function mapContextUsage(r) {
  if (!r || !Number.isFinite(r.totalTokens) || !Number.isFinite(r.rawMaxTokens)) return null;
  const categories = (Array.isArray(r.categories) ? r.categories : [])
    .filter((c) => c && typeof c.name === 'string' && Number.isFinite(c.tokens))
    .map((c) => ({ name: c.name, kind: typeof c.kind === 'string' && c.kind ? c.kind : 'used', tokens: Math.round(c.tokens) }));
  return {
    type: 'context_usage',
    // Rounded: the wire schema types these as integers and the Mac decodes Int,
    // so one fractional SDK value would make it drop the whole event.
    totalTokens: Math.round(r.totalTokens),
    maxTokens: Math.round(r.rawMaxTokens),
    percentage: Number.isFinite(r.percentage) ? Math.round(r.percentage) : 0,
    categories,
  };
}
