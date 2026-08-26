// Orchestrates auto project-memory capture for one Code Assistant turn:
// resolve the active repo (through the same allow-list gate as the reader),
// extract durable facts from the turn, and merge them into chat-memory.md.
//
// Called fire-and-forget from handleCodeAssist AFTER the reply is produced, so
// it adds zero latency to the user's response. Fully best-effort: every failure
// path returns null and nothing throws.

import { buildAllowedRoots, resolveAllowedRepoRoot } from '../../graphkit/index.mjs';
import { readChatMemoryFacts, appendChatMemory } from '../../graphkit/index.mjs';
import { extractMemories } from './memory-extract.mjs';
import { appendSessionMemory, resolveChatSessionId } from '../../kb/session-memory.mjs';
import { logger } from '../../core/logger.mjs';

// Observability: every turn logs ONE `project_memory` line with `outcome` so
// "is memory working?" is answerable from the log instead of guessing. Skips log
// WHY (no target / no facts); success logs the counts + root; a genuine
// exception logs at warn.
//
// These go through `logger.audit` — an info-level line that is ALSO persisted to
// kb/server.log — NOT plain `logger.info`. The file sink is warn+, so the
// original `info` calls only ever reached stdout, which the Mac app buffers in
// memory and never writes out. The claim above was therefore false for two
// years of `grep project_memory kb/server.log`: it returned nothing whether
// capture had worked, silently skipped, or found nothing durable.
// `model` (optional) rides through to extractMemories — the caller picks the
// turn's own provider fast tier (see route.mjs's utilityModel).
export async function persistTurnMemory({ agentContext, userId, userMessage, reply, runClaude, model }) {
  try {
    const indexed = Array.isArray(agentContext?.indexedRepos) ? agentContext.indexedRepos : [];
    const wsRoot = agentContext?.workspaceRoot;
    // Candidate write targets: indexed repos first (preserves prior behavior),
    // then the open workspace folder so an un-indexed open project still
    // captures memory. Matches what renderGraphifyMemory surfaces.
    const candidatePaths = [...indexed.map((r) => r?.path), wsRoot].filter(Boolean);
    if (!userId || candidatePaths.length === 0) {
      logger.audit('project_memory', { outcome: 'skipped', reason: 'no candidate paths', hasUser: !!userId });
      return null;
    }

    const allowedRoots = buildAllowedRoots(userId, wsRoot);
    if (!allowedRoots || allowedRoots.size === 0) {
      logger.audit('project_memory', { outcome: 'skipped', reason: 'no allowed roots', candidates: candidatePaths.length });
      return null;
    }

    // Target the first allow-listed candidate — this matches what the reader
    // surfaces first, so a captured fact is recalled from the same place.
    let root = null;
    for (const p of candidatePaths) {
      root = resolveAllowedRepoRoot(p, allowedRoots);
      if (root) break;
    }
    if (!root) {
      logger.audit('project_memory', { outcome: 'skipped', reason: 'no candidate resolved to an allowed root', candidates: candidatePaths.length });
      return null;
    }

    const existing = readChatMemoryFacts(root);
    // extractMeta.approxTokens is the (estimated) cost of the extraction LLM
    // call — spent whether or not it yields facts, so it's logged on both the
    // no_facts and captured outcomes.
    const extractMeta = {};
    const { facts, superseded } = await extractMemories({
      userMessage,
      reply,
      existingFacts: existing,
      runClaude,
      userId,
      meta: extractMeta,
      model,
    });
    const extractTokens = extractMeta.approxTokens ?? 0;
    if (!facts.length && !superseded.length) {
      const reason = extractMeta.skipped
        ? 'gated: contentless turn, extraction skipped (no model call)'
        : 'extractor found nothing durable';
      logger.audit('project_memory', {
        outcome: extractMeta.skipped ? 'skipped_extraction' : 'no_facts',
        reason, extractTokens, root,
      });
      return null;
    }
    const meta = {};
    // Session memory is keyed on the CHAT session (a stable per-conversation
    // UUID owned by the client's session store), not `agentContext.sessionId` —
    // that one is re-minted on every session switch, so facts captured after a
    // switch could never be traced back to the chat the user would delete.
    // Falls back to the agent session id for a client that doesn't send one —
    // see resolveChatSessionId, shared with the read path in route.mjs.
    const sessionId = resolveChatSessionId(agentContext);
    const saved = appendChatMemory({ root, facts, remove: superseded, meta });
    // Session-scoped copy of the SAME extracted facts, in a real DB table
    // (kb/session-memory.mjs) — unlike project memory above, this IS deleted
    // wholesale when the session is cleared/removed (routes/agent.mjs's
    // DELETE /kb/agent/session-memory). Best-effort: a failure here must
    // never take down project-memory capture, which already succeeded.
    if (sessionId) {
      try {
        appendSessionMemory(userId, sessionId, facts, { remove: superseded });
      } catch { /* best-effort */ }
    }
    const added = meta.added ?? Math.max(0, (Array.isArray(saved) ? saved.length : 0) - existing.length);
    logger.audit('project_memory', {
      outcome: 'captured', extracted: facts.length, added,
      // `updated` = facts whose index (factKey) was already stored and whose
      // text changed, so the stored copy was replaced in place.
      updated: meta.updated ?? 0,
      removedCount: meta.removed ?? 0, removedFacts: superseded,
      evicted: meta.evicted ?? 0,
      extractTokens, total: saved.length, root,
    });
    return saved;
  } catch (err) {
    // Best-effort capture must never break the turn — but a real failure should
    // be visible (warn → persisted to kb/server.log), not swallowed silently.
    logger.warn('project_memory', { outcome: 'error', err: err?.message || String(err) });
    return null;
  }
}
