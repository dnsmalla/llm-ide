// extension/tests/mode-personas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { personaForMode, restrictsTools, allowedToolNames, PLAN_LIKE_MODES } from '../llm_agent/runtime/mode-personas.mjs';

test('personaForMode returns mode-specific text for plan/assist_plan/review/document', () => {
  assert.match(personaForMode('plan'), /PLAN mode/);
  assert.match(personaForMode('assist_plan'), /ASSIST_PLAN mode/);
  assert.match(personaForMode('review'), /REVIEW mode/);
  assert.match(personaForMode('document'), /DOCUMENT mode/);
});

// The plan-like personas are BINDINGS, not a process: the process is the
// pipeline skill injected alongside them (plan-pipeline.mjs). These assert
// the bindings say what only the app can know, and — just as importantly —
// that they do NOT re-describe the skill's steps. A paraphrase here is the
// exact second copy that drifted from .skills/skills/assist-plan/SKILL.md
// before this was reworked.
for (const mode of ['plan', 'assist_plan']) {
  test(`${mode} persona binds save-plan, the facts tools and the writing-plans hand-off`, () => {
    const persona = personaForMode(mode, { skillName: 'grilling' });
    assert.match(persona, /save-plan/);
    assert.match(persona, /llm-doc\/plans\//);
    assert.match(persona, /load-skill/);
    assert.match(persona, /skills\/writing-plans/);
    assert.match(persona, /find-code/);
    assert.match(persona, /search-kb/);
    assert.match(persona, /project-memory/);
    // Names the injected skill so the binding and the skills block agree.
    assert.match(persona, /grilling/);
  });

  test(`${mode} persona does not paraphrase the skill's own process`, () => {
    const persona = personaForMode(mode);
    assert.ok(!/the 5 phases below/.test(persona), 'the old hand-written phase list should be gone');
    assert.ok(!/❓/.test(persona), 'the question format belongs to the grilling skill, not the persona');
    // Bindings only — a small fraction of the 15-32 KB skills they frame.
    // A regression here means someone started re-describing the process.
    assert.ok(persona.length < 3000, `binding should stay short, was ${persona.length} chars`);
  });
}

test('a plan persona without an injected skill still binds the mode coherently', () => {
  const persona = personaForMode('plan');
  assert.match(persona, /PLAN mode/);
  assert.match(persona, /save-plan/);
});

test('personaForMode returns empty string for execute (no persona change)', () => {
  assert.equal(personaForMode('execute'), '');
});

test('personaForMode returns empty string for an unrecognised mode', () => {
  assert.equal(personaForMode('something-else'), '');
});

test('restrictsTools is true for plan/assist_plan/review/document, false for execute', () => {
  assert.equal(restrictsTools('plan'), true);
  assert.equal(restrictsTools('assist_plan'), true);
  assert.equal(restrictsTools('review'), true);
  assert.equal(restrictsTools('document'), true);
  assert.equal(restrictsTools('execute'), false);
  assert.equal(restrictsTools('something-else'), false);
});

test('allowedToolNames returns a Set that does NOT include run-bash (it executes unconfirmed, despite kind: read)', () => {
  const names = allowedToolNames();
  assert.ok(names instanceof Set);
  assert.equal(names.has('run-bash'), false);
  assert.equal(names.has('bash'), false);
});

test('allowedToolNames excludes all write-kind tools (git-op, update-file) alongside run-bash', () => {
  const names = allowedToolNames();
  assert.equal(names.has('git-op'), false);
  assert.equal(names.has('update-file'), false);
});

test('allowedToolNames includes genuinely read-only tools', () => {
  const names = allowedToolNames();
  assert.ok(names.size > 0);
  assert.ok(names.has('search-kb'));
  assert.ok(names.has('read-file'));
  assert.ok(names.has('list-files'));
});

test('allowedToolNames excludes task tracking tools — Plan/Review/Document modes never track a multi-step plan', () => {
  const names = allowedToolNames();
  assert.equal(names.has('task-create'), false);
  assert.equal(names.has('task-update'), false);
  assert.equal(names.has('task-list'), false);
});

test('allowedToolNames excludes save-plan when called with no mode (or a non-plan-like mode)', () => {
  assert.equal(allowedToolNames().has('save-plan'), false);
  assert.equal(allowedToolNames('review').has('save-plan'), false);
  assert.equal(allowedToolNames('document').has('save-plan'), false);
});

test('allowedToolNames includes save-plan on top of the base read-only set for every plan-like mode', () => {
  for (const mode of PLAN_LIKE_MODES) {
    const names = allowedToolNames(mode);
    assert.equal(names.has('save-plan'), true, `expected save-plan for mode "${mode}"`);
    // Base set is still fully present — this is additive, not a replacement.
    assert.equal(names.has('read-file'), true);
    assert.equal(names.has('update-file'), false);
  }
});

test('PLAN_LIKE_MODES is exactly {plan, assist_plan}', () => {
  assert.deepEqual([...PLAN_LIKE_MODES].sort(), ['assist_plan', 'plan']);
});

test('READ_ONLY_TOOL_NAMES is derived from the registry, not hand-maintained', async () => {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(__dirname, '..', 'llm_agent', 'runtime', 'mode-personas.mjs'), 'utf8');
  assert.ok(src.includes("kind === 'read'"), 'expected the read-only set to be derived from registry entry.kind');
  assert.ok(!/const READ_ONLY_TOOL_NAMES = new Set\(\[\s*\n\s*'ask-internal',/.test(src), 'the old hand-maintained literal should be gone');
});

test('allowedToolNames(execute) includes all kind:read tools except task-list', () => {
  const names = [...allowedToolNames('execute')].sort();
  assert.deepEqual(names, ['ask-internal', 'ask-subagent', 'fetch-url', 'find-code', 'list-files', 'load-skill', 'project_memory', 'read-file', 'search-kb', 'web-search']);
});

test('allowedToolNames(execute) explicitly excludes task-list despite it being kind:read', () => {
  const names = allowedToolNames('execute');
  assert.equal(names.has('task-list'), false, 'task-list should be excluded even though it is kind:read in the registry');
});

test('allowedToolNames(plan) adds save-plan on top of the base 10-tool read set', () => {
  const names = [...allowedToolNames('plan')].sort();
  assert.ok(names.includes('save-plan'));
  assert.equal(names.length, 11);
});

// load-skill is what makes a skill's "now invoke <other skill>" line
// followable — and every restricted mode is where that matters most, since
// none of them can reach for a shell or the filesystem to find it themselves.
test('load-skill is available in every restricted mode', () => {
  for (const mode of ['plan', 'assist_plan', 'review', 'document']) {
    assert.equal(allowedToolNames(mode).has('load-skill'), true, `${mode} should expose load-skill`);
  }
});
