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
import { logger } from '../../core/logger.mjs';

// Observability: every turn logs ONE `project_memory` line with `outcome` so
// "is memory working?" is answerable from the log instead of guessing. Skips
// log WHY (no target / no facts) at info; a genuine exception logs at warn (so
// it also lands in the on-disk crash log). Success logs the count + root.
export async function persistTurnMemory({ agentContext, userId, userMessage, reply, runClaude }) {
  try {
    const indexed = Array.isArray(agentContext?.indexedRepos) ? agentContext.indexedRepos : [];
    const wsRoot = agentContext?.workspaceRoot;
    // Candidate write targets: indexed repos first (preserves prior behavior),
    // then the open workspace folder so an un-indexed open project still
    // captures memory. Matches what renderGraphifyMemory surfaces.
    const candidatePaths = [...indexed.map((r) => r?.path), wsRoot].filter(Boolean);
    if (!userId || candidatePaths.length === 0) {
      logger.info('project_memory', { outcome: 'skipped', reason: 'no candidate paths', hasUser: !!userId });
      return null;
    }

    const allowedRoots = buildAllowedRoots(userId, wsRoot);
    if (!allowedRoots || allowedRoots.size === 0) {
      logger.info('project_memory', { outcome: 'skipped', reason: 'no allowed roots', candidates: candidatePaths.length });
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
      logger.info('project_memory', { outcome: 'skipped', reason: 'no candidate resolved to an allowed root', candidates: candidatePaths.length });
      return null;
    }

    const existing = readChatMemoryFacts(root);
    const facts = await extractMemories({
      userMessage,
      reply,
      existingFacts: existing,
      runClaude,
      userId,
    });
    if (!facts.length) {
      logger.info('project_memory', { outcome: 'no_facts', reason: 'extractor found nothing durable', root });
      return null;
    }
    const saved = appendChatMemory({ root, facts });
    const added = Math.max(0, (Array.isArray(saved) ? saved.length : 0) - existing.length);
    logger.info('project_memory', { outcome: 'captured', extracted: facts.length, added, total: saved.length, root });
    return saved;
  } catch (err) {
    // Best-effort capture must never break the turn — but a real failure should
    // be visible (warn → persisted to kb/server.log), not swallowed silently.
    logger.warn('project_memory', { outcome: 'error', err: err?.message || String(err) });
    return null;
  }
}
