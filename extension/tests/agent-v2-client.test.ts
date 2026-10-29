// The side-panel chat as a live v2 client (agent-kit K1 P4). Behavioural, with a
// fake fetch: no server, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildTurnMessage,
  dropV2Session,
  readSseEvents,
  runV2Turn,
  streamV2Turn,
  V2TurnError,
  type FetchFn,
} from '../src/lib/agent-v2-client.ts';

const enc = new TextEncoder();

function sse(events: unknown[], { splitAt = 0, end = true }: { splitAt?: number; end?: boolean } = {}): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = enc.encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      if (splitAt > 0) {
        c.enqueue(bytes.slice(0, splitAt));
        c.enqueue(bytes.slice(splitAt));
      } else c.enqueue(bytes);
      if (end) c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const req = { message: 'who owns the release?', chatSessionId: 'chat-1', language: 'en' };
const happy = [
  { type: 'init', sessionId: 'sdk-1' },
  { type: 'mode_set', mode: 'ask' },
  { type: 'delta', text: 'Alice ' },
  { type: 'notice', kind: 'x', level: 'info', text: 'ignored' },
  { type: 'future_event_type', anything: true },
  { type: 'delta', text: 'owns it.' },
  { type: 'result', subtype: 'success' },
];

test('streams deltas, ignores unknown events, returns the text and the SDK session id', async () => {
  let call: { url: string; init?: RequestInit } | null = null;
  const fetchFn: FetchFn = async (url, init) => {
    call = { url, init };
    return sse(happy);
  };
  const pieces: string[] = [];
  let accepted = 0;
  const out = await runV2Turn({ fetchFn, serverUrl: 'http://x', request: req, onDelta: (t) => pieces.push(t), onAccepted: () => accepted++ });
  assert.equal(out.text, 'Alice owns it.');
  assert.equal(out.sdkSessionId, 'sdk-1');
  assert.deepEqual(pieces, ['Alice ', 'owns it.']);
  assert.equal(accepted, 1);
  assert.equal(call!.url, 'http://x/agent/v2/stream');
  const body = JSON.parse(String(call!.init!.body));
  assert.equal(body.mode, 'ask', 'read-only chat');
  assert.equal(body.message, req.message);
  assert.deepEqual(body.agentContext, { chatSessionId: 'chat-1', surface: 'extension' });
  assert.equal(body.agentContext.workspaceRoot, undefined, 'the extension names no filesystem path');
  assert.equal(body.fresh, undefined);
});

test('an SSE frame split across chunks still parses', async () => {
  const out = await runV2Turn({ fetchFn: async () => sse(happy, { splitAt: 37 }), serverUrl: 'http://x', request: req });
  assert.equal(out.text, 'Alice owns it.');
});

test('readSseEvents skips garbage frames and handles CRLF', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"type":"delta","text":"a"}\r\n\r\ndata: not-json\n\n: comment\n\ndata: {"type":"result"}\n\n'));
      c.close();
    },
  });
  const seen: unknown[] = [];
  for await (const e of readSseEvents(stream)) seen.push(e);
  assert.deepEqual(seen, [{ type: 'delta', text: 'a' }, { type: 'result' }]);
});

test('SESSION_UNRESUMABLE retries once on a fresh session with the earlier turns', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn: FetchFn = async (_u, init) => {
    bodies.push(JSON.parse(String(init!.body)));
    return bodies.length === 1
      ? sse([{ type: 'error', code: 'SESSION_UNRESUMABLE', message: 'gone', retryable: true }])
      : sse(happy);
  };
  const history = [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: 'hello' }];
  const out = await runV2Turn({ fetchFn, serverUrl: 'http://x', request: { ...req, history } });
  assert.equal(out.text, 'Alice owns it.');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].fresh, undefined);
  assert.equal(bodies[1].fresh, true);
  assert.deepEqual(bodies[1].history, history);
});

