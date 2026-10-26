// Per-turn prompt composition (migrations 0040 and 0044). Best-effort by
// contract, like tool-events.mjs: a telemetry write must never break a model
// turn.
import { getDb, requireUser } from './db.mjs';

const clampInt = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(v)))) : null);
const clampStr = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
// Nullable variant for the 0044 columns: a missing value stays NULL (not 0),
// so "not measured" never reads as "measured as nothing".
const intOrNull = (v) => (v == null ? null : clampInt(v));
// Approximate tokens from chars: chars / 4 (no tokenizer; a rough estimate).
const approxTokens = (chars) => (chars == null || !Number.isFinite(Number(chars))
  ? null : Math.max(0, Math.min(1_000_000_000, Math.ceil(Number(chars) / 4))));

// The SDK's getContextUsage categories, mapped by name (the SDK's own names,
// see llm_agent/sdk/events.mjs). Summed when a name matches more than once.
function sdkTokensFor(categories, pattern) {
  const hits = categories.filter((c) => pattern.test(c.name));
  return hits.length ? intOrNull(hits.reduce((n, c) => n + (Number(c.tokens) || 0), 0)) : null;
}

/**
 * Store one turn's composition. Returns true when a row was written.
 * `row.firstCall` is the first API response's usage; its prompt size is
 * input + cache write + cache read.
 */
export function recordTurnComposition(userId, row) {
  try {
    requireUser(userId);
    if (!row || typeof row !== 'object') return false;
    if (typeof row.turnId !== 'string' || !row.turnId) return false;
    const first = row.firstCall && typeof row.firstCall === 'object' ? row.firstCall : null;
    const firstPrompt = first
      ? (Number(first.inputTokens) || 0) + (Number(first.cacheCreationTokens) || 0) + (Number(first.cacheReadTokens) || 0)
      : null;
    const servers = Array.isArray(row.mcpServers)
      ? row.mcpServers.filter((s) => typeof s === 'string' && s).map((s) => s.slice(0, 64)).join(',').slice(0, 512)
      : null;
    const categories = Array.isArray(row.sdkCategories)
      ? row.sdkCategories.filter((c) => c && typeof c.name === 'string' && Number.isFinite(Number(c.tokens)))
      : [];
    const sdkCategories = categories.length
      ? categories.map((c) => `${String(c.name).slice(0, 64)}=${clampInt(c.tokens)}`).join(';').slice(0, 1024)
      : null;
    // Column/value pairs, in one place so the INSERT cannot drift from them.
    const cols = [
      ['user_id', userId],
      ['turn_id', clampStr(row.turnId, 128)],
      ['mode', clampStr(row.mode, 32)],
      ['model', clampStr(row.model, 128)],
      ['resumed', row.resumed ? 1 : 0],
      ['system_prompt_kind', clampStr(row.systemPromptKind, 16)],
      ['system_chars', clampInt(row.systemChars)],
      ['prompt_chars', clampInt(row.promptChars)],
      ['attached_files', clampInt(row.attachedFiles)],
      ['attachment_chars', clampInt(row.attachmentChars)],
      ['images', clampInt(row.images)],
      ['tools', clampInt(row.tools)],
      ['mcp_tools', clampInt(row.mcpTools)],
      ['mcp_servers', servers || null],
      ['agents', clampInt(row.agents)],
      ['skills', clampInt(row.skills)],
      ['slash_commands', clampInt(row.slashCommands)],
      ['claude_code_version', clampStr(row.claudeCodeVersion, 32)],
      ['api_calls', clampInt(row.apiCalls)],
      ['first_call_prompt_tokens', firstPrompt == null ? null : clampInt(firstPrompt)],
      ['first_call_cache_read_tokens', first ? clampInt(first.cacheReadTokens) : null],
      ['first_call_cache_creation_tokens', first ? clampInt(first.cacheCreationTokens) : null],
      // Migration 0044. `*_tokens` = chars / 4 of LLM-IDE text (estimate).
      ['system_prompt_tokens', approxTokens(row.systemChars)],
      ['skills_append_tokens', approxTokens(row.skillsAppendChars)],
      ['llmide_tool_tokens', approxTokens(row.llmideToolChars)],
      ['user_mcp_servers', intOrNull(row.userMcpServers)],
      ['context_fence_tokens', approxTokens(row.contextChars)],
      ['memory_fence_tokens', approxTokens(row.memoryChars)],
      ['skills_fence_tokens', approxTokens(row.skillsFenceChars)],
      ['tool_result_chars', intOrNull(row.toolResultChars)],
      ['tool_result_tokens', approxTokens(row.toolResultChars)],
      // The SDK's own end-of-turn categories (estimates, not ours).
      ['sdk_context_total_tokens', intOrNull(row.sdkContextTotalTokens)],
      ['sdk_system_prompt_tokens', sdkTokensFor(categories, /system prompt/i)],
      ['sdk_system_tools_tokens', sdkTokensFor(categories, /system tools/i)],
      ['sdk_mcp_tools_tokens', sdkTokensFor(categories, /mcp tools/i)],
      ['sdk_memory_tokens', sdkTokensFor(categories, /memory/i)],
      ['sdk_messages_tokens', sdkTokensFor(categories, /messages/i)],
      ['sdk_categories', sdkCategories],
    ];
    getDb().prepare(
      `INSERT INTO turn_composition (${cols.map(([c]) => c).join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...cols.map(([, v]) => v));
    return true;
  } catch {
    return false;
  }
}

/**
 * The newest turns' composition for one user, newest first. Every query is
 * scoped by userId (repo convention); `limit` is clamped to 1..200.
 */
export function turnCompositionRecent(userId, { limit = 50 } = {}) {
  requireUser(userId);
  const n = Math.max(1, Math.min(200, clampInt(limit) || 50));
  const rows = getDb().prepare(
    'SELECT * FROM turn_composition WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(userId, n);
  return rows.map(({ id: _id, user_id: _uid, ...rest }) => Object.fromEntries(
    Object.entries(rest).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()), v]),
  ));
}
