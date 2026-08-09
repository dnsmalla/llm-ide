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
//     delegate to a sub-loop whose own handler map is restricted to
//     search-kb-only tools — no write tool is reachable through them.
//   - list-files, read-file (handlers/repo-files.mjs): read-only filesystem
//     access, scoped to an allow-listed root, traversal- and secret-proof.
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
  'fetch-url',
  'web-search',
  'search-kb',
]);

const MODE_CONFIG = {
  plan: {
    persona: 'You are in PLAN mode. Propose a clear, step-by-step plan for the '
           + "user's request in prose — do NOT call any write tool (file edits, "
           + 'bash, git operations, issue/PR actions). Read-only tools (search, '
           + 'list-files, read-file) are fine if they help you scope the plan. '
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
