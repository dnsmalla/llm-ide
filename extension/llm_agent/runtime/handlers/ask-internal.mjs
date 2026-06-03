// Read handler: delegates a question to the internal Meet Notes
// agent. Runs a fresh internal sub-loop and bundles its
// {reply, pendingTool} as {answer, pendingTool} for global to read.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgentLoop } from '../loop.mjs';
import { searchKb, redactFence } from './search-kb.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERNAL_ROLE_PROMPT_PATH = join(__dirname, '..', '..', 'internal', 'prompt.md');

// Cache the static role-and-rules prompt once per process.
const internalRolePrompt = readFileSync(INTERNAL_ROLE_PROMPT_PATH, 'utf8').trim();

const INTERNAL_HANDLERS = { 'search-kb': searchKb };

export async function askInternal(args, ctx) {
  // Build internal's "base" string: role + rules from internal/prompt.md
  // PLUS the fence-shape contract from internal/skills/_base.md. The
  // existing runAgentLoop puts agentContext.base first in the composed
  // system prompt, before the system-context block and skill bodies —
  // exactly where the role description belongs.
  const internalBase = [internalRolePrompt, ctx.internalSkills.base]
    .filter((s) => s && s.length > 0)
    .join('\n\n');

  // Pass agentContext through unchanged so internal's composeSystemContext
  // renders all the app-specific sections. We don't carry global's chat
  // history into internal — that would defeat the token-saving goal.
  // Global is responsible for restating any needed context inside
  // `args.question`.
  const result = await runAgentLoop({
    skills: ctx.internalSkills.skills,
    userMessage: args.question,
    history: [],                        // fresh — internal is stateless
    agentContext: { ...(ctx.agentContext || {}), base: internalBase, includeSystemContext: true },
    runClaude: ctx.runClaude,
    kb: ctx.kb,
    userId: ctx.userId,
    handlers: INTERNAL_HANDLERS,
    // Internal sub-loop deadline: 120 s.  The outer global loop has a
    // 180 s deadline (set in route.mjs).  Keeping this at 120 s leaves
    // ~60 s for the outer loop to compose its final reply after the
    // sub-loop returns — enough for one more Claude call if needed.
    // The previous value of 150 s left only 30 s of outer budget, which
    // was too tight for multi-step global chains.
    deadlineMs: 120_000,
  });
  return {
    // Redact fence sentinels from the sub-loop reply before returning it
    // as the outer loop's toolResult.  Without this, a KB snippet echoed
    // by the internal agent could contain <<<TOOL_CALL>>> and forge a
    // write-tool invocation when the outer loop embeds the answer.
    answer: redactFence(result.reply || ''),
    pendingTool: result.pendingTool ?? null,
  };
}
