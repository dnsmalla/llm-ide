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

export async function persistTurnMemory({ agentContext, userId, userMessage, reply, runClaude }) {
  try {
    const repos = agentContext?.indexedRepos;
    if (!userId || !Array.isArray(repos) || repos.length === 0) return null;

    const allowedRoots = buildAllowedRoots(userId);
    if (!allowedRoots || allowedRoots.size === 0) return null;

    // Target the first allow-listed indexed repo — this matches what the reader
    // surfaces first, so a captured fact is recalled from the same place.
    let root = null;
    for (const r of repos) {
      root = resolveAllowedRepoRoot(r?.path, allowedRoots);
      if (root) break;
    }
    if (!root) return null;

    const existing = readChatMemoryFacts(root);
    const facts = await extractMemories({
      userMessage,
      reply,
      existingFacts: existing,
      runClaude,
      userId,
    });
    if (!facts.length) return null;
    return appendChatMemory({ root, facts });
  } catch {
    return null;
  }
}
