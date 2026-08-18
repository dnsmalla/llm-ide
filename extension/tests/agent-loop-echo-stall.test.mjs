// Regression tests for the fence loop's echo-stall guard.
//
// Observed failure (2026-08-18, Plan mode): after a read tool returned, the
// model's next output was a verbatim copy of the <<<TOOL_RESULT>>> JSON with
// no fence. The loop treated that fence-less output as the final answer and
// ended the turn — so the plan was never written, save-plan was never called,
// and the raw JSON leaked into the user-visible reply. The guard must nudge
// the model to continue instead of finishing on an echoed tool result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'global');

const FILES_RESULT = {
  files: [
    'README.md', '.gitignore', 'iis_analyzer/main.py', 'iis_analyzer/parser.py',
    'code/iis_summary/iis_analyzer/main.py', 'llm-doc/plans/2026-08-12-old.md',
  ],
};
// Byte-identical to what buildIterationPrompt embeds in <<<TOOL_RESULT>>>.
const FILES_RESULT_JSON = JSON.stringify(FILES_RESULT);

const handlers = {
  'list-files': async () => FILES_RESULT,
};

test('echo stall: a verbatim tool-result echo is nudged, not treated as the final answer', async () => {
  const { skills } = loadSkills(SKILLS_DIR);

  const prompts = [];
  const responses = [
    // 1: agent lists files
    'Let me look at the project first.\n<<<TOOL_CALL>>>\n{"name":"list-files","arguments":{}}\n<<<END_TOOL_CALL>>>',
    // 2: model goes off the rails — echoes the tool result verbatim, no fence
    `\n${FILES_RESULT_JSON}`,
    // 3: after the nudge it recovers and finishes with the plan + save-plan
    'Here is the plan: remove the duplicated tree.\n<<<TOOL_CALL>>>\n{"name":"save-plan","arguments":{"title":"Remove unnecessary files","content":"# Plan\\n\\n1. Remove code/iis_summary duplicates."}}\n<<<END_TOOL_CALL>>>',
  ];
  let callCount = 0;
  const fakeClaude = async (prompt) => {
    prompts.push(prompt);
    return responses[callCount++];
  };

  const result = await runAgentLoop({
    skills,
    userMessage: 'Plan how to remove unnecessary files.',
    history: [],
    agentContext: { base: '' },
    runClaude: fakeClaude,
    kb: null,
    userId: 'test-user',
    handlers,
  });

  // The echo must not end the turn: the loop should have called the model a
  // third time and surfaced the save-plan write.
  assert.equal(callCount, 3, `Expected 3 model calls (echo nudged), got ${callCount}`);
  assert.equal(result.pendingTool?.name, 'save-plan');
  // The nudge should reach the model as a tool error it can react to.
  assert.match(prompts[2], /repeated the tool result/i);
  // The echoed JSON must not leak into the user-visible reply.
  assert.ok(!result.reply.includes('"files"'),
    `Raw tool-result JSON leaked into the reply: ${result.reply}`);
});

test('echo stall: the nudge fires at most once per turn (no infinite loop)', async () => {
  const { skills } = loadSkills(SKILLS_DIR);

  const responses = [
    '<<<TOOL_CALL>>>\n{"name":"list-files","arguments":{}}\n<<<END_TOOL_CALL>>>',
    `${FILES_RESULT_JSON}`,   // echo 1 → nudged
    `${FILES_RESULT_JSON}`,   // echo 2 → give up, finish the turn
    'never reached',
  ];
  let callCount = 0;
  const fakeClaude = async () => responses[callCount++];

  const result = await runAgentLoop({
    skills,
    userMessage: 'Plan how to remove unnecessary files.',
    history: [],
    agentContext: { base: '' },
    runClaude: fakeClaude,
    kb: null,
    userId: 'test-user',
    handlers,
  });

  assert.equal(callCount, 3, 'Second echo must end the turn, not loop forever');
  assert.equal(result.pendingTool, null);
  // The give-up path must not reproduce the original symptom either: the raw
  // JSON stays out of the reply, replaced by a graceful stall note.
  assert.ok(!result.reply.includes('"files"'),
    `Raw tool-result JSON leaked into the give-up reply: ${result.reply}`);
  assert.match(result.reply, /stalled repeating a tool result/);
});

test('echo stall: a real answer that merely mentions the data is NOT nudged', async () => {
  const { skills } = loadSkills(SKILLS_DIR);

  const responses = [
    '<<<TOOL_CALL>>>\n{"name":"list-files","arguments":{}}\n<<<END_TOOL_CALL>>>',
    'The project has a README.md, an iis_analyzer package, and a duplicated copy under code/iis_summary. I would remove the duplicate.',
  ];
  let callCount = 0;
  const fakeClaude = async () => responses[callCount++];

  const result = await runAgentLoop({
    skills,
    userMessage: 'What files does the project have?',
    history: [],
    agentContext: { base: '' },
    runClaude: fakeClaude,
    kb: null,
    userId: 'test-user',
    handlers,
  });

  assert.equal(callCount, 2, 'A legitimate final answer must finish the turn normally');
  assert.match(result.reply, /duplicated copy/);
});
