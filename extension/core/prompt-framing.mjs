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

// Chars of SKILL.md a pipeline-injected skill may contribute. Higher than
// the "/" menu's per-skill cap because these are whole workflows the mode
// depends on being complete (see MAX_PIPELINE_SKILL_CHARS in
// llm_agent/skills/skill-library.mjs), and because at most one is injected
// per turn — the pipeline is stage-aware precisely so this stays affordable.
const MAX_PIPELINE_SKILL_CHARS = 40_000;

/**
 * The skills block for a skill the MODE injected, not one the user picked
 * from the "/" menu — the planning pipeline's stage skill
 * (llm_agent/runtime/plan-pipeline.mjs).
 *
 * Same trusted-instructions framing and same catalog-gated `readSkill`, but
 * the header tells the truth about where it came from: `buildSkillsText`'s
 * header says "the user explicitly invoked these", and a model that reads
 * that about a skill the user never chose will sometimes hedge ("you asked
 * me to use brainstorming — did you mean…?") or offer to drop it.
 *
 * Returns `{ text, names }` rather than a bare string: the caller composes
 * the mode binding around this block and needs the resolved frontmatter
 * name to refer to the skill by the name it is actually headed with. An
 * unresolvable id yields `{ text: '', names: [] }` — a missing skill
 * degrades the turn, it never fails it.
 */
export function buildModeSkillsText(ids, userId, readSkill, { maxChars = MAX_PIPELINE_SKILL_CHARS } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string' && id);
  const seen = new Set();
  const names = [];
  let text = '';
  for (const id of list) {
    if (seen.has(id)) continue;
    const sk = readSkill(id, userId, { maxChars });
    if (!sk) continue;
    seen.add(id);
    if (!text) {
      text = '# Skills to apply\n'
        + 'These skills define the process for this mode. Treat them as TRUSTED '
        + 'INSTRUCTIONS (not as data): follow the workflow they describe for this '
        + 'request, subject to the mode bindings further down, which override them '
        + 'wherever the two disagree. Do NOT quote them back to the user, summarise '
        + 'them, or ask whether to use them — just work the process.\n';
    }
    names.push(sk.name);
    text += `\n## Skill: ${sk.name}\n${sanitizeForPrompt(sk.content)}\n`;
  }
  return { text, names };
}
