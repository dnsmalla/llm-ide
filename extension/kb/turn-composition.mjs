// Per-turn prompt composition (migration 0040). Best-effort by contract, like
// tool-events.mjs: a telemetry write must never break a model turn.
import { getDb, requireUser } from './db.mjs';

const clampInt = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(v)))) : null);
const clampStr = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

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
    getDb().prepare(
      `INSERT INTO turn_composition
         (user_id, turn_id, mode, model, resumed, system_prompt_kind, system_chars, prompt_chars,
          attached_files, attachment_chars, images, tools, mcp_tools, mcp_servers, agents, skills,
          slash_commands, claude_code_version, api_calls, first_call_prompt_tokens, first_call_cache_read_tokens,
          first_call_cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId, clampStr(row.turnId, 128), clampStr(row.mode, 32), clampStr(row.model, 128), row.resumed ? 1 : 0,
      clampStr(row.systemPromptKind, 16), clampInt(row.systemChars), clampInt(row.promptChars),
      clampInt(row.attachedFiles), clampInt(row.attachmentChars), clampInt(row.images),
      clampInt(row.tools), clampInt(row.mcpTools), servers || null, clampInt(row.agents), clampInt(row.skills),
      clampInt(row.slashCommands), clampStr(row.claudeCodeVersion, 32), clampInt(row.apiCalls),
      firstPrompt == null ? null : clampInt(firstPrompt), first ? clampInt(first.cacheReadTokens) : null,
      first ? clampInt(first.cacheCreationTokens) : null,
    );
    return true;
  } catch {
    return false;
  }
}
