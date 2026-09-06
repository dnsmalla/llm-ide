// extension/tests/plan-pipeline.test.mjs
// The planning pipeline's stage resolution and bindings
// (llm_agent/runtime/plan-pipeline.mjs), plus the mode-skills block that
// carries a stage skill into the prompt (core/prompt-framing.mjs).
//
// The point of these tests is the CONTRACT between the two halves of the
// design: the skill files are verbatim upstream mirrors (nobody edits them
// here), so everything app-specific has to live in the bindings — and the
// bindings must not quietly grow into a paraphrase of the skills.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  DISCOVER_SKILL_IDS, WRITE_SKILL_ID, EXECUTE_SKILL_IDS,
  discoverSkillIdForMode, executeSkillId, pipelineSkillIdFor,
  buildPlanBinding, buildExecuteBinding,
} from '../llm_agent/runtime/plan-pipeline.mjs';
import { buildModeSkillsText } from '../core/prompt-framing.mjs';

// --- stage resolution -------------------------------------------------------

test('plan runs brainstorming, assist_plan runs grilling', () => {
  assert.equal(discoverSkillIdForMode('plan'), 'skills/brainstorming');
  assert.equal(discoverSkillIdForMode('assist_plan'), 'skills/grilling');
});

test('non-plan modes get no discover skill', () => {
  for (const mode of ['execute', 'review', 'document', 'auto', undefined, '']) {
    assert.equal(discoverSkillIdForMode(mode), null, `${mode} should not inject a planning skill`);
  }
});

test('execute stage picks subagent-driven vs inline by subagent availability', () => {
  assert.equal(executeSkillId({ hasSubagents: true }), 'skills/subagent-driven-development');
  assert.equal(executeSkillId({ hasSubagents: false }), 'skills/executing-plans');
  // No info == no subagents: 32 KB of dispatch instructions for agents that
  // don't exist is the worse failure of the two.
  assert.equal(executeSkillId(), 'skills/executing-plans');
});

test('pipelineSkillIdFor: exactly one skill per turn, planExecute winning over mode', () => {
  assert.equal(pipelineSkillIdFor({ mode: 'plan' }), 'skills/brainstorming');
  assert.equal(pipelineSkillIdFor({ mode: 'execute' }), null);
  assert.equal(
    pipelineSkillIdFor({ mode: 'execute', planExecute: true, hasSubagents: true }),
    'skills/subagent-driven-development',
  );
  // A client that somehow sent both: an approved plan waiting to run is the
  // more specific signal, so it wins over the mode's discover stage.
  assert.equal(
    pipelineSkillIdFor({ mode: 'plan', planExecute: true, hasSubagents: false }),
    'skills/executing-plans',
  );
});

// --- bindings ---------------------------------------------------------------

test('plan binding names the stage-2 hand-off with the id load-skill accepts', () => {
  const binding = buildPlanBinding('plan', { skillName: 'brainstorming' });
  assert.match(binding, /load-skill/);
  assert.ok(binding.includes(WRITE_SKILL_ID),
    `binding must name "${WRITE_SKILL_ID}" verbatim — a model retyping it as "writing-plans" gets an unknown-id miss`);
});

