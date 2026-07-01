// F5: skill-invocation telemetry. Selection is 100% description-quality-driven,
// so we must record which skills actually get invoked (and for whom) to be able
// to measure triggering quality offline. runAgentLoop must emit a persistent
// `skill_invoked` log line at the single dispatch point — for BOTH read and
// write skills.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';
import { logger } from '../core/logger.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'global');

// Spy on logger.info for the duration of `fn`, capturing (event, fields) pairs.
async function captureInfo(fn) {
  const captured = [];
  const original = logger.info;
  logger.info = (event, fields) => { captured.push({ event, fields }); };
  try { await fn(); } finally { logger.info = original; }
  return captured;
}

test('logs skill_invoked for a WRITE skill at dispatch', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  // update-file is a write skill — the loop returns pendingTool without
  // executing, but the invocation must still be recorded.
  const fakeClaude = async () =>
    '<<<TOOL_CALL>>>\n{"name":"update-file","arguments":{"path":"a.txt","content":"hi"}}\n<<<END_TOOL_CALL>>>';
  const logs = await captureInfo(() => runAgentLoop({
    skills, userMessage: 'edit the file', history: [],
    agentContext: { base: '' }, runClaude: fakeClaude, kb: null,
    userId: 'user-42', handlers: {},
  }));
  const inv = logs.find((l) => l.event === 'skill_invoked');
  assert.ok(inv, 'a skill_invoked line must be logged');
  assert.equal(inv.fields.skill, 'update-file');
  assert.equal(inv.fields.kind, 'write');
  assert.equal(inv.fields.userId, 'user-42');
});

test('logs skill_invoked for a READ skill at dispatch', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  const handlers = { 'read-file': async () => ({ content: 'file body' }) };
  const responses = [
    '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"a.txt"}}\n<<<END_TOOL_CALL>>>',
    'Here is what the file says.',
  ];
  let i = 0;
  const fakeClaude = async () => responses[i++];
  const logs = await captureInfo(() => runAgentLoop({
    skills, userMessage: 'read the file', history: [],
    agentContext: { base: '' }, runClaude: fakeClaude, kb: null,
    userId: 'user-7', handlers,
  }));
  const inv = logs.find((l) => l.event === 'skill_invoked' && l.fields.skill === 'read-file');
  assert.ok(inv, 'a skill_invoked line must be logged for the read skill');
  assert.equal(inv.fields.kind, 'read');
  assert.equal(inv.fields.userId, 'user-7');
});
