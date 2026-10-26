// System view tests: `npm test`. The TypeScript sources load through Vite's SSR
// loader (the same pipeline as the build), so no extra test framework is needed.
// Timers are fake and fetch is mocked, so the suite never waits on the network.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.resolve(ROOT, '../../schema/http/fixtures/os');
const BASE = 'http://127.0.0.1:3456';
const TOKEN = 'test-token-123';

const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')).response;
const seeded = () => structuredClone(fixture('get-kb-os-state-200-seeded.json'));

let server;
let api;

before(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    plugins: [react()],
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const load = (p) => server.ssrLoadModule(p);
  api = {
    OsController: (await load('/src/controller.ts')).OsController,
    api: await load('/src/api.ts'),
    sse: await load('/src/sse.ts'),
    stream: await load('/src/stream.ts'),
    bridge: await load('/src/bridge.ts'),
    render: await load('/tests/support/render.tsx'),
  };
});

after(async () => {
  await server?.close();
});

/** Fake timers: nothing fires until a test calls runTimers(). */
function fakeTimers() {
  const pending = new Set();
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      pending.add(t);
      return t;
    },
    clearTimer: (t) => pending.delete(t),
    runTimers: (ms) => {
      for (const t of [...pending]) {
        if (ms === undefined || t.ms === ms) {
          pending.delete(t);
          t.fn();
        }
      }
    },
    count: () => pending.size,
  };
}

const sseBody = (...events) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const e of events) controller.enqueue(enc.encode(e));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

const HELLO = 'event: hello\ndata: {"type":"hello","at":"2026-10-26T13:56:08.000Z"}\n\n';

/**
 * Routes mock fetch calls by URL. `state` answers GET /kb/os/state; `stream`
 * answers GET /kb/os/stream; `cancel` answers the POST for a Stop.
 */
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const route = routes(url, init);
    if (route instanceof Response) return route;
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  };
  return { fetchImpl, calls };
}

function makeController({ mode = 'native', fetchImpl, timers, post = [] } = {}) {
  const t = timers ?? fakeTimers();
  const controller = new api.OsController({
    fetch: fetchImpl,
    post: (message) => {
      post.push(message);
      return mode === 'native';
    },
    mode,
    applyTheme: (theme) => {
      applied.push(theme);
    },
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  });
  return { controller, timers: t };
}
const applied = [];

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function standardRoutes(state = seeded()) {
  return (url) => {
    if (url.includes('/kb/os/state')) return { body: state };
    if (url.includes('/kb/os/stream')) return sseBody(HELLO);
    return { body: { ok: true } };
  };
}

describe('SSE parser', () => {
  it('dispatches events from a canned stream split at arbitrary points', () => {
    const got = [];
    const parser = api.sse.createSseParser((m) => got.push(m));
    const canned = [
      'event: hello\r\ndata: {"type":"hello"}\r\n\r\nevent: act',
      'ivity\ndata: {"type":"activity",',
      '"at":"x"}\n\n: heartbeat\n\n',
      'event: usage\ndata: {"type":"usage"}\n\ndata: multi\ndata: line\n\n',
      'unknown: field\n\n',
    ];
    for (const chunk of canned) parser.push(chunk);
    assert.deepEqual(got, [
      { event: 'hello', data: '{"type":"hello"}' },
      { event: 'activity', data: '{"type":"activity","at":"x"}' },
      { event: 'usage', data: '{"type":"usage"}' },
      { event: 'message', data: 'multi\nline' },
    ]);
  });

  it('does not dispatch a blank line with no data', () => {
    const got = [];
    const parser = api.sse.createSseParser((m) => got.push(m));
    parser.push('event: only-name\n\n\n');
    assert.deepEqual(got, []);
  });

  it('backs off 1 s to 30 s, and 60 s to 5 min after a 429', () => {
    assert.equal(api.stream.backoffDelay(0, false), 1000);
    assert.equal(api.stream.backoffDelay(3, false), 8000);
    assert.equal(api.stream.backoffDelay(20, false), 30000);
    assert.equal(api.stream.backoffDelay(0, true), 60000);
    assert.equal(api.stream.backoffDelay(9, true), 300000);
  });
});