test('plan binding redirects file writes to save-plan and drops git', () => {
  const binding = buildPlanBinding('assist_plan', { skillName: 'grilling' });
  assert.match(binding, /save-plan/);
  assert.match(binding, /llm-doc\/plans\//);
  assert.match(binding, /git commit/);   // named so the skill's commit steps are explicitly skipped
  assert.match(binding, /worktree/);
});

test('plan binding keeps the saved document out of the chat reply', () => {
  // The card already renders the plan body with the file path and an Execute
  // action; a model that also writes it out as prose puts the same document
  // in the chat twice, untruncated. Both plan-like modes must carry the rule.
  for (const mode of ['plan', 'assist_plan']) {
    const binding = buildPlanBinding(mode, { skillName: 'brainstorming' });
    assert.match(binding, /Do not restate the document in your reply/);
    assert.match(binding, /headings only/);
    // The upstream writing-plans skill ends by asking the user to choose
    // subagent vs inline execution; here the server picks it from the
    // Execute action, so the question would be dead-end UI.
    assert.match(binding, /Do not ask which execution mode/);
  }
});

test('execute binding tells the model which execution skill it got, and why', () => {
  const withAgents = buildExecuteBinding({ skillName: 'subagent-driven-development', hasSubagents: true });
  assert.match(withAgents, /ask-subagent/);
  const without = buildExecuteBinding({ skillName: 'executing-plans', hasSubagents: false });
  assert.match(without, /No subagents/);
  // Without this the inline skill's own "switch to subagent-driven if you
  // have subagents" opener sends the model looking for a tool it wasn't given.
  assert.match(without, /ignore any\s+instruction to switch/);
});

test('every binding carries the cheap-facts rule', () => {
  for (const binding of [
    buildPlanBinding('plan', { skillName: 'brainstorming' }),
    buildPlanBinding('assist_plan', { skillName: 'grilling' }),
    buildExecuteBinding({ skillName: 'executing-plans', hasSubagents: false }),
  ]) {
    assert.match(binding, /find-code/);
    assert.match(binding, /search-kb/);
    assert.match(binding, /project-memory/);
    assert.match(binding, /never ask the user\s+for a fact|never open with a repo-wide/);
  }
});

// --- the mode-skills block --------------------------------------------------

test('buildModeSkillsText frames the block as the MODE\'s process, not a user pick', () => {
  const fake = () => ({ id: 'skills/grilling', name: 'grilling', content: 'ask in rounds' });
  const { text, names } = buildModeSkillsText(['skills/grilling'], 'u1', fake);
  assert.deepEqual(names, ['grilling']);
  assert.match(text, /## Skill: grilling/);
  assert.match(text, /TRUSTED\s+INSTRUCTIONS/);
  // A model told the user "explicitly invoked" a skill they never chose
  // hedges about it; this block must not claim that.
  assert.ok(!/explicitly invoked/.test(text));
  // The bindings override the skill, so the block has to say so.
  assert.match(text, /override/);
});

test('buildModeSkillsText raises the per-skill cap above the "/" menu default', () => {
  let seenMax = null;
  const fake = (id, userId, opts) => { seenMax = opts?.maxChars; return { id, name: 'x', content: 'y' }; };
  buildModeSkillsText(['skills/subagent-driven-development'], 'u1', fake);
  // subagent-driven-development is ~32 KB upstream; the 24 KB "/" menu cap
  // would cut it mid-process.
  assert.ok(seenMax >= 32_000, `expected a cap above 32k for a pipeline skill, got ${seenMax}`);
});

test('an unresolvable skill degrades the turn instead of failing it', () => {
  const { text, names } = buildModeSkillsText(['skills/nope'], 'u1', () => null);
  assert.equal(text, '');
  assert.deepEqual(names, []);
});

// --- the skills the pipeline points at must actually ship -------------------

// .skills (BUILTIN_ID) is the ONLY skill source now — no curated allowlist,
// no committed fallback copy (see docs/explanation/invariants.md). Skipped
// rather than failed when .skills isn't checked out locally/in CI: it's a
// private submodule (see .github/workflows/skills-drift.yml's own note),
// same reasoning that check applies.
test('every pipeline skill id ships in .skills — no fallback copy exists any more', async (t) => {
  const { resolveCentralSkillsRepo } = await import('../core/skills-repo.mjs');
  const repo = resolveCentralSkillsRepo();
  if (!repo) { t.skip('.skills is not initialized locally — run `git submodule update --init .skills`'); return; }
  const ids = [
    ...Object.values(DISCOVER_SKILL_IDS),
    WRITE_SKILL_ID,
    ...Object.values(EXECUTE_SKILL_IDS),
  ];
  for (const id of ids) {
    const [family, dir] = id.split('/');
    const file = join(repo, family, dir, 'SKILL.md');
    assert.ok(existsSync(file),
      `${id} is injected by the pipeline but missing from .skills — `
      + '.skills is the only skill source now, so the mode would run with bindings and no process');
  }
});
