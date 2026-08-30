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
// Exception: task-list is excluded despite being kind:'read', because these
// modes describe single-turn prose output (a plan proposal, review feedback,
// or documentation), never the "work autonomously through a task list"
// behavior — so task-list has no legitimate use here. Leaving it reachable
// would let a model populate agentPendingTasks and trigger the Mac app's
// PlanTimelineCard/auto-continue reflex for a turn that was never meant to
// have a tracked plan.

import { entries } from '../tools/registry.mjs';
import { buildPlanBinding } from './plan-pipeline.mjs';

const READ_ONLY_TOOL_NAMES = new Set(entries().filter((e) => e.kind === 'read' && e.name !== 'task-list').map((e) => e.name));

// The plan-like modes: both get save-plan added on top of READ_ONLY_TOOL_NAMES
// (see allowedToolNames below) — review/document must not even see it in
// their tool list, since enforceModeToolRestriction (route.mjs) nulls its
// pendingTool for those modes and a model that called it anyway would get a
// silently-truncated reply for no visible reason. Exported so route.mjs can
// check membership instead of duplicating the mode-name comparison.
export const PLAN_LIKE_MODES = new Set(['plan', 'assist_plan']);
const PLAN_LIKE_EXTRA_TOOL_NAMES = new Set(['save-plan']);

// Plan-like personas are NOT written here. Both modes' process is an upstream
// skill mirrored verbatim into the central skills repo (brainstorming for
// `plan`, grilling for `assist_plan`), injected into the turn as trusted
// instructions; the persona is only the LLM-IDE bindings that frame it. That
// is why these two entries carry no `persona` of their own — see
// runtime/plan-pipeline.mjs for the full rationale, and `personaForMode`
// below for how the binding is composed. An earlier version of this file
// paraphrased those skills into two long persona strings, which is exactly
// the second copy that had already started drifting from the skill files.
const MODE_CONFIG = {
  plan: {},
  assist_plan: {},
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

/**
 * Returns the persona addition for `mode`, or "" for execute/unknown (no
 * change).
 *
 * For the plan-like modes this is the binding block from plan-pipeline.mjs
 * rather than a stored string, because what it says depends on which skill
 * the caller injected alongside it: pass `skillName` (the injected skill's
 * frontmatter name) so the bindings can point at it by name. Callers that
 * don't inject a skill still get a coherent, if less specific, binding —
 * the mode's tool contract and save/facts rules hold either way.
 */
export function personaForMode(mode, { skillName } = {}) {
  if (PLAN_LIKE_MODES.has(mode)) return buildPlanBinding(mode, { skillName });
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