test('a second SESSION_UNRESUMABLE is not retried again', async () => {
  let n = 0;
  const fetchFn: FetchFn = async () => {
    n++;
    return sse([{ type: 'error', code: 'SESSION_UNRESUMABLE', message: 'gone', retryable: true }]);
  };
  await assert.rejects(runV2Turn({ fetchFn, serverUrl: 'http://x', request: req }), (e: V2TurnError) => e.code === 'SESSION_UNRESUMABLE');
  assert.equal(n, 2);
});

test('a second side panel: 409 TURN_IN_PROGRESS is a clear message and nothing was accepted', async () => {
  let accepted = 0;
  const fetchFn: FetchFn = async () => json(409, { error: { code: 'TURN_IN_PROGRESS', message: 'A turn is already in progress' } });
  await assert.rejects(
    streamV2Turn({ fetchFn, serverUrl: 'http://x', request: req, onAccepted: () => accepted++ }),
    (e: V2TurnError) => e.code === 'TURN_IN_PROGRESS' && e.status === 409 && /still answering/.test(e.message),
  );
  assert.equal(accepted, 0, 'a refused turn stores nothing');
});

test('auth expired (401 after the refresh) and a stopped server (503) surface the server message', async () => {
  await assert.rejects(
    streamV2Turn({ fetchFn: async () => json(401, { error: { code: 'AUTH_REQUIRED', message: 'Missing access token' } }), serverUrl: 'http://x', request: req }),
    (e: V2TurnError) => e.code === 'AUTH_REQUIRED' && e.status === 401,
  );
  await assert.rejects(
    streamV2Turn({ fetchFn: async () => json(503, { error: { code: 'SDK_UPDATING', message: 'updating' } }), serverUrl: 'http://x', request: req }),
    (e: V2TurnError) => e.code === 'SDK_UPDATING',
  );
  // authFetch's own breaker answer uses the older string error form.
  await assert.rejects(
    streamV2Turn({ fetchFn: async () => json(503, { error: 'Server is temporarily unreachable.' }), serverUrl: 'http://x', request: req }),
    (e: V2TurnError) => e.message === 'Server is temporarily unreachable.',
  );
});

test('server down before any answer: the fetch rejection passes through (the hook shows offline)', async () => {
  await assert.rejects(
    streamV2Turn({ fetchFn: async () => { throw new TypeError('Failed to fetch'); }, serverUrl: 'http://x', request: req }),
    TypeError,
  );
});

test('connection lost mid-answer keeps the partial text on the error', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"type":"delta","text":"par"}\n\n'));
    },
    pull() {
      throw new TypeError('network error');
    },
  });
  const fetchFn: FetchFn = async () => new Response(stream, { status: 200 });
  await assert.rejects(
    streamV2Turn({ fetchFn, serverUrl: 'http://x', request: req }),
    (e: V2TurnError) => e.code === 'CONNECTION_LOST' && e.partialText === 'par',
  );
});

test('a stream that closes with no result is an error, with the partial text', async () => {
  const fetchFn: FetchFn = async () => sse([{ type: 'init', sessionId: 's' }, { type: 'delta', text: 'half' }]);
  await assert.rejects(
    streamV2Turn({ fetchFn, serverUrl: 'http://x', request: req }),
    (e: V2TurnError) => e.code === 'STREAM_ENDED' && e.partialText === 'half',
  );
});

test('a failed result subtype and an engine error are failures', async () => {
  await assert.rejects(
    streamV2Turn({ fetchFn: async () => sse([{ type: 'delta', text: 'x' }, { type: 'result', subtype: 'error_max_turns' }]), serverUrl: 'http://x', request: req }),
    (e: V2TurnError) => e.code === 'error_max_turns' && e.partialText === 'x',
  );
  await assert.rejects(
    streamV2Turn({ fetchFn: async () => sse([{ type: 'error', code: 'PROVIDER_UNAVAILABLE', message: 'no key', retryable: false }]), serverUrl: 'http://x', request: req }),
    (e: V2TurnError) => e.code === 'PROVIDER_UNAVAILABLE' && e.message === 'no key',
  );
});

