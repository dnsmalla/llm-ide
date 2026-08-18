// Pure option composition for the v2 chat engine (the Agent-SDK-powered
// successor of the CLI loop behind the Mac chat).
//
// `buildEngineOptions()` maps a Mac chat request onto Claude Agent SDK
// `query()` options — mode → permissionMode/persona, the read-only tool
// allowlist, skills text, cwd + additional directories, and the
// preset+append system prompt — WITHOUT starting a query. Everything here
// is pure composition; the runner (runAgentV2Turn, added on top of this
// module) owns the query lifecycle, the llmide in-process MCP server, key
// auth, resume, and event mapping. That split keeps this file testable with
// injected readSkill/roots fakes (no DB, no filesystem, no SDK subprocess).
//
// No SDK import (yet): composing options is plain data, so this module stays
// loadable everywhere the SDK isn't. The runner layer adds the SDK import —
// still inside llm_agent/sdk/ per the isolation rule (only this directory
// may import '@anthropic-ai/claude-agent-sdk').
//
// Framing notes (deliberate copies, not shared imports):
//   - Skill blocks mirror server/ai-routes.mjs's /code-assist framing
//     verbatim (TRUSTED INSTRUCTIONS header, `## Skill: <name>` sections).
//     ai-routes is route layer and must NOT be imported from here.
//   - Attachment caps/framing likewise re-implement its `selectAttachments`
//     semantics locally (30 files / 80k per file / 200k total) — same
//     reason. Keep the two in sync when either changes.

import { personaForMode, PLAN_LIKE_MODES } from '../runtime/mode-personas.mjs';
import { readSkillInstructions } from '../skills/index.mjs';
import { buildReadableRoots } from '../runtime/handlers/repo-files.mjs';
import { sanitizeForPrompt, sanitizeLine } from '../../core/utils.mjs';
import { getDb } from '../../kb/db.mjs';
import { getSecret } from '../../server/vault.mjs';

// --- Auth: per-user vault key first, operator env as fallback -------------
// (Moved here from spike-engine.mjs, which re-exports it for compatibility —
// the v2 runner and the spike share one auth ladder.)

