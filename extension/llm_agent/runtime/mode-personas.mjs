// extension/llm_agent/runtime/mode-personas.mjs
// Per-mode system-prompt additions for /code-assist. Plan/Review/Document
// are all "no write tools" variants of the SAME agent loop and endpoint —
// see docs/superpowers/plans/2026-08-09-code-assistant-modes-phase2.md for
// why this replaced the original design's "route to a different pipeline"
// idea (neither /kb/generate-plan nor a review/guardrail pipeline fit).

const PERSONAS = {
  plan: 'You are in PLAN mode. Propose a clear, step-by-step plan for the '
      + "user's request in prose — do NOT call any write tool (file edits, "
      + 'bash, git operations, issue/PR actions). Read-only tools (search, '
      + 'list-files, read-file) are fine if they help you scope the plan. '
      + "End with a short summary of what you'd do and in what order; the "
      + 'user decides whether to execute it.',
  review: 'You are in REVIEW mode. Read the attached files/context and give '
        + 'structured code-review feedback — bugs, security issues, style, '
        + 'and concrete suggestions. Do NOT propose or make any file edits, '
        + 'bash commands, or git/issue/PR actions; this is feedback only.',
  document: 'You are in DOCUMENT mode. Write clear documentation for the '
          + 'referenced code or feature. Do NOT call any write tool other '
          + 'than proposing the documentation text itself; offer to save it '
          + 'under docs/ if the user confirms.',
};

/** Returns the persona addition for `mode`, or "" for execute/unknown (no change). */
export function personaForMode(mode) {
  return PERSONAS[mode] ?? '';
}

/** Whether `mode` should have write tools removed from its skills map. */
export function restrictsTools(mode) {
  return Object.prototype.hasOwnProperty.call(PERSONAS, mode);
}
