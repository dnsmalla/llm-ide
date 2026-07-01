import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askInternal } from '../llm_agent/runtime/handlers/ask-internal.mjs';
import { composeGlobalPrompt } from '../llm_agent/global/compose-prompt.mjs';
import { buildSystemPrompt } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERNAL_SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'internal', 'skills');
const GLOBAL_SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'global');

test('composeGlobalPrompt is the role BASE only — no skills, no system context', () => {
  const prompt = composeGlobalPrompt();
  assert.match(prompt, /Code Assistant for LLM IDE/);          // role present
  // Skill bodies are NOT embedded in the base — the loop renders them once
  // (see the dedup guard below). Embedding them here too double-sent skills.
  assert.doesNotMatch(prompt, /# Available skills/);
  // Regression guard: no app-specific context leaks into global.
  assert.doesNotMatch(prompt, /## Active project/);
  assert.doesNotMatch(prompt, /## Recent open issues/);
  assert.doesNotMatch(prompt, /## Recent meetings/);
  assert.doesNotMatch(prompt, /## App capabilities/);
});

test('assembled global prompt renders skills exactly once (dedup guard)', () => {
  const skills = loadSkills(GLOBAL_SKILLS_DIR);
  // What the loop actually builds for the global agent: base + (no context) + skills.
  const full = buildSystemPrompt({ base: composeGlobalPrompt(), skills: skills.skills, agentContextBlock: '' });
  assert.match(full, /Code Assistant for LLM IDE/);            // role still there
  assert.match(full, /# ask-internal/);                        // skills present (rendered by the loop)
  // Exactly one "# Available skills" header — previously two (base + loop).
  assert.equal((full.match(/# Available skills/g) || []).length, 1);
});

test('askInternal — plain reply from internal propagates as answer', async () => {
  const internalSkills = loadSkills(INTERNAL_SKILLS_DIR);
  // Mock claude: internal responds with plain prose (no fence).
  const fakeClaude = async () => 'Issue #1 is open and titled "Make sidebar icons colourful".';
  const result = await askInternal(
    { question: 'what is issue #1?' },
    {
      agentContext: {
        activeProject: { name: 'notes', url: 'https://x' },
        recentIssues: [{ iid: 1, title: 'Make sidebar icons colourful', state: 'opened', labels: [] }],
      },
      runClaude: fakeClaude,
      kb: { search: () => [] },
      userId: 'user-1',
      internalSkills,
    },
  );
  assert.match(result.answer, /Issue #1/);
  assert.equal(result.pendingTool, null);
});

test('askInternal — write tool from internal propagates as pendingTool', async () => {
  const internalSkills = loadSkills(INTERNAL_SKILLS_DIR);
  const fakeClaude = async () =>
    'Filing it.\n<<<TOOL_CALL>>>\n{"name":"create-gitlab-issue","arguments":{"title":"X","description":"Y"}}\n<<<END_TOOL_CALL>>>';
  const result = await askInternal(
    { question: 'create an issue' },
    {
      agentContext: {
        activeProject: { name: 'notes', url: 'https://x' },
        recentIssues: [],
      },
      runClaude: fakeClaude,
      kb: { search: () => [] },
      userId: 'user-1',
      internalSkills,
    },
  );
  assert.ok(result.pendingTool);
  assert.equal(result.pendingTool.name, 'create-gitlab-issue');
  assert.equal(result.pendingTool.arguments.title, 'X');
});

test('askInternal — search-kb call by internal feeds back, internal answers', async () => {
  const internalSkills = loadSkills(INTERNAL_SKILLS_DIR);
  const outs = [
    '<<<TOOL_CALL>>>\n{"name":"search-kb","arguments":{"query":"sidebar"}}\n<<<END_TOOL_CALL>>>',
    'Last week we decided to keep the icons monochrome.',
  ];
  let i = 0;
  const fakeClaude = async () => outs[i++];
  const fakeKb = { search: () => [{ kind: 'decision', id: 'd1', title: 'Sidebar icons', snippet: '...' }] };
  const result = await askInternal(
    { question: 'what did we decide about sidebar icons?' },
    {
      agentContext: { activeProject: null, recentIssues: [] },
      runClaude: fakeClaude,
      kb: fakeKb,
      userId: 'user-1',
      internalSkills,
    },
  );
  assert.match(result.answer, /monochrome/);
  assert.equal(result.pendingTool, null);
});
