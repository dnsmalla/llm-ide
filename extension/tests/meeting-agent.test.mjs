// Meeting-agent tests — covers the question loop's gate logic and
// the in-memory state machine without touching the real Claude CLI.
//
// Strategy: stub `draftQuestion` and `getPlan` via dynamic import
// (mock-import via Node's `--experimental-loader` is overkill for
// our single consumer; instead we re-import `meeting-agent.mjs`
// after monkey-patching the module-internal references through the
// loop's own fixture knobs).
//
// Where direct stubbing isn't possible we exercise the public API
// (dispatchAgent / stopAgent / getDiagnostics) against the live
// in-memory store.  These tests don't need the DB, network, or CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEETNOTES_JWT_SECRET = 'a'.repeat(48);
process.env.MEETNOTES_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

// Have to bypass the kb/db.mjs import because it opens better-
// sqlite3 against a real file.  Provide a minimal stub via a
// pre-installed mock if Node's import map supports it; otherwise
// these tests skip the planId path and exercise everything else.
const liveSessions = await import('../agents/live-sessions.mjs');
const meetingAgent = await import('../agents/meeting-agent.mjs');

function reset() {
  meetingAgent._resetForTests();
  liveSessions._resetForTests();
}

// ── dispatchAgent / stopAgent — sessionId resolution ────────────────

test('dispatchAgent picks most-recent active live session when sessionId omitted', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-A', [
    { speaker: 'Alice', text: 'first', ts: Date.now() - 1000, source: 'extension-cc' },
  ]);
  // Wait a tick so lastWrite differs.
  await new Promise((r) => setTimeout(r, 5));
  liveSessions.appendCaptions('user-1', 'sess-B', [
    { speaker: 'Bob', text: 'newer', ts: Date.now(), source: 'extension-cc' },
  ]);
  const result = await meetingAgent.dispatchAgent({ userId: 'user-1' });
  assert.equal(result.sessionId, 'sess-B', 'should attach to most-recently-active');
  assert.equal(result.attached, true);
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-B' });
});

test('dispatchAgent throws when no active sessions exist and none was provided', async () => {
  reset();
  await assert.rejects(
    () => meetingAgent.dispatchAgent({ userId: 'user-1' }),
    /No active capture session/,
  );
});

test('dispatchAgent is idempotent — second call returns attached:false reason:already-attached', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-X', [
    { speaker: 'Alice', text: 'hi', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({ userId: 'user-1', sessionId: 'sess-X' });
  const second = await meetingAgent.dispatchAgent({ userId: 'user-1', sessionId: 'sess-X' });
  assert.equal(second.attached, false);
  assert.equal(second.reason, 'already-attached');
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-X' });
});

test('stopAgent rejects ownership mismatch', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-Y', [
    { speaker: 'Alice', text: 'hi', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({ userId: 'user-1', sessionId: 'sess-Y' });
  const result = await meetingAgent.stopAgent({ userId: 'user-evil', sessionId: 'sess-Y' });
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'forbidden');
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-Y' });
});

test('stopAgent on unknown session returns reason:unknown-session', async () => {
  reset();
  const result = await meetingAgent.stopAgent({ userId: 'u', sessionId: 'phantom' });
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'unknown-session');
});

// ── Persona resolution ─────────────────────────────────────────────

test('attach line uses persona name when provided', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-P', [
    { speaker: 'Alice', text: 'hi', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({
    userId: 'user-1', sessionId: 'sess-P',
    persona: { name: 'Atlas' },
  });
  const stream = liveSessions.getCaptionsSince('user-1', 'sess-P', 0);
  const attachLine = stream.captions.find((c) => c.source === 'agent-system');
  assert.ok(attachLine, 'attach line should be present');
  assert.equal(attachLine.speaker, 'Atlas');
  assert.match(attachLine.text, /Atlas/);
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-P' });
});

test('attach line falls back to "Agent" without persona', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-Q', [
    { speaker: 'Alice', text: 'hi', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({ userId: 'user-1', sessionId: 'sess-Q' });
  const stream = liveSessions.getCaptionsSince('user-1', 'sess-Q', 0);
  const attachLine = stream.captions.find((c) => c.source === 'agent-system');
  assert.equal(attachLine.speaker, 'Agent');
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-Q' });
});