test('an approval request is declined at once with the SDK session id', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    if (url.endsWith('/agent/v2/decision')) {
      calls.push({ url, body: JSON.parse(String(init!.body)) });
      return json(200, { ok: true });
    }
    return sse([
      { type: 'init', sessionId: 'sdk-9' },
      { type: 'approval_request', requestId: 'r1', kind: 'tool', toolName: 'Bash', argsSummary: null },
      { type: 'delta', text: 'ok' },
      { type: 'result', subtype: 'success' },
    ]);
  };
  const out = await streamV2Turn({ fetchFn, serverUrl: 'http://x', request: req });
  assert.equal(out.text, 'ok');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls[0].body, { requestId: 'r1', sdkSessionId: 'sdk-9', action: 'deny' });
});

test('stopping (abort) mid-answer rejects with the abort, not a V2TurnError', async () => {
  const ac = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"type":"delta","text":"a"}\n\n'));
    },
    pull() {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    },
  });
  await assert.rejects(
    streamV2Turn({ fetchFn: async () => new Response(stream, { status: 200 }), serverUrl: 'http://x', request: req, signal: ac.signal }),
    (e: unknown) => e instanceof DOMException && e.name === 'AbortError',
  );
});

test('dropV2Session never throws', async () => {
  await dropV2Session(async () => { throw new TypeError('down'); }, 'http://x', 'c');
  let body = '';
  await dropV2Session(async (_u, init) => { body = String(init!.body); return json(200, { ok: true }); }, 'http://x', 'c1');
  assert.deepEqual(JSON.parse(body), { chatSessionId: 'c1' });
});

test('buildTurnMessage: transcript once, then only the new lines; a rewritten one is replaced', () => {
  const first = buildTurnMessage({ message: 'Q1', transcript: 'A: hi', sentTranscript: '' });
  assert.match(first.text, /Meeting transcript so far/);
  assert.match(first.text, /<<<BEGIN>>>\nA: hi\n<<<END>>>/);
  assert.ok(first.text.endsWith('Q1'));
  assert.equal(first.sentTranscript, 'A: hi');

  const same = buildTurnMessage({ message: 'Q2', transcript: 'A: hi', sentTranscript: first.sentTranscript });
  assert.equal(same.text, 'Q2', 'unchanged transcript is not resent');

  const grown = buildTurnMessage({ message: 'Q3', transcript: 'A: hi\nB: yes', sentTranscript: 'A: hi' });
  assert.match(grown.text, /New transcript lines/);
  assert.match(grown.text, /<<<BEGIN>>>\nB: yes\n<<<END>>>/);
  assert.ok(!grown.text.includes('A: hi'));

  const rewritten = buildTurnMessage({ message: 'Q4', transcript: 'Z: new meeting', sentTranscript: 'A: hi' });
  assert.match(rewritten.text, /replaces the earlier one/);
  assert.match(rewritten.text, /Z: new meeting/);

  const none = buildTurnMessage({ message: 'Q5', transcript: '   ', sentTranscript: '', extra: '\n\nissues' });
  assert.equal(none.text, 'Q5\n\nissues');
});

test('App.tsx: /chat and /kb/chat/sessions are no longer required; the v2 stream is; MIN is the removing version', () => {
  const src = fs.readFileSync(new URL('../src/sidepanel/App.tsx', import.meta.url), 'utf8');
  const block = src.match(/const REQUIRED_ENDPOINTS = \[([\s\S]*?)\];/)![1];
  const paths = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(!paths.includes('/chat'));
  assert.ok(!paths.includes('/kb/chat/sessions'));
  assert.ok(paths.includes('/agent/v2/stream'));
  const min = Number(src.match(/const MIN_SERVER_API_VERSION = (\d+);/)![1]);
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const version = Number(server.match(/const SERVER_API_VERSION = (\d+);/)![1]);
  assert.ok(min >= 89 && min <= version, `MIN ${min} must be >= 89 (the 410) and <= server ${version}`);
});
