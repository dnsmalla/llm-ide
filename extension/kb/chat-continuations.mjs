// Per-chat continuation summaries (ended-chat continuation, plan 2026-11-07-ended-chat-continuation.md;
// migration 0065). Derived data: made from the chat's own record, rebuilt on a hash miss, never the only
// copy. Stored like the chat's messages: per user, redacted at the write. Every helper takes userId first.
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { redactSecretsForStorage } from '../core/redact-secrets.mjs';

export const CONTINUATION_SUMMARY_MAX = 20_000;
const SOURCES = new Set(['server', 'client']);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

export function getContinuation(userId, chatSessionId) {
  requireUser(userId);
  const row = lazyPrepare(getDb(), `
    SELECT summary, content_hash, covered_turns, source, model, input_tokens, output_tokens, updated_at
      FROM chat_continuations WHERE user_id = ? AND chat_session_id = ?
  `).get(userId, chatSessionId);
  if (!row) return null;
  return { summary: row.summary, contentHash: row.content_hash, coveredTurns: row.covered_turns, source: row.source, model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, updatedAt: row.updated_at };
}

export function putContinuation(userId, chatSessionId, { summary, contentHash, coveredTurns, source, model = null, inputTokens = null, outputTokens = null } = {}) {
  requireUser(userId);
  if (typeof chatSessionId !== 'string' || !chatSessionId) throw new Error('chatSessionId is required');
  const text = redactSecretsForStorage(String(summary ?? '').slice(0, CONTINUATION_SUMMARY_MAX));
  if (!text.trim()) throw new Error('summary is required');
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('contentHash must be a sha256 hex digest');
  if (!SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
  lazyPrepare(getDb(), `
    INSERT INTO chat_continuations
      (user_id, chat_session_id, summary, content_hash, covered_turns, source, model, input_tokens, output_tokens, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (user_id, chat_session_id) DO UPDATE SET
      summary = excluded.summary, content_hash = excluded.content_hash, covered_turns = excluded.covered_turns,
      source = excluded.source, model = excluded.model, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, updated_at = excluded.updated_at
  `).run(userId, chatSessionId, text, contentHash, count(coveredTurns) ?? 0, source, model == null ? null : String(model).slice(0, 128), count(inputTokens), count(outputTokens));
}

/** Removes the chat's row (`clientOnly`: only a row made from a client's history). Returns the rows removed. */
export function deleteContinuation(userId, chatSessionId, { clientOnly = false } = {}) {
  requireUser(userId);
  return lazyPrepare(getDb(), clientOnly
    ? "DELETE FROM chat_continuations WHERE user_id = ? AND chat_session_id = ? AND source = 'client'"
    : 'DELETE FROM chat_continuations WHERE user_id = ? AND chat_session_id = ?').run(userId, chatSessionId).changes;
}
