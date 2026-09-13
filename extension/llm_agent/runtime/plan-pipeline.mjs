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
export function pipelineSkillIdFor({ mode, planExecute, planWrite, hasSubagents } = {}) {
  if (planExecute) return executeSkillId({ hasSubagents });
  // Stage 2. Set only when the client fired the saved-plan card's "Write full
  // plan" action, which is the one signal the server can trust that this turn
  // turns an approved design into the implementation plan.
  //
  // Without it a write turn was still given stage 1's skill: brainstorming
  // (15KB) — the DISCOVERY process — when the process for this turn is
  // writing-plans (7KB). The binding told the model to `load-skill` its way
  // there, so it worked when the model complied and silently did discovery
  // again when it didn't. The stage is known here; it should not be guessed
  // from the prompt.
  if (planWrite) return WRITE_SKILL_ID;
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
//
// ONE document per piece of work. The upstream skills produce two files (a
// design doc, then a plan that cites it), and an earlier version of this
// clause preserved that split with "Design"/"Plan" title suffixes. In this
// app that put the same work in two dated files under llm-doc/plans/ with
// nothing tying them together, and the Execute action only ever attached
// one of them. The design notes and the implementation plan are now
// SECTIONS of the same document, the title is its identity across the
// design → write phases, and re-saving under that title updates the file in
// place — which is what the Mac's resolver does with a repeated title.
const ONE_DOCUMENT_CLAUSE =
  '- **One document per piece of work.** Where the skill writes a design doc '
  + 'and then a separate plan, write ONE document — design decisions first, '
  + 'the implementation plan after. Fix the title at the design stage and keep '
  + 'it when you write the plan: the title is the file, and saving under it '
  + 'again updates that file in place. Never add "Design"/"Plan" to a title to '
  + 'make two files.';

const ARTIFACT_CLAUSE =
  '- **Every document goes through `save-plan`.** You have no filesystem '
  + 'write access, no git, and no worktrees here. Wherever the skill says to '
  + 'write a file to a path, call `save-plan` instead — it always writes into '
  + '`llm-doc/plans/` in the open project, derives the filename from the '
  + 'title, and saves immediately with no confirmation step. Skip any '
  + 'instruction to `git commit`, create a branch, or set up a worktree — say '
  + 'what you would have committed and move on. Because the save is immediate, '
  + 'call it only for a document that is finished and approved, and say in '
  + 'your reply that you saved it and where.';

// The Agent engine mounts no save-plan tool: the plan IS the reply, and the
// app's own Save Plan action writes the reply to llm-doc/plans/. Telling that
// engine to "call save-plan" sent it looking for a tool it did not have, and
// the brevity clause below — right for the legacy engine, where the document
// travels in the tool call — told it to keep the document OUT of the one
// channel it actually has. Hence a separate clause for that engine.
const AGENT_ARTIFACT_CLAUSE =
  '- **The document is your reply.** You have no file-writing tool here — no '
  + '`save-plan`, no filesystem, no git, no worktrees. Wherever the skill says '
  + 'to write a file, write the complete document as your reply instead, '
  + 'starting with its `#` title on the first line and nothing before it: the '
  + 'app saves that reply to `llm-doc/plans/` under the title, and a reply '
  + 'that opens with chat prose gets the prose saved into the file. Skip any '
  + 'instruction to `git commit`, create a branch, or set up a worktree. Keep '
  + 'conversation and documents in separate turns: a turn that asks or '
  + 'discusses is chat; a turn that delivers a document is the document, '
  + 'whole, with no summary of it afterwards. Do not ask which execution mode '
  + 'to use — the app picks inline vs subagent when the user presses Execute.';

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

// Both plan skills open by QUESTIONING the user — that is the whole of
// stage 1 — and the skills, written for a plain terminal agent, say to ask in
// prose. On the Agent engine prose is the wrong channel: this app renders an
// `AskUserQuestion` call as an answerable card (header, 2-4 labelled options,
// optional multi-select) whose answer returns to the model inside the SAME
// turn. A question typed into the reply instead just ends the turn — the user
// has to retype an answer in the composer, and the model then has to parse
// prose into the decision it already knew how to enumerate.
const QUESTION_CLAUSE_AGENT =
  '- **Ask with `AskUserQuestion`, never in prose.** Where the skill says to '
  + 'ask your human partner, call that tool: the app draws an answerable card '
  + 'and the answer returns inside this same turn. A question typed into your '
  + 'reply only ends the turn. One call per round (up to 4 questions), each '
  + 'with a header of at most 12 characters and 2-4 labelled options, your '
  + 'recommendation first; set `multiSelect` when answers are not exclusive.';

// The classic engine has NO `AskUserQuestion`: its registry mounts
// `ask-internal`, `ask-subagent`, the read tools, the task tools and
// `run-bash`, and that is the whole list. Naming the tool here anyway does
// not get a card — it gets the model DRAWING one in prose, because that is
// the only way left to obey: "Question 1 of N", options A/B/C, recommendation
// first — the clause above, rendered as text. So this engine is told what it
// actually has: ask in the reply, the way the skill already says to.
const QUESTION_CLAUSE_LEGACY =
  '- **Asking ends the turn here.** You have no question tool on this engine, '
  + 'so a question goes in your reply and the user answers in the composer — '
  + 'ask the way the skill says to. Because each round costs a turn, ask only '
  + 'what changes what you do next, put the questions of one round in one '
  + 'reply, and say which answer you would pick.';

/**
 * When stage 1 is finished and the model should move on to writing the plan.
 *
 * Mode-specific because the two stage-1 skills END DIFFERENTLY, and a single
 * phrasing broke one of them. brainstorming produces a design and closes with
 * "Invoke the writing-plans skill"; grilling produces settled decisions and
 * closes at "do not act until the user confirms you have reached a shared
 * understanding" — it never writes a design at all.
 *
 * The binding used to say "once your human partner has approved the design"
 * for both, so in Assist Plan the hand-off named a thing that stage never
 * produces: the model had no approved design to point at and no defined
 * moment to start writing. Each mode now gets its own skill's actual finish
 * line.
 */
/**
 * The "writing the plan" clause, which differs by STAGE.
 *
 * The default is a CONTINUATION, not a hand-off: the model finishes stage 1
 * and then, in the same turn, loads writing-plans and writes the document.
 *
 * It used to stop at the design and wait for the app to fire a second turn
 * (the saved card's "Write full plan" button). That made the design a
 * deliverable in its own right — it was saved to `llm-doc/plans/` to have
 * something to attach to the write turn — so a chat that never pressed the
 * button left a design sitting in the plans folder as if it were a plan. The
 * design is now an intermediate step the model passes through, and the only
 * document that reaches disk is the plan itself.
 *
 * `planWrite` remains for a client that still asks for the write stage on its
 * own: the skill is already in the prompt then, so telling the model to fetch
 * it — or to wait for an approval that already happened — is an instruction
 * to ignore, and the ones next to it lose force with it.
 */
function writingClause(mode, planWrite) {
  if (planWrite) {
    return '- **You are writing the plan now.** The approval has happened and the '
      + 'skill above is the process for this turn — follow it as written. Do not '
      + 're-open the design, re-ask settled questions, or start implementing.\n';
  }
  return `- **Keep going into the plan.** ${handoffTrigger(mode)} do not stop there `
    + `and do not ask whether to continue: in this SAME turn, call \`load-skill\` with `
    + `\`${WRITE_SKILL_ID}\` and follow what it returns to write the implementation `
    + 'plan. Do not write it from memory, and do not load it earlier.\n';
}

function handoffTrigger(mode) {
  // The trigger is the stage's own FINISH LINE, not an approval. Waiting for
  // one was what stopped the turn at the design; the user approves the plan
  // that comes out the far end (Save / Execute), not the design on the way.
  return mode === 'assist_plan'
    ? 'Once the question frontier is empty and the decisions are settled,'
    : 'Once the design is settled — the options explored and one chosen —';
}

/**
 * The mode persona for a plan-like mode: a short binding block that frames
 * the injected stage-1 skill and names the stage transitions. Kept free of
 * any restatement of the skill's own process — that is the drift this
 * module exists to prevent.
 *
 * `skillName` is the injected skill's frontmatter name, so the binding can
 * point at it by the same name the skill block is headed with.
 */
export function buildPlanBinding(mode, { skillName, engine = 'legacy', planWrite = false } = {}) {
  const named = skillName ? `the **${skillName}** skill` : 'the skill';
  const modeLabel = mode === 'assist_plan' ? 'ASSIST_PLAN' : 'PLAN';
  // Which channel carries the document differs per engine (see
  // AGENT_ARTIFACT_CLAUSE); everything else in the binding is shared.
  const artifactClauses = engine === 'agent'
    ? `${ONE_DOCUMENT_CLAUSE}\n${AGENT_ARTIFACT_CLAUSE}\n`
    : `${ONE_DOCUMENT_CLAUSE}\n${ARTIFACT_CLAUSE}\n${REPLY_BREVITY_CLAUSE}\n`;
  // Which question channel exists is an engine fact, exactly like the
  // artifact channel above. This clause used to be shared, which is how a
  // classic-engine turn came to be told to call a tool it was never given.
  const questionClause = engine === 'agent' ? QUESTION_CLAUSE_AGENT : QUESTION_CLAUSE_LEGACY;
  return `You are in ${modeLabel} mode. ${named.charAt(0).toUpperCase()}${named.slice(1)} `
    + 'in the skills block above is your process for this turn — follow it as '
    + 'written. The bindings below are the parts of this environment that skill '
    + 'cannot know about; where they and the skill disagree, these win.\n\n'
    + '- **Where you are in the process.** There is no separate stage tracker — '
    + 're-read the conversation to work out which step you are on, and pick up '
    + 'from there. A fresh request starts at that skill\'s beginning; do not '
    + 'skip ahead to a finished plan because the request sounds simple.\n'
    + writingClause(mode, planWrite)
    + `${questionClause}\n`
    + artifactClauses
    + `${FACTS_CLAUSE}\n`
    + '- **No other write tool.** File edits, shell commands, git operations '
    + 'and issue/PR actions are unavailable in this mode'
    + (engine === 'agent' ? '.' : '; `save-plan` is the only action you can take.');
}

/**
 * The Execute-mode binding for a turn launched from the PlanSavedCard —
 * the plan is approved and attached, and the injected skill (chosen by
 * `executeSkillId`) is how to work through it.
 */
export function buildExecuteBinding({ skillName, hasSubagents, engine = 'legacy' } = {}) {
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
    + 'mechanism the skill names. This is not optional bookkeeping: the '
    + 'progress card the user watches is driven by it, and without it the app '
    + 'cannot tell a finished plan from a turn that stopped after step 1.\n'
    + '- **Finish the plan.** Pressing Execute was the go-ahead for EVERY step. '
    + 'Work through all of them in this turn; do not stop after one to ask '
    + '"ready for the next?". Ask only when a step needs a decision the plan '
    + 'does not settle'
    // Same engine fact as the plan binding's question clause: only the Agent
    // engine has the tool. Naming it on the classic engine is what made an
    // Execute turn hand-draw an options card in the chat.
    + (engine === 'agent'
      ? ' — with `AskUserQuestion`, so the answer returns inside this turn.\n'
      : ', and expect that question to end the turn: you have no question tool '
        + 'on this engine, so it goes in your reply.\n')
    + '- **Stay on the current branch.** Do not check out, create or switch '
    + 'branches unless a plan step says so — a commit made after a checkout '
    + 'lands where the user is not looking, and the working tree they review '
    + 'afterwards no longer holds your changes.\n'
    + `${FACTS_CLAUSE}`;
}
