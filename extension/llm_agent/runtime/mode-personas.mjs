// extension/llm_agent/runtime/mode-personas.mjs
// Per-mode system-prompt additions + tool allowlist for /code-assist.
// Plan/Review/Document are all "no write tools" variants of the SAME agent
// loop and endpoint — see
// docs/superpowers/plans/2026-08-09-code-assistant-modes-phase2.md for why
// this replaced the original design's "route to a different pipeline" idea
// (neither /kb/generate-plan nor a review/guardrail pipeline fit).
//
// IMPORTANT: tool restriction uses an explicit allowlist of tool NAMES, not
// each skill's `kind` field. `run-bash` (extension/llm_agent/global/run-bash.md)
// is `kind: read` but executes arbitrary shell commands server-side with NO
// user confirmation — filtering by kind alone would leave it available in
// these "no write tools" modes and defeat the whole point. Every name below
// was checked individually against its actual handler, not just its kind
// label:
//   - ask-internal, ask-subagent (handlers/ask-internal.mjs, ask-subagent.mjs):
//     these are included in the allowlist because they're legitimate
//     read-oriented delegation tools, NOT because their nested loop is
//     itself filtered to this allowlist — it is NOT. route.mjs passes
//     ctx.internalSkills.skills = the FULL per-user skill set (including
//     any plugin's write-kind skills) into askInternal, and loop.mjs
//     returns `pendingTool` for a `kind: 'write'` skill BEFORE its handler
//     map is ever consulted. So a plugin write-skill IS reachable through
//     ask-internal's nested loop, completely unfiltered by mode. The ONLY
//     thing that actually prevents this from surfacing today is
//     route.mjs's belt-and-suspenders post-loop null-out of `pendingTool`
//     for restricted modes (see enforceModeToolRestriction there) — that
//     null-out is NOT redundant with this allowlist and must never be
//     removed as such.
//   - list-files, read-file (handlers/repo-files.mjs): read-only filesystem
//     access, scoped to an allow-listed root, traversal- and secret-proof.
//   - find-code (handlers/find-code.mjs): read-only query over the symbol index
//     and code graph. No filesystem writes and no shell; it only touches disk
//     via existsSync to pick the path form read-file can open, and every path it
//     returns is gated on the same readable roots. Genuinely useful in these
//     modes — scoping a plan or a review is exactly when the agent needs to
//     locate code cheaply.
//   - fetch-url, web-search (handlers/fetch-url.mjs, web-search.mjs):
//     outbound network reads (SSRF-guarded); no mutation of any local or
//     remote state.
//   - search-kb (handlers/search-kb.mjs): read-only KB query.
//   - save-plan is NOT in this base set — see PLAN_LIKE_MODES below: it's
//     the one deliberate write-kind carve-out, but added ONLY for the
//     plan-like modes (`plan`, `assist_plan`), not review/document. It
//     takes no `path` argument — the Mac client always resolves it to
//     <workspaceRoot>/llm-doc/plans/, so even though it is `kind: write`,
//     it cannot be redirected into editing an arbitrary file the way
//     update-file/bash could. enforceModeToolRestriction (route.mjs) also
//     special-cases this name so its pendingTool survives for those modes
//     specifically.
// Excluded despite `kind: read`:
//   - run-bash (handlers/run-bash.mjs): executes arbitrary shell commands
//     on the server via /bin/sh with no user confirmation. Must never be
//     reachable from a "no write tools" mode.
//   - task-list, task-create, task-update (handlers/session-tasks.mjs): these
//     modes describe single-turn prose output (a plan proposal, review
//     feedback, or documentation), never the "work autonomously through a
//     task list" behavior — so they have no legitimate use for task
//     tracking. Leaving them reachable would let a model populate
//     agentPendingTasks and trigger the Mac app's PlanTimelineCard/
//     auto-continue reflex for a turn that was never meant to have a
//     tracked plan. See Task 4 of
//     docs/superpowers/plans/2026-08-09-code-assistant-modes-phase2.md.
// Never included (kind: write, excluded trivially): bash, git-op, update-file.

const READ_ONLY_TOOL_NAMES = new Set([
  'ask-internal',
  'ask-subagent',
  'list-files',
  'read-file',
  'find-code',
  'fetch-url',
  'web-search',
  'search-kb',
]);

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
