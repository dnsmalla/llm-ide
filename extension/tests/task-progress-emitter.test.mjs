// makeTaskProgressEmitter (llm_agent/runtime/task-session-context.mjs) — the
// shared mid-turn task-progress emitter behind BOTH engines' SSE streams
// (routes/agent-v2.mjs on tool_result, server/ai-routes.mjs's legacy
// /code-assist stream on phase:'tool' progress). The v2 route test covers it
// end to end; these pin the emitter's own contract, which the legacy hookup
// has no deps seam to exercise through a full turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_task-progress-emitter-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { makeTaskProgressEmitter } = await import('../llm_agent/runtime/task-session-context.mjs');
const { tasks } = await import('../llm_agent/runtime/handlers/session-tasks.mjs');

const ctxFor = (sessionId) => ({ chatSessionId: sessionId });

test('emits only when the list changed, as tasks_progress with no continueNeeded', () => {
  const sid = 'emitter-dedupe';
  const t1 = tasks.createTask('u1', sid, 'First');
  tasks.createTask('u1', sid, 'Second');
  const sent = [];
  const emit = makeTaskProgressEmitter({
    userId: 'u1', agentContext: ctxFor(sid), mode: 'execute', send: (e) => sent.push(e),
  });
  emit();          // first look: both pending → emits
  emit();          // unchanged → silent
  tasks.updateTask('u1', sid, t1.id, { status: 'completed' });
  emit();          // changed → emits
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, 'tasks_progress');
  // The list only — continueNeeded mid-turn would read as "start another
  // turn" to a client that auto-chains on it.
  assert.equal('continueNeeded' in sent[0], false);
  assert.deepEqual(sent[1].tasks.map((t) => t.status), ['completed', 'pending']);
});

test('an empty list never emits, and a restricted mode reports empty', () => {
  const sent = [];
  makeTaskProgressEmitter({
    userId: 'u1', agentContext: ctxFor('emitter-empty'), mode: 'execute', send: (e) => sent.push(e),
  })();
  // Plan-like modes zero the list via restrictsTools even when the session
  // has tasks left over from an earlier execute turn.
  const sid = 'emitter-restricted';
  tasks.createTask('u1', sid, 'Leftover');
  makeTaskProgressEmitter({
    userId: 'u1', agentContext: ctxFor(sid), mode: 'plan', send: (e) => sent.push(e),
  })();
  assert.equal(sent.length, 0);
});

test('a throwing send is swallowed — task bookkeeping must never break the stream', () => {
  const sid = 'emitter-throws';
  tasks.createTask('u1', sid, 'Only');
  const emit = makeTaskProgressEmitter({
    userId: 'u1', agentContext: ctxFor(sid), mode: 'execute',
    send: () => { throw new Error('stream closed'); },
  });
  assert.doesNotThrow(emit);
});
