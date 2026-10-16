// The legacy loop (ask-internal's sub-loop) must hand its read handlers the
// turn's workspaceRoot: search-kb scopes code hits by it, and without it the
// internal agent searched every repo the user ever indexed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';
import { INTERNAL_HANDLERS } from '../llm_agent/runtime/handlers/ask-internal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERNAL_SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'internal', 'skills');

test('legacy loop: search-kb reaches kb.search with the turn\'s workspace as codeRoot', async () => {
  const { skills } = loadSkills(INTERNAL_SKILLS_DIR);
  const responses = [
    '<<<TOOL_CALL>>>\n{"name":"search-kb","arguments":{"query":"graph"}}\n<<<END_TOOL_CALL>>>',
    'Nothing relevant was found.',
  ];
  let call = 0;
  let asked;
  const kb = { search: (uid, opts) => { asked = opts; return []; } };
  await runAgentLoop({
    skills,
    userMessage: 'Where is the graph layout code?',
    history: [],
    agentContext: { base: '', workspaceRoot: '/work/proj' },
    runClaude: async () => responses[call++],
    kb,
    userId: 'u1',
    handlers: INTERNAL_HANDLERS,
  });
  assert.ok(asked, 'search-kb ran');
  assert.equal(asked.codeRoot, '/work/proj');
});
