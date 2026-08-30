// extension/llm_agent/runtime/plan-pipeline.mjs
// The planning pipeline: which upstream skill drives each stage of a
// plan-like turn, and the LLM-IDE bindings that make those skills
// followable inside this app.
//
// WHY THIS EXISTS. Plan/Assist-Plan used to be two hand-written personas in
// mode-personas.mjs that paraphrased `.skills/skills/assist-plan/SKILL.md`
// — a second copy of a process whose real definition lives in the central
// skills repo, already drifting from it. The skills are mirrored verbatim
// from their upstreams (obra/superpowers, mattpocock/skills) precisely so a
// refresh is a clean re-pull; paraphrasing them here would put the drift
// back. So the persona is now BINDINGS ONLY — the environment facts the
// upstream text cannot know (there is no git, the write action is
// `save-plan`, facts come from the code index) — and the process itself is
// the skill file, injected as trusted instructions.
//
// STAGE-AWARE, NOT ALL-AT-ONCE. The four pipeline skills total ~58 KB.
// Carrying all of them on every planning turn would dominate the prompt for
// a turn that can only ever use one of them, so each stage pays only for
// its own:
//
//   stage 1  discover  brainstorming (plan) / grilling (assist_plan)
//                      → INJECTED by the mode, since the mode IS the stage
//   stage 2  write     writing-plans
//                      → PULLED by the model via `load-skill` once its
//                        human partner approves the design. Deliberately
//                        pull-based: nothing the server can see marks the
//                        approval turn (it is a plain "yes, go ahead"), and
//                        a classifier call to detect it would cost more
//                        than it saves. brainstorming's own terminal step
//                        is "invoke the writing-plans skill", so this is
//                        the skill's instruction becoming literally
//                        followable rather than a new behavior.
//   stage 3  save      save-plan (the modes' one write tool — see
//                      mode-personas.mjs)
//   stage 4  execute   subagent-driven-development / executing-plans
//                      → INJECTED in Execute mode when the client fires the
//                        PlanSavedCard's "Execute plan" action, which is an
//                        explicit signal the server can trust.
//
// The stage-4 choice is made HERE, from whether this user actually has
// subagents, rather than left to the model: both upstream skills open by
// telling the reader to switch to the other one if their platform's
// subagent support differs, and the server is the only party that knows
// which is true.

/**
 * Stage-1 skill per plan-like mode, as library ids ("<family>/<dir>" — the
 * shape `readSkillInstructions` resolves). `plan` runs superpowers'
 * brainstorming (three paths, approaches with trade-offs, approval gate);
 * `assist_plan` swaps in mattpocock's grilling (design-tree frontier, one
 * numbered round per turn with a recommended answer for each question).
 * Same skeleton either way — only the questioning style differs.
 */
export const DISCOVER_SKILL_IDS = Object.freeze({
  plan: 'skills/brainstorming',
  assist_plan: 'skills/grilling',
});

/** Stage 2 — the plan-writing skill the model pulls with `load-skill`. */
export const WRITE_SKILL_ID = 'skills/writing-plans';

/** Stage 4 — inline vs subagent execution of an approved plan. */
export const EXECUTE_SKILL_IDS = Object.freeze({
  subagent: 'skills/subagent-driven-development',
  inline: 'skills/executing-plans',
});

/** The stage-1 skill id for `mode`, or null for a non-plan-like mode. */
export function discoverSkillIdForMode(mode) {
  return Object.prototype.hasOwnProperty.call(DISCOVER_SKILL_IDS, mode)
    ? DISCOVER_SKILL_IDS[mode]
    : null;
}

/**
 * The stage-4 skill id. `hasSubagents` is whether this user has any subagent
 * the `ask-subagent` tool could actually dispatch to — with none, the
 * subagent-driven skill's every task would fall back to inline work anyway,
 * against 32 KB of instructions about dispatching, reviewing and re-reviewing
 * agents that do not exist.
 */
export function executeSkillId({ hasSubagents } = {}) {
  return hasSubagents ? EXECUTE_SKILL_IDS.subagent : EXECUTE_SKILL_IDS.inline;
}

/**
 * The ONE skill id to inject for this turn, or null to inject nothing.
 *
 * Kept as a pure resolver (no I/O, no skill reading) so both engines —
 * runtime/route.mjs and sdk/engine.mjs — share one rule about which stage a
 * turn is in, and so the rule is testable without a skills repo on disk.
 * The engines supply `hasSubagents` because only they know this user's
 * plugin/subagent view.
 *
 * `planExecute` wins over the mode: it is set only when the client fired the
 * PlanSavedCard's "Execute plan" action, which switches the mode picker to
 * Execute as it goes, so the two never disagree in practice — but if a
 * client ever sent both, an approved plan waiting to be executed is the
 * more specific signal.
 */
export function pipelineSkillIdFor({ mode, planExecute, hasSubagents } = {}) {
  if (planExecute) return executeSkillId({ hasSubagents });
  return discoverSkillIdForMode(mode);
}

// The facts clause is shared by every stage: the same rule that makes
// grilling's "finding facts is your job, never the user's" affordable here.
// A skill written for a general coding agent assumes grep and full-file
// reads; this project has a symbol index and a code graph, and saying so is
// the difference between one `find-code` call and a repo sweep per question.
const FACTS_CLAUSE =
  '- **Establishing facts.** Look things up yourself — never ask the user '
  + 'for a fact you could find, and never open with a repo-wide `grep`/`find`. '
  + 'Start with `find-code`: one call returns the definition site, its callers/'
  + 'callees/importers from the code graph, and full-text hits. Then read '
  + 'narrowly from the line it gave you (`read-file`, or `run-bash` with a '
  + 'bounded `sed -n`) rather than pulling whole files into context. '
  + '`search-kb` covers the Library, meetings and notes; `project-memory` '
  + 'covers what was recorded about this project before. Those four are the '
  + 'cheap path — use them before you consider anything broader.';

