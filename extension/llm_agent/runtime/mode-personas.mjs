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

const MODE_CONFIG = {
  plan: {
    persona: 'You are in PLAN mode. Propose a clear, step-by-step plan for the '
           + "user's request in prose — do NOT call any write tool (file edits, "
           + 'bash, git operations, issue/PR actions). Read-only tools (find-code, '
           + 'search, list-files, read-file) are fine if they help you scope the plan. '
           + "End with a short summary of what you'd do and in what order; the "
           + 'user decides whether to execute it.',
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
 */
export function allowedToolNames() {
  return new Set(READ_ONLY_TOOL_NAMES);
}