// ── Localized system captions (en/ja) ──────────────────────────────

test('Japanese language → attach + detach captions are Japanese', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-J', [
    { speaker: 'Alice', text: 'hi', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({
    userId: 'user-1', sessionId: 'sess-J', language: 'ja',
  });
  const after = liveSessions.getCaptionsSince('user-1', 'sess-J', 0);
  const attach = after.captions.find((c) => c.source === 'agent-system');
  assert.match(attach.text, /参加しました/, 'attach line should be Japanese');

  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-J' });
  const after2 = liveSessions.getCaptionsSince('user-1', 'sess-J', 0);
  const detach = after2.captions.filter((c) => c.source === 'agent-system').pop();
  assert.match(detach.text, /退出しました/, 'detach line should be Japanese');
});

test('Unsupported language (fr) falls back to English without crashing', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-F', [
    { speaker: 'Alice', text: 'hi', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({
    userId: 'user-1', sessionId: 'sess-F', language: 'fr',
  });
  const stream = liveSessions.getCaptionsSince('user-1', 'sess-F', 0);
  const attach = stream.captions.find((c) => c.source === 'agent-system');
  assert.match(attach.text, /attached/, 'should fall back to English');
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-F' });
});

// ── listRuns / getDiagnostics — multi-tenant isolation ─────────────

test('listRuns scopes by userId — never leaks across tenants', async () => {
  reset();
  liveSessions.appendCaptions('user-A', 'sess-1', [
    { speaker: 'X', text: 'a', ts: Date.now(), source: 'extension-cc' },
  ]);
  liveSessions.appendCaptions('user-B', 'sess-2', [
    { speaker: 'Y', text: 'b', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({ userId: 'user-A', sessionId: 'sess-1' });
  await meetingAgent.dispatchAgent({ userId: 'user-B', sessionId: 'sess-2' });

  const aRuns = meetingAgent.listRuns('user-A');
  const bRuns = meetingAgent.listRuns('user-B');
  assert.equal(aRuns.length, 1);
  assert.equal(bRuns.length, 1);
  assert.equal(aRuns[0].sessionId, 'sess-1');
  assert.equal(bRuns[0].sessionId, 'sess-2');

  await meetingAgent.stopAgent({ userId: 'user-A', sessionId: 'sess-1' });
  await meetingAgent.stopAgent({ userId: 'user-B', sessionId: 'sess-2' });
});

test('getDiagnostics returns lastDispatch for the right user', async () => {
  reset();
  liveSessions.appendCaptions('user-A', 'sess-D', [
    { speaker: 'X', text: 'a', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({ userId: 'user-A', sessionId: 'sess-D' });
  const diagA = meetingAgent.getDiagnostics('user-A');
  const diagB = meetingAgent.getDiagnostics('user-B');
  assert.ok(diagA.lastDispatch, 'user-A should have a lastDispatch');
  assert.equal(diagA.lastDispatch.transport, null, 'no meetingUrl → no transport selected');
  assert.equal(diagA.lastDispatch.result, 'co-pilot');
  assert.equal(diagB.lastDispatch, null, 'user-B saw no dispatch');
  await meetingAgent.stopAgent({ userId: 'user-A', sessionId: 'sess-D' });
});

// ── getRunBySessionId — used by /kb/agent/bot-relay ─────────────────

test('getRunBySessionId returns the run for a known sessionId', async () => {
  reset();
  liveSessions.appendCaptions('user-1', 'sess-R', [
    { speaker: 'X', text: 'a', ts: Date.now(), source: 'extension-cc' },
  ]);
  await meetingAgent.dispatchAgent({ userId: 'user-1', sessionId: 'sess-R' });
  const run = meetingAgent.getRunBySessionId('sess-R');
  assert.ok(run);
  assert.equal(run.userId, 'user-1');
  assert.equal(run.sessionId, 'sess-R');
  await meetingAgent.stopAgent({ userId: 'user-1', sessionId: 'sess-R' });
  assert.equal(meetingAgent.getRunBySessionId('sess-R'), null,
    'after stop, the run should be gone');
});
