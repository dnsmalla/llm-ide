// extension/llm_agent/runtime/mode-personas.mjs
// Per-mode system-prompt additions + tool allowlist for /code-assist.
// Plan/Review/Document are all "no write tools" variants of the SAME agent
// loop and endpoint — see
// docs/superpowers/plans/2026-08-09-code-assistant-modes-phase2.md for why
// this replaced the original design's "route to a different pipeline" idea
// (neither /kb/generate-plan nor a review/guardrail pipeline fit).
//
// Tool restrictions for these modes are derived from the registry's `kind`
// field — see tools/registry.mjs for the rationale on which tools have
// `kind: 'read'` (allowed in these modes) vs `kind: 'act'` (not allowed).

import { entries } from '../tools/registry.mjs';

const READ_ONLY_TOOL_NAMES = new Set(entries().filter((e) => e.kind === 'read').map((e) => e.name));

// The plan-like modes: both get save-plan added on top of READ_ONLY_TOOL_NAMES
// (see allowedToolNames below) — review/document must not even see it in
// their tool list, since enforceModeToolRestriction (route.mjs) nulls its
// pendingTool for those modes and a model that called it anyway would get a
// silently-truncated reply for no visible reason. Exported so route.mjs can
// check membership instead of duplicating the mode-name comparison.
export const PLAN_LIKE_MODES = new Set(['plan', 'assist_plan']);
const PLAN_LIKE_EXTRA_TOOL_NAMES = new Set(['save-plan']);

const MODE_CONFIG = {
  plan: {
    persona: 'You are in PLAN mode. Propose a clear, step-by-step plan for the '
           + "user's request in prose — do NOT call any write tool (file edits, "
           + 'bash, git operations, issue/PR actions) EXCEPT save-plan, which is '
           + 'the one write action available in this mode. Read-only tools '
           + '(find-code, search, list-files, read-file) are fine if they help you '
           + "scope the plan. End with a short summary of what you'd do and in what "
           + 'order, then call save-plan with a short title and the full plan as '
           + 'content — it saves immediately with no confirmation step, so only '
           + "call it once the plan is actually ready, and say in your reply that "
           + "you've saved it and where.",
  },
  assist_plan: {
    persona: 'You are in ASSIST_PLAN mode — a slower, collaborative planning '
           + "process for when the user wants to build a plan WITH you over "
           + 'several turns, not get a one-shot proposal like PLAN mode. Follow '
           + 'the assist-plan skill\'s 5 phases, picking up from '
           + "wherever the conversation already is — re-read the history to work "
           + "out which phase you're on; there is no separate state, only the "
           + 'conversation. (1) If the user hasn\'t given a summary of what they '
           + 'want yet, ask for one — don\'t proceed without it. (2) Extract the '
           + "claims in that summary, check them yourself against the real "
           + 'project (find-code, read-file, list-files — never ask the user for '
           + 'a fact you can look up), then for what\'s genuinely a decision ask '
           + 'selection-based questions, batched as ONE numbered round per turn, '
           + 'each with a recommended default: "❓ **Q1** — <question w/ '
           + 'options>" / "➡️ <recommended answer>" — then use the answers to '
           + 'rewrite the summary accurately. (3) Turn the grounded summary into '
           + 'a few scoped paragraphs and ask if it looks right before '
           + 'continuing. (4) Find a gap (edge cases, testing, rollout, ...), '
           + 'add it as a new section, run another round of questions if it '
           + 'raises new decisions — repeat until nothing important is left '
           + 'unclear. (5) Self-review for placeholders/contradictions/ '
           + 'ambiguity and fix them, then ask for a final review; only once '
           + 'the user approves, call save-plan with a short title and the '
           + 'finalized document — it saves immediately with no further '
           + 'confirmation, so call it only after real approval, and say in '
           + "your reply that you've saved it and where. Do NOT call any other "
           + 'write tool (file edits, bash, git operations, issue/PR actions).',
  },
  review: {
    persona: 'You are in REVIEW mode. Read the attached files/context and give '
           + 'structured code-review feedback — bugs, security issues, style, '
           + 'and concrete suggestions. Do NOT propose or make any file edits, '
           + 'bash commands, or git/issue/PR actions; this is feedback only.',
  },
  document: {
    persona: 'You are in DOCUMENT mode. Write clear documentation for the '
            + 'referenced code or feature in your reply. Do NOT call any write '
            + 'tool — you cannot save the file yourself in this mode; tell the '
            + 'user to switch to Execute mode if they want it written to disk.',
  },
};

/** Returns the persona addition for `mode`, or "" for execute/unknown (no change). */
export function personaForMode(mode) {
  return MODE_CONFIG[mode]?.persona ?? '';
}

/** Whether `mode` should have its skills map restricted to READ_ONLY_TOOL_NAMES. */
export function restrictsTools(mode) {
  return Object.prototype.hasOwnProperty.call(MODE_CONFIG, mode);
}

/**
 * The explicit allowlist a restricted mode's skills map should be filtered
 * to. Returns a fresh copy each call — this is a security-relevant
 * process-wide singleton; a caller mutating the returned Set (e.g. a
 * future per-request tweak) must never corrupt it for other requests.
 *
 * `mode` is optional so existing no-arg callers keep the base read-only
 * set unchanged; pass the resolved mode to also get the plan-like modes'
 * one write-tool carve-out (save-plan) merged in.
 */
export function allowedToolNames(mode) {
  const names = new Set(READ_ONLY_TOOL_NAMES);
  if (PLAN_LIKE_MODES.has(mode)) {
    for (const n of PLAN_LIKE_EXTRA_TOOL_NAMES) names.add(n);
  }
  return names;
}
