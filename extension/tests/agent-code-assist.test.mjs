import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/runtime/skill-loader.mjs';
import { searchKb } from '../llm_agent/runtime/handlers/search-kb.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'node:path';

const handlers = { 'search-kb': searchKb };

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'internal', 'skills');

test('full loop: real skills, mocked claude — write tool returns pendingTool', async () => {
  const { skills, base, warnings } = loadSkills(SKILLS_DIR);
  assert.deepEqual(warnings, []);
  const fakeClaude = async (_p) => 'Filing it.\n<<<TOOL_CALL>>>\n{"name":"create-gitlab-issue","arguments":{"title":"Make sidebar icons colourful","description":"Currently monochrome; user wants colour per the existing accent palette."}}\n<<<END_TOOL_CALL>>>';
  const result = await runAgentLoop({
    skills,
    userMessage: 'can you create an issue to make sidebar icons colourful',
    history: [],
    agentContext: {
      base,
      activeProject: { name: 'notes-extension', url: 'https://gitlab.com/example/notes', defaultBranch: 'main' },
      indexedRepos: [{ name: 'notes-extension', path: '~/Developer/MeetNotes/notes-extension' }],
    },
    runClaude: fakeClaude,
    kb: { search: () => [] },
    userId: 'user-1',
    handlers,
  });
  assert.equal(result.pendingTool.name, 'create-gitlab-issue');
  assert.equal(result.pendingTool.arguments.title, 'Make sidebar icons colourful');
  assert.match(result.reply, /Filing it/);
});

test('full loop: real skills, mocked claude — search + answer', async () => {
  const { skills, base } = loadSkills(SKILLS_DIR);
  const outs = [
    '<<<TOOL_CALL>>>\n{"name":"search-kb","arguments":{"query":"sidebar icons colour"}}\n<<<END_TOOL_CALL>>>',
    'Last week we decided to keep the icons monochrome but increase the accent ring.',
  ];
  let i = 0;
  const fakeClaude = async () => outs[i++];
  const fakeKb = { search: () => [{ kind: 'decision', id: 'd1', title: 'Sidebar icons stay mono', snippet: '...' }] };
  const result = await runAgentLoop({
    skills,
    userMessage: 'what did we decide about sidebar icon colours?',
    history: [],
    agentContext: {
      base,
      activeProject: null,
      indexedRepos: [],
    },
    runClaude: fakeClaude,
    kb: fakeKb,
    userId: 'user-1',
    handlers,
  });
  assert.equal(result.pendingTool, null);
  assert.match(result.reply, /monochrome/);
});

test('full loop: agent honours (none configured) and does not call create-gitlab-issue', async () => {
  const { skills, base } = loadSkills(SKILLS_DIR);
  // When the active project is missing, a well-behaved agent should
  // refuse to call create-gitlab-issue. We simulate that.
  const fakeClaude = async () => 'You have no active GitLab project. Add one in Settings → GitLab.';
  const result = await runAgentLoop({
    skills,
    userMessage: 'create an issue',
    history: [],
    agentContext: { base, activeProject: null, indexedRepos: [] },
    runClaude: fakeClaude,
    kb: { search: () => [] },
    userId: 'user-1',
    handlers,
  });
  assert.equal(result.pendingTool, null);
  assert.match(result.reply, /Settings/);
});