describe('requests', () => {
  it('sends the token only in the Authorization header, never in the URL', async () => {
    const { fetchImpl, calls } = mockFetch(standardRoutes());
    const state = await api.api.fetchOsState({ baseURL: `${BASE}/`, token: TOKEN }, 'week', fetchImpl);
    assert.equal(state.apiVersion, 79);
    assert.equal(calls[0].url, `${BASE}/kb/os/state?window=week`);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!calls[0].url.includes(TOKEN));
  });

  it('refuses a cancel request that is not a POST to an absolute path', async () => {
    const { fetchImpl } = mockFetch(standardRoutes());
    await assert.rejects(
      api.api.sendCancel({ baseURL: BASE, token: TOKEN }, { method: 'GET', path: '/x' }, fetchImpl),
      /Unsupported cancel request/,
    );
  });
});

describe('controller', () => {
  it('posts needToken on a 401 once, then waits for the next configure', async () => {
    const post = [];
    let refusing = true;
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.includes('/kb/os/state')) return refusing ? { status: 401, body: {} } : { body: seeded() };
      if (url.includes('/kb/os/stream')) return refusing ? { status: 401, body: {} } : sseBody(HELLO);
      return { body: {} };
    });
    const { controller, timers } = makeController({ fetchImpl, post });
    controller.configure({ baseURL: BASE, token: 'stale' });
    await flush();

    const needToken = post.filter((m) => m.type === 'needToken');
    assert.equal(needToken.length, 1, 'exactly one needToken for the 401 burst');
    assert.equal(controller.getSnapshot().needToken, true);
    assert.equal(controller.getSnapshot().live, 'stopped');
    assert.equal(timers.count(), 0, 'no reconnect is scheduled after a 401');

    refusing = false;
    controller.configure({ baseURL: BASE, token: 'fresh', theme: 'light', projectName: 'Demo' });
    await flush();
    const snap = controller.getSnapshot();
    assert.equal(snap.needToken, false);
    assert.ok(snap.data, 'data loads after the new token');
    assert.equal(calls.at(-1).headers.Authorization, 'Bearer fresh');
    assert.deepEqual(applied.at(-1), 'light');
    controller.dispose();
  });

  it('sends a running item\'s declared cancel request exactly, then refreshes', async () => {
    const state = seeded();
    const cancel = state.running.chatTurns[0].cancel;
    const { fetchImpl, calls } = mockFetch((url, init) => {
      if (init.method === 'POST') return { body: { ok: true } };
      if (url.includes('/kb/os/stream')) return sseBody(HELLO);
      return { body: state };
    });
    const { controller, timers } = makeController({ fetchImpl });
    controller.configure({ baseURL: BASE, token: TOKEN });
    await flush();
    await controller.stopItem(cancel, 'chat-chat-1');
    await flush();

    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.url, `${BASE}/agent/v2/cancel`);
    assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(post.body), cancel.body);
    assert.equal(post.body, JSON.stringify(cancel.body));
    assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('/kb/os/state')), 'refreshes after the stop');
    assert.equal(controller.getSnapshot().stopping, null);
    timers.runTimers();
    controller.dispose();
  });

  it('re-fetches 300 ms after a stream event, debounced', async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.includes('/kb/os/stream')) {
        return sseBody(HELLO, 'event: activity\ndata: {"type":"activity","at":"t"}\n\n');
      }
      return { body: seeded() };
    });
    const { controller, timers } = makeController({ fetchImpl });
    controller.configure({ baseURL: BASE, token: TOKEN });
    await flush();
    const before = calls.filter((c) => c.url.includes('/kb/os/state')).length;
    timers.runTimers(300);
    await flush();
    const after = calls.filter((c) => c.url.includes('/kb/os/state')).length;
    assert.equal(after, before + 1, 'one debounced refresh');
    controller.dispose();
  });

  it('asks native to open a screen and says so outside the app', () => {
    const post = [];
    const { controller } = makeController({ mode: 'dev', fetchImpl: mockFetch(standardRoutes()).fetchImpl, post });
    controller.open('loop');
    assert.equal(controller.getSnapshot().notice, 'Open this in the LLM-IDE app.');
    const native = makeController({ post });
    native.controller.open('autoTasks');
    assert.deepEqual(post.at(-1), { type: 'open', target: 'autoTasks' });
  });
});

