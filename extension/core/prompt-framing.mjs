// Shared prompt-framing primitives: attachment selection/capping and
// skill-instruction blocks. Both server/ai-routes.mjs (legacy /code-assist,
// L4 routes) and llm_agent/sdk/engine.mjs (v2 engine, L3) need the exact
// same caps and TRUSTED-INSTRUCTIONS framing; L3 cannot import L4, so this
// lives in core (L0) as the one shared definition instead of two
// hand-synced copies.

import { sanitizeForPrompt, sanitizeLine } from './utils.mjs';

const HOME_PREFIX_RE = /^\/Users\/[^/]+\//;

/// Select + clamp code-assist attachments under the prompt-size caps,
/// reporting which files were CUT. Pure (no I/O) so it's unit-testable.
///
/// `truncatedPaths` is the data-loss guard: the agent only sees the head
/// of a cut file, so the Mac client must refuse to auto-overwrite it with
/// a "full rewrite" built from that partial view (it would drop the tail).
export function selectAttachments(rawFiles, {
  maxFiles = 30,
  maxPerFileChars = 80_000,
  maxTotalChars = 200_000,
} = {}) {
  const list = Array.isArray(rawFiles) ? rawFiles.slice(0, maxFiles) : [];
  const seen = new Set();
  const files = [];
  const truncatedPaths = [];
  let totalChars = 0;
  for (const f of list) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    // Normalize path display: strip any literal home dir for privacy in the
    // prompt (user's $HOME → ~). These are display labels for the LLM, not reads.
    const path = sanitizeLine(f.path, 200).replace(HOME_PREFIX_RE, '~/');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const sanitized = sanitizeForPrompt(f.content);
    let content = sanitized.slice(0, maxPerFileChars);
    let truncated = content.length < sanitized.length;      // per-file cap cut it
    if (totalChars + content.length > maxTotalChars) {
      content = content.slice(0, maxTotalChars - totalChars);
      truncated = truncated || content.length < sanitized.length; // total cap cut it
    }
    if (!content) continue;
    files.push({ path, content });
    if (truncated) truncatedPaths.push(path);
    totalChars += content.length;
    if (totalChars >= maxTotalChars) break;
  }
  return { files, totalChars, truncatedPaths };
}

const MAX_SKILLS = 5;

/// Skills the user explicitly invoked from their library ("/" menu). These
/// are followable INSTRUCTIONS, not attachment data: `readSkill` is
/// injected so the caller controls trust (catalog-gated local skill repo),
/// not this module — unknown ids are silently ignored (no arbitrary reads).
export function buildSkillsText(skills, userId, readSkill) {
  const rawSkillIds = Array.isArray(skills) ? skills.slice(0, MAX_SKILLS) : [];
  const seenSkill = new Set();
  let skillsText = '';
  for (const id of rawSkillIds) {
    if (typeof id !== 'string' || seenSkill.has(id)) continue;
    const sk = readSkill(id, userId);
    if (!sk) continue; // unknown id — silently ignored
    seenSkill.add(id);
    if (!skillsText) {
      skillsText = `# Skills to apply\n`
        + `The user explicitly invoked these skills from their own skills library. `
        + `Treat them as TRUSTED INSTRUCTIONS from the user (not as data): follow each `
        + `skill's workflow for this request. Do NOT edit or rewrite the skill text itself `
        + `unless the user asks you to.\n`;
    }
    skillsText += `\n## Skill: ${sk.name}\n${sanitizeForPrompt(sk.content)}\n`;
  }
  return skillsText;
}