export function resolveAnthropicKey(userId) {
  if (userId) {
    try {
      const key = getSecret(getDb(), userId, 'claude.apiKey');
      if (key) return { key, source: 'vault' };
    } catch {
      // Vault miss/unavailable — fall through to the environment.
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: 'env' };
  return { key: null, source: 'none' };
}

// --- Attachment caps ---------------------------------------------------------
// Local re-implementation of ai-routes' selectAttachments semantics (same
// numbers, same order of checks): treat every attachment as DATA — sanitize,
// fence-strip, cap per file then in total, dedupe display paths, and report
// which paths were cut so the runner can surface a truncation notice.

const ATTACHMENT_HOME_PREFIX_RE = /^\/Users\/[^/]+\//;

export function capAttachments(rawFiles, {
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
    // Display label only (LLM-facing, never a read): strip the literal home
    // dir for privacy, collapse control chars/whitespace runs.
    const displayPath = sanitizeLine(f.path, 200).replace(ATTACHMENT_HOME_PREFIX_RE, '~/');
    if (!displayPath || seen.has(displayPath)) continue;
    seen.add(displayPath);
    const sanitized = sanitizeForPrompt(f.content);
    let content = sanitized.slice(0, maxPerFileChars);
    let truncated = content.length < sanitized.length; // per-file cap cut it
    if (totalChars + content.length > maxTotalChars) {
      content = content.slice(0, maxTotalChars - totalChars);
      truncated = truncated || content.length < sanitized.length; // total cap cut it
    }
    if (!content) continue;
    files.push({ path: displayPath, content });
    if (truncated) truncatedPaths.push(displayPath);
    totalChars += content.length;
    if (totalChars >= maxTotalChars) break;
  }
  return { files, truncatedPaths };
}

// --- System-prompt append sections -------------------------------------------

const MAX_SKILLS = 5;

// Mirrors ai-routes /code-assist: skills the user explicitly invoked are
// followable INSTRUCTIONS, not data. Content comes from the catalog-gated
// local skill repo via readSkillInstructions (injectable for tests), so it
// is trusted; unknown ids are silently ignored (no arbitrary reads).
function buildSkillsText(skills, userId, readSkill) {
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

// Attachments are DATA: each wrapped in a <<<BEGIN>>>…<<<END>>> fence (the
// content itself is already fence-stripped by sanitizeForPrompt, so a
// hostile file cannot close its fence early and inject instructions).
function buildAttachmentsText(files) {
  if (!files.length) return '';
  let text = `# Attached files (${files.length})\n`;
  for (const f of files) {
    text += `\n## ${f.path}\n<<<BEGIN>>>\n${f.content}\n<<<END>>>\n`;
  }
  return `${text}\n`;
}

// --- The composition ---------------------------------------------------------

// The v2 tool allowlist: Claude Code read-only built-ins plus every llmide
// in-process MCP tool (the runner registers `mcp__llmide__*`). No Bash/Write/
// Edit — a v2 chat turn is read-and-answer; writes keep their own approval
// flow. Mode restriction beyond this (save-plan for plan-like modes) is the
// permissionMode/persona pair below, not a different list: SDK plan mode
// already denies write tools while allowing read-only research.
const V2_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__llmide__*'];

const MAX_PROMPT_CHARS = 20_000;

/**
 * Compose SDK query options from a Mac chat request. Pure except for the two
 * injected side-effecting lookups (readSkill, roots — both overridable via
 * the second argument for tests). Returns `{ queryOptions, prompt, meta }`;
 * does NOT start a query.
 *
 *   queryOptions.model              — present only when a non-empty string
 *   queryOptions.permissionMode     — 'plan' for plan-like modes (with
 *                                     planModeInstructions = the mode
 *                                     persona), else 'default'
 *   queryOptions.systemPrompt       — preset claude_code + append (language
 *                                     directive, mode persona, skill blocks,
 *                                     fenced attachments)
 *   prompt                          — the user message, sanitized, 20k cap
 *   meta                            — { mode, model, truncatedPaths } for the
 *                                     runner (session bookkeeping + notices)
 */
export function buildEngineOptions(
  { userId, mode, model, language, message, skills, agentContext, attachments } = {},
  { readSkill = readSkillInstructions, roots = buildReadableRoots } = {},
) {
  const resolvedMode = typeof mode === 'string' && mode ? mode : 'execute';
  const persona = personaForMode(resolvedMode);
  const planLike = PLAN_LIKE_MODES.has(resolvedMode);

  const workspaceRoot = typeof agentContext?.workspaceRoot === 'string' ? agentContext.workspaceRoot : '';
  // All validated readable roots (DB repo allow-list ∪ the validated
  // workspace root). The SDK already grants cwd, so additionalDirectories
  // is the roots result minus cwd — indexed repos and any other roots.
  const allRoots = roots({ userId, workspaceRoot: workspaceRoot || undefined });
  const additionalDirectories = (Array.isArray(allRoots) ? allRoots : [])
    .filter((dir) => dir !== workspaceRoot);

  const { files, truncatedPaths } = capAttachments(attachments);

  const appendParts = [];
  if (typeof language === 'string' && language) appendParts.push(`Always respond in ${language}.`);
  if (persona) appendParts.push(persona);
  const skillsText = buildSkillsText(skills, userId, readSkill);
  if (skillsText) appendParts.push(skillsText);
  const attachmentsText = buildAttachmentsText(files);
  if (attachmentsText) appendParts.push(attachmentsText);

  const queryOptions = {
    // Live token + tool-args deltas — the stream a chat UI needs.
    includePartialMessages: true,
    // Full isolation from the operator's own Claude config (same policy as
    // the CLI fallback's --setting-sources ''). Credentials are not
    // settings — ambient auth still works through the subprocess.
    settingSources: [],
    ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
    additionalDirectories,
    permissionMode: planLike ? 'plan' : 'default',
    ...(planLike ? { planModeInstructions: persona } : {}),
    // Fresh array per call — V2_ALLOWED_TOOLS is a shared constant and must
    // never be handed to a caller that could mutate it.
    allowedTools: [...V2_ALLOWED_TOOLS],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: appendParts.join('\n\n') },
    ...(typeof model === 'string' && model ? { model } : {}),
  };

  return {
    queryOptions,
    prompt: sanitizeForPrompt(message).slice(0, MAX_PROMPT_CHARS),
    meta: {
      mode: resolvedMode,
      model: typeof model === 'string' && model ? model : null,
      truncatedPaths,
    },
  };
}