describe('rendering', () => {
  async function renderSeeded(state) {
    const { fetchImpl } = mockFetch(standardRoutes(state));
    const { controller } = makeController({ fetchImpl });
    controller.configure({ baseURL: BASE, token: TOKEN, projectName: 'Demo project' });
    await flush();
    return { html: api.render.renderApp(controller), controller };
  }

  it('renders every section with the seeded fixture', async () => {
    const { html, controller } = await renderSeeded(seeded());
    for (const heading of [
      'System map',
      'Running now',
      'Activity timeline',
      'Token flow',
      'Memory and knowledge',
      'On this Mac',
    ]) {
      assert.ok(html.includes(heading), `section "${heading}" is rendered`);
    }
    assert.ok(html.includes('Demo project'));
    assert.ok(html.includes('aria-label="Stop chat turn"'), 'chat turn has a Stop button');
    assert.ok(html.includes('aria-label="Stop meeting agent"'), 'meeting agent has a Stop button');
    assert.ok(html.includes('Stop it in the Mac app'), 'live capture has no Stop (cancel is null)');
    assert.ok(html.includes('Open Loop') && html.includes('Open Auto Tasks'));
    assert.ok(html.includes('aria-pressed="true"'), 'the day toggle is pressed');
    controller.dispose();
  });

  it('shows the empty states on a fresh install', async () => {
    const empty = seeded();
    empty.running = { chatTurns: [], meetingAgentRuns: [], liveSessions: [] };
    empty.activity = { unread: 0, items: [] };
    empty.tokens.totals = { calls: 0, runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billable: 0 };
    empty.tokens.byModel = [];
    empty.tokens.bySource = [];
    empty.tokens.byEndpoint = [];
    empty.tokens.turnComposition = { turns: 0, avgFirstCallPromptTokens: null, avgPrefixTokens: null, avgFenceTokens: null, avgToolResultTokens: null };
    empty.knowledge = {
      sources: { total: 0, byKind: [] },
      meetings: { count: 0 },
      pendingReviews: 0,
      outcomes: { total: 0, terminal: 0, byState: {} },
      codeGraph: [],
      projectMemory: [],
    };
    const { html, controller } = await renderSeeded(empty);
    assert.ok(html.includes('Nothing is running'));
    assert.ok(html.includes('No activity yet'));
    assert.ok(html.includes('No model calls in this window'));
    assert.ok(html.includes('Nothing indexed yet'));
    assert.ok(html.includes('Open Library'));
    controller.dispose();
  });

  it('shows the connect form outside the Mac app', () => {
    const { controller } = makeController({ mode: 'dev', fetchImpl: mockFetch(standardRoutes()).fetchImpl });
    const html = api.render.renderApp(controller);
    assert.ok(html.includes('Connect to a local server'));
    assert.ok(html.includes('type="password"'), 'the token field is masked');
    controller.dispose();
  });
});

describe('styles', () => {
  it('uses only --tok-* colours (no literal colours in styles.css)', () => {
    const css = readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
    const literal = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    assert.deepEqual(literal, []);
  });

  it('keeps the generated tokens in step with the source of truth', () => {
    const generated = readFileSync(path.join(ROOT, 'src/tokens.generated.css'), 'utf8');
    assert.ok(generated.includes('--tok-color-accent:'));
    assert.ok(generated.includes(':root[data-theme="light"]'));
  });
});