// Every plan-like mode is read-only apart from save-plan, so the upstream
// text's file writes, commits, worktrees and branches are all unavailable.
// Stated as a redirect rather than a prohibition: "you cannot commit" leaves
// a model that was told to write a spec file with nowhere to put it, and it
// then either invents a tool call or silently drops the artifact.
const ARTIFACT_CLAUSE =
  '- **Every document goes through `save-plan`.** You have no filesystem '
  + 'write access, no git, and no worktrees here. Wherever the skill says to '
  + 'write a file to a path (a design doc, a spec, the plan itself), call '
  + '`save-plan` instead — it always writes into `llm-doc/plans/` in the open '
  + 'project, derives the filename from the title you give it, and saves '
  + 'immediately with no confirmation step. Give a design/spec a title ending '
  + '"Design" and the implementation plan a title ending "Plan" so the two land '
  + 'in separate files. Skip any instruction to `git commit`, create a branch, '
  + 'or set up a worktree — say what you would have committed and move on. '
  + 'Because the save is immediate and irreversible, call it only for a '
  + 'document that is actually finished and approved, and say in your reply '
  + 'that you saved it and where.';

// The full plan reaches the user through the saved-plan card (title, file
// path, collapsible body, Execute/Edit); a model that ALSO writes the plan
// out as prose before calling save-plan makes the chat carry the same
// document twice, and the untruncated copy is the one in the bubble. So the
// document body belongs in the tool call, and the reply is the table of
// contents for it.
const REPLY_BREVITY_CLAUSE =
  '- **Do not restate the document in your reply.** Its full text goes in the '
  + '`save-plan` call, and the card the user gets back renders that text with '
  + 'the file path and an Execute action. So the reply lists the task headings '
  + 'only — one numbered line each, no bodies and no code blocks — then one '
  + 'line naming the file; under 20 lines in total. Keep writing normally while '
  + 'you are still discovering: this starts at the turn you call `save-plan`. '
  + 'Do not ask which execution mode to use either — the app picks inline vs '
  + 'subagent itself when the user presses Execute.';

/**
 * The mode persona for a plan-like mode: a short binding block that frames
 * the injected stage-1 skill and names the stage transitions. Kept free of
 * any restatement of the skill's own process — that is the drift this
 * module exists to prevent.
 *
 * `skillName` is the injected skill's frontmatter name, so the binding can
 * point at it by the same name the skill block is headed with.
 */
export function buildPlanBinding(mode, { skillName } = {}) {
  const named = skillName ? `the **${skillName}** skill` : 'the skill';
  const modeLabel = mode === 'assist_plan' ? 'ASSIST_PLAN' : 'PLAN';
  return `You are in ${modeLabel} mode. ${named.charAt(0).toUpperCase()}${named.slice(1)} `
    + 'in the skills block above is your process for this turn — follow it as '
    + 'written. The bindings below are the parts of this environment that skill '
    + 'cannot know about; where they and the skill disagree, these win.\n\n'
    + '- **Where you are in the process.** There is no separate stage tracker — '
    + 're-read the conversation to work out which step you are on, and pick up '
    + 'from there. A fresh request starts at that skill\'s beginning; do not '
    + 'skip ahead to a finished plan because the request sounds simple.\n'
    + `- **Writing the plan.** Once your human partner has approved the design, `
    + `call \`load-skill\` with \`${WRITE_SKILL_ID}\` and follow what it returns `
    + 'to write the implementation plan. Do not write the plan from memory, and '
    + 'do not load it before there is an approved design to turn into one.\n'
    + `${ARTIFACT_CLAUSE}\n`
    + `${REPLY_BREVITY_CLAUSE}\n`
    + `${FACTS_CLAUSE}\n`
    + '- **No other write tool.** File edits, shell commands, git operations '
    + 'and issue/PR actions are unavailable in this mode; `save-plan` is the '
    + 'only action you can take.';
}

/**
 * The Execute-mode binding for a turn launched from the PlanSavedCard —
 * the plan is approved and attached, and the injected skill (chosen by
 * `executeSkillId`) is how to work through it.
 */
export function buildExecuteBinding({ skillName, hasSubagents } = {}) {
  const named = skillName ? `The **${skillName}** skill` : 'The skill';
  return 'You are executing a plan the user already approved and saved. '
    + `${named} in the skills block above is your process — follow it as `
    + 'written, starting at its first task.\n\n'
    + `- **Which execution skill.** ${hasSubagents
      ? 'You have subagents available (`ask-subagent`), which is why the '
        + 'subagent-driven skill was selected; dispatch tasks through it as '
        + 'the skill describes rather than implementing every task inline.'
      : 'No subagents are configured for this user, which is why the inline '
        + 'skill was selected — work the tasks yourself and ignore any '
        + 'instruction to switch to subagent-driven execution.'}\n`
    + '- **The plan is the attached document.** Do not re-plan it, re-open '
    + 'settled decisions, or expand its scope; if a task turns out to be '
    + 'wrong, say so and stop rather than substituting your own plan.\n'
    + '- **Tracking.** Use `task-create` once per plan step up front and '
    + '`task-update` as each completes, in place of whatever todo/ledger '
    + 'mechanism the skill names.\n'
    + `${FACTS_CLAUSE}`;
}
