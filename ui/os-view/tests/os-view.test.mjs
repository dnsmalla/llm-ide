// System view (host) tests: `npm test`. The TypeScript sources load through Vite's SSR
// loader with the same config as the build (alias to graph-kit, dedupe), so the page
// the host mounts is graph-kit's real code. Timers are fake and fetch is mocked; the
// suite never waits on the network.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.resolve(ROOT, '../../schema/http/fixtures/os');
const GRAPH_KIT_INDEX = path.resolve(ROOT, '../../mac/LocalPackages/graph-kit/web/src/index.ts');
const BUNDLE = path.resolve(ROOT, '../../mac/Sources/LlmIdeMac/Resources/os-view');
const BASE = 'http://127.0.0.1:3456';
const TOKEN = 'test-token-123';

const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')).response;
const seeded = () => structuredClone(fixture('get-kb-os-state-200-seeded.json'));

let server;
let api;

before(async () => {
  // The real vite config: the graph-kit alias and dedupe come from it, as in the build.
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const load = (p) => server.ssrLoadModule(p);
  api = {
    api: await load('/src/api.ts'),
    sse: await load('/src/sse.ts'),
    stream: await load('/src/stream.ts'),
    bridge: await load('/src/bridge.ts'),
    hosts: await load('/src/hosts.ts'),
    boot: await load('/src/boot.ts'),
    devConnect: await load('/src/components/DevConnect.tsx'),
    render: await load('/tests/support/render.tsx'),
    graphKit: await load('@dnsmalla/graph-kit-web'),
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
    pendingMs: () => [...pending].map((t) => t.ms),
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
const CHANGE = 'event: change\ndata: {"type":"chat_turn","at":"2026-10-26T13:57:00.000Z"}\n\n';

/**
 * Routes mock fetch calls by URL. `state` answers GET /kb/os/state; `stream`
 * answers GET /kb/os/stream; anything else is answered with an ok body.
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

function standardRoutes(state = seeded()) {
  return (url) => {
    if (url.includes('/kb/os/state')) return { body: state };
    if (url.includes('/kb/os/stream')) return sseBody(HELLO);
    return { body: { ok: true } };
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A simulated Mac app bridge. `answer(message)` plays native; undefined = never answer. */
function nativeBridge(answer = () => undefined) {
  const sent = [];
  const timers = fakeTimers();
  let requests;
  const post = (message) => {
    sent.push(message);
    if (message.type === 'request') {
      const reply = answer(message);
      if (reply !== undefined) queueMicrotask(() => requests.settle(message.id, reply));
    }
    return true;
  };
  requests = new api.bridge.NativeRequests(post, timers.setTimer, timers.clearTimer);
  return { sent, timers, requests, post };
}

/** Answers the native requests the way the Mac app does for the allowlisted calls. */
function nativeAnswers(state, { stateStatus = 200, cancelStatus = 200 } = {}) {
  return (message) => {
    if (message.path.startsWith('/kb/os/state')) return { status: stateStatus, body: state };
    if (message.method === 'POST') return { status: cancelStatus, body: { ok: true } };
    return { status: 400, error: 'not_allowed' };
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

describe('bridge request/response', () => {
  it('posts one request with an id and settles it from the reply', async () => {
    const sent = [];
    const timers = fakeTimers();
    const requests = new api.bridge.NativeRequests(
      (m) => (sent.push(m), true),
      timers.setTimer,
      timers.clearTimer,
    );
    const p = requests.call('GET', '/kb/os/state?window=day');
    assert.deepEqual(sent, [
      { type: 'request', id: sent[0].id, method: 'GET', path: '/kb/os/state?window=day' },
    ]);
    assert.equal(typeof sent[0].id, 'string');
    assert.equal(requests.size, 1);
    requests.settle(sent[0].id, { status: 200, body: { ok: 1 } });
    assert.deepEqual(await p, { status: 200, body: { ok: 1 }, error: undefined });
    assert.equal(requests.size, 0);
    assert.equal(timers.count(), 0, 'the timeout is cleared on reply');
  });

  it('sends a body only when the call has one', () => {
    const sent = [];
    const timers = fakeTimers();
    const requests = new api.bridge.NativeRequests((m) => (sent.push(m), true), timers.setTimer, timers.clearTimer);
    requests.call('POST', '/kb/agent/stop', { sessionId: 's1' });
    assert.deepEqual(sent[0].body, { sessionId: 's1' });
    assert.equal(sent[0].method, 'POST');
  });

  it('fails a request native never answers after 15 s', async () => {
    const timers = fakeTimers();
    const requests = new api.bridge.NativeRequests(() => true, timers.setTimer, timers.clearTimer);
    const p = requests.call('GET', '/kb/os/state?window=day');
    assert.deepEqual(timers.pendingMs(), [api.bridge.NATIVE_REQUEST_TIMEOUT_MS]);
    assert.equal(api.bridge.NATIVE_REQUEST_TIMEOUT_MS, 15_000);
    timers.runTimers(15_000);
    await assert.rejects(p, /did not answer in time/);
    assert.equal(requests.size, 0);
  });

  it('drops a late reply that arrives after the timeout', async () => {
    const sent = [];
    const timers = fakeTimers();
    const requests = new api.bridge.NativeRequests((m) => (sent.push(m), true), timers.setTimer, timers.clearTimer);
    const p = requests.call('GET', '/kb/os/state?window=day');
    timers.runTimers(15_000);
    await assert.rejects(p);
    requests.settle(sent[0].id, { status: 200, body: {} });
    assert.equal(requests.size, 0, 'no pending entry is revived');
  });

  it('rejects at once when there is no bridge', async () => {
    const timers = fakeTimers();
    const requests = new api.bridge.NativeRequests(() => false, timers.setTimer, timers.clearTimer);
    await assert.rejects(requests.call('GET', '/kb/os/state?window=day'), /bridge is not available/);
    assert.equal(timers.count(), 0);
  });

  it('ignores replies for unknown ids and normalises odd reply shapes', async () => {
    const sent = [];
    const timers = fakeTimers();
    const requests = new api.bridge.NativeRequests((m) => (sent.push(m), true), timers.setTimer, timers.clearTimer);
    requests.settle('nope', { status: 200 });
    requests.settle(42, { status: 200 });
    const p = requests.call('POST', '/agent/v2/cancel', { chatSessionId: 'c1' });
    requests.settle(sent[0].id, null);
    assert.deepEqual(await p, { status: 0, body: undefined, error: undefined });
  });

  it('dev requester sends the token in the header and reports a network failure as status 0', async () => {
    const { fetchImpl, calls } = mockFetch(standardRoutes());
    const req = api.api.directRequester({ baseURL: `${BASE}/`, token: TOKEN }, fetchImpl);
    const reply = await req('GET', '/kb/os/state?window=week');
    assert.equal(reply.status, 200);
    assert.equal(calls[0].url, `${BASE}/kb/os/state?window=week`);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!calls[0].url.includes(TOKEN));

    const down = api.api.directRequester({ baseURL: BASE, token: TOKEN }, async () => {
      throw new TypeError('fetch failed');
    });
    assert.deepEqual(await down('GET', '/kb/os/state?window=day'), { status: 0, error: 'fetch failed' });
  });
});

describe('dev requests', () => {
  it('sends the token only in the Authorization header, never in the URL', async () => {
    const { fetchImpl, calls } = mockFetch(standardRoutes());
    const req = api.api.directRequester({ baseURL: `${BASE}/`, token: TOKEN }, fetchImpl);
    const state = await api.api.fetchOsState(req, 'week');
    assert.equal(state.apiVersion, 79);
    assert.equal(calls[0].url, `${BASE}/kb/os/state?window=week`);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!calls[0].url.includes(TOKEN));
  });

  it('refuses a cancel request that is not a POST to an absolute path', async () => {
    const { fetchImpl } = mockFetch(standardRoutes());
    const req = api.api.directRequester({ baseURL: BASE, token: TOKEN }, fetchImpl);
    await assert.rejects(
      api.api.sendCancel(req, { method: 'GET', path: '/x' }),
      /Unsupported cancel request/,
    );
  });
});


describe('native host', () => {
  it('loadState goes through the bridge as one GET with no body, and returns the snapshot', async () => {
    const state = seeded();
    const bridge = nativeBridge(nativeAnswers(state));
    const host = api.hosts.createNativeHost({ requests: bridge.requests, post: bridge.post });
    const snap = await host.loadState('week');
    assert.deepEqual(bridge.sent[0], { type: 'request', id: bridge.sent[0].id, method: 'GET', path: '/kb/os/state?window=week' });
    assert.ok(!('body' in bridge.sent[0]));
    assert.equal(snap.apiVersion, state.apiVersion);
  });

  it('a 401 from native becomes graph-kit OsAuthError; other failures pass through', async () => {
    const refused = nativeBridge(() => ({ status: 401 }));
    const host = api.hosts.createNativeHost({ requests: refused.requests, post: refused.post });
    await assert.rejects(host.loadState('day'), api.graphKit.OsAuthError);

    const broken = nativeBridge(() => ({ status: 500 }));
    const host2 = api.hosts.createNativeHost({ requests: broken.requests, post: broken.post });
    await assert.rejects(host2.loadState('day'), (err) => !(err instanceof api.graphKit.OsAuthError) && /\(500\)/.test(err.message));
  });

  it('cancel posts the declared request exactly (method, path, body) and maps 401 the same way', async () => {
    const bridge = nativeBridge(nativeAnswers(seeded()));
    const host = api.hosts.createNativeHost({ requests: bridge.requests, post: bridge.post });
    await host.cancel({ method: 'POST', path: '/kb/agent/stop', body: { sessionId: 's1' } });
    assert.deepEqual(bridge.sent[0], {
      type: 'request',
      id: bridge.sent[0].id,
      method: 'POST',
      path: '/kb/agent/stop',
      body: { sessionId: 's1' },
    });

    const refused = nativeBridge(() => ({ status: 401 }));
    const host2 = api.hosts.createNativeHost({ requests: refused.requests, post: refused.post });
    await assert.rejects(
      host2.cancel({ method: 'POST', path: '/kb/agent/stop', body: { sessionId: 's1' } }),
      api.graphKit.OsAuthError,
    );
  });

  it('cancel refuses a request that is not a POST to an absolute path', async () => {
    const bridge = nativeBridge(nativeAnswers(seeded()));
    const host = api.hosts.createNativeHost({ requests: bridge.requests, post: bridge.post });
    await assert.rejects(host.cancel({ method: 'GET', path: '/x' }), /Unsupported cancel request/);
    assert.equal(bridge.sent.length, 0, 'nothing is sent for a refused cancel');
  });

  it('watch posts subscribe, forwards events (hello ignored) and status, and unwatch posts unsubscribe once', () => {
    const bridge = nativeBridge();
    const host = api.hosts.createNativeHost({ requests: bridge.requests, post: bridge.post });
    const changes = [];
    const statuses = [];
    const unwatch = host.watch(
      () => changes.push('change'),
      (status, detail) => statuses.push([status, detail ?? null]),
    );
    assert.deepEqual(bridge.sent, [{ type: 'subscribe' }]);

    host.nativeEvent({ type: 'hello', at: null });
    assert.deepEqual(changes, [], 'hello is ignored');
    host.nativeEvent({ type: 'chat_turn', at: '2026-10-27T00:00:00Z' });
    assert.deepEqual(changes, ['change']);

    host.nativeStatus('live');
    host.nativeStatus('reconnecting', 'Too many System views are open; retrying later');
    assert.deepEqual(statuses, [
      ['live', null],
      ['reconnecting', 'Too many System views are open; retrying later'],
    ]);

    unwatch();
    unwatch();
    assert.deepEqual(bridge.sent.slice(1), [{ type: 'unsubscribe' }], 'unsubscribe is sent once');
    host.nativeEvent({ type: 'chat_turn' });
    host.nativeStatus('live');
    assert.deepEqual(changes, ['change'], 'nothing is forwarded after unwatch');
    assert.equal(statuses.length, 2);
  });

  it('nativeEvent and nativeStatus with no watch attached do nothing', () => {
    const bridge = nativeBridge();
    const host = api.hosts.createNativeHost({ requests: bridge.requests, post: bridge.post });
    assert.doesNotThrow(() => {
      host.nativeEvent({ type: 'chat_turn' });
      host.nativeStatus('live');
    });
  });

  it('open posts the target and returns native\'s boolean', () => {
    const bridge = nativeBridge();
    const host = api.hosts.createNativeHost({ requests: bridge.requests, post: bridge.post });
    assert.equal(host.open('loop'), true);
    assert.deepEqual(bridge.sent[0], { type: 'open', target: 'loop' });

    const nowhere = api.hosts.createNativeHost({ requests: bridge.requests, post: () => false });
    assert.equal(nowhere.open('settings'), false, 'no bridge means nowhere to go');
  });
});

describe('dev host', () => {
  const conn = { baseURL: BASE, token: TOKEN };

  it('loadState fetches the server with the token in the header, and a 401 becomes OsAuthError', async () => {
    const ok = mockFetch(standardRoutes());
    const host = api.hosts.createDevHost({ conn, fetch: ok.fetchImpl, setTimer: () => null, clearTimer: () => {} });
    const snap = await host.loadState('week');
    assert.equal(snap.apiVersion, 79);
    assert.equal(ok.calls[0].url, `${BASE}/kb/os/state?window=week`);
    assert.equal(ok.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!ok.calls[0].url.includes(TOKEN));

    const refused = mockFetch(() => ({ status: 401, body: {} }));
    const host2 = api.hosts.createDevHost({ conn, fetch: refused.fetchImpl, setTimer: () => null, clearTimer: () => {} });
    await assert.rejects(host2.loadState('day'), api.graphKit.OsAuthError);
  });

  it('cancel sends the declared POST with its body; a 401 becomes OsAuthError', async () => {
    const m = mockFetch(standardRoutes());
    const host = api.hosts.createDevHost({ conn, fetch: m.fetchImpl, setTimer: () => null, clearTimer: () => {} });
    await host.cancel({ method: 'POST', path: '/kb/agent/stop', body: { sessionId: 's1' } });
    assert.equal(m.calls[0].method, 'POST');
    assert.equal(m.calls[0].url, `${BASE}/kb/agent/stop`);
    assert.equal(m.calls[0].body, JSON.stringify({ sessionId: 's1' }));

    const refused = mockFetch(() => ({ status: 401, body: {} }));
    const host2 = api.hosts.createDevHost({ conn, fetch: refused.fetchImpl, setTimer: () => null, clearTimer: () => {} });
    await assert.rejects(host2.cancel({ method: 'POST', path: '/kb/agent/stop' }), api.graphKit.OsAuthError);
  });

  it('open returns false: a browser has nowhere to navigate', () => {
    const host = api.hosts.createDevHost({ conn, fetch: mockFetch(standardRoutes()).fetchImpl, setTimer: () => null, clearTimer: () => {} });
    assert.equal(host.open('library'), false);
  });

  it('watch streams the feed: hello is ignored, a change is forwarded, unwatch stops the stream', async () => {
    const timers = fakeTimers();
    const m = mockFetch((url) => (url.includes('/kb/os/stream') ? sseBody(HELLO, CHANGE) : { body: {} }));
    const host = api.hosts.createDevHost({ conn, fetch: m.fetchImpl, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const changes = [];
    const statuses = [];
    const unwatch = host.watch(() => changes.push(1), (s) => statuses.push(s));
    await flush();
    assert.deepEqual(changes, [1], 'the hello event does not count, the change does');
    assert.ok(statuses.includes('connecting') && statuses.includes('live'));
    const streams = m.calls.filter((c) => c.url.endsWith('/kb/os/stream')).length;
    unwatch();
    timers.runTimers();
    await flush();
    assert.equal(m.calls.filter((c) => c.url.endsWith('/kb/os/stream')).length, streams, 'no reconnect after unwatch');
  });

  it('a stream 401 reports stopped and asks graph-kit to re-fetch, which then shows the signed-out state', async () => {
    const timers = fakeTimers();
    const m = mockFetch((url) => (url.includes('/kb/os/stream') ? new Response('', { status: 401 }) : { status: 401, body: {} }));
    const host = api.hosts.createDevHost({ conn, fetch: m.fetchImpl, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const changes = [];
    const statuses = [];
    host.watch(() => changes.push(1), (s) => statuses.push(s));
    await flush();
    assert.ok(statuses.includes('stopped'));
    assert.deepEqual(changes, [1]);
    assert.equal(timers.count(), 0, 'a refused stream does not reconnect');
  });
});

describe('native boot', () => {
  /** Boots against a fake page: records the order of ready and what the mount receives. */
  function boot() {
    const scope = {};
    const root = { textContent: '' };
    const sent = [];
    const mounts = [];
    const handles = [];
    let installedAtReady = null;
    const timers = fakeTimers();
    const post = (message) => {
      sent.push(message);
      if (message.type === 'ready') installedAtReady = typeof scope.llmideConfigure === 'function';
      return true;
    };
    const mount = (_root, host, opts) => {
      mounts.push({ host, opts });
      const handle = {
        configured: [],
        configure(cfg) {
          this.configured.push(cfg);
        },
      };
      handles.push(handle);
      return handle;
    };
    const requests = new api.bridge.NativeRequests(post, timers.setTimer, timers.clearTimer);
    const host = api.boot.bootNative(scope, { root, post, mount, requests });
    return { scope, root, sent, mounts, handles, host, installedAtReady: () => installedAtReady };
  }

  it('installs every llmide* function before "ready" is posted', () => {
    const b = boot();
    assert.equal(b.installedAtReady(), true);
    for (const name of ['llmideConfigure', 'llmideResponse', 'llmideEvent', 'llmideStatus']) {
      assert.equal(typeof b.scope[name], 'function', name);
    }
    assert.deepEqual(b.sent, [{ type: 'ready' }]);
  });

  it('shows the waiting text until the first configure, which mounts once with the native notices', () => {
    const b = boot();
    assert.equal(b.root.textContent, api.boot.WAITING_TEXT);
    b.scope.llmideConfigure(null);
    assert.equal(b.mounts.length, 0, 'an unusable configure is ignored');
    b.scope.llmideConfigure({ theme: 'light', projectName: 'Alpha' });
    assert.equal(b.mounts.length, 1);
    assert.equal(b.mounts[0].opts.theme, 'light');
    assert.equal(b.mounts[0].opts.projectName, 'Alpha');
    assert.equal(b.mounts[0].opts.signedOutNotice, 'Your LLM-IDE session has ended. Sign in to LLM-IDE again.');
    assert.equal(b.mounts[0].opts.openFallbackNotice, 'Open this in the LLM-IDE app.');
    b.scope.llmideConfigure({ theme: 'midnight', projectName: 'Beta' });
    assert.equal(b.mounts.length, 1, 'later configures do not mount again');
    assert.deepEqual(b.handles[0].configured, [{ theme: 'midnight', projectName: 'Beta' }]);
  });

  it('the mounted host subscribes, and llmideEvent / llmideStatus reach its watch callbacks', () => {
    const b = boot();
    b.scope.llmideConfigure({ theme: 'dark', projectName: 'Alpha' });
    const changes = [];
    const statuses = [];
    b.mounts[0].host.watch(() => changes.push(1), (s) => statuses.push(s));
    assert.deepEqual(b.sent.at(-1), { type: 'subscribe' });
    b.scope.llmideEvent({ type: 'hello' });
    b.scope.llmideEvent({ type: 'chat_turn' });
    b.scope.llmideStatus({ status: 'live' });
    b.scope.llmideStatus(null);
    assert.deepEqual(changes, [1]);
    assert.deepEqual(statuses, ['live']);
    assert.doesNotThrow(() => b.scope.llmideResponse('unknown-id', { status: 200 }));
  });
});

describe('dev connect form', () => {
  it('refuses a missing server address or token, and accepts a complete one', () => {
    assert.match(api.devConnect.devConnectionError({ baseURL: '', token: 'x' }), /missing the server address or the token/);
    assert.match(api.devConnect.devConnectionError({ baseURL: BASE, token: '' }), /missing the server address or the token/);
    assert.equal(api.devConnect.devConnectionError({ baseURL: BASE, token: TOKEN }), null);
  });

  it('renders the connect form with a masked token field', () => {
    const html = api.render.renderDevConnect();
    assert.ok(html.includes('Connect to a local server'));
    assert.ok(html.includes('type="password"'), 'the token field is masked');
  });
});

describe('wiring', () => {
  it('the moved files are gone from ui/os-view: the page lives in graph-kit', () => {
    for (const gone of ['controller.ts', 'App.tsx', 'format.ts', 'styles.css']) {
      assert.equal(existsSync(path.join(ROOT, 'src', gone)), false, `src/${gone} was removed`);
    }
    assert.deepEqual(readdirSync(path.join(ROOT, 'src/components')), ['DevConnect.tsx']);
  });

  it('vite aliases @dnsmalla/graph-kit-web to the submodule and dedupes react, react-dom and three', () => {
    const alias = server.config.resolve.alias.find((a) => a.find === '@dnsmalla/graph-kit-web');
    assert.ok(alias, 'the graph-kit alias is set');
    assert.equal(alias.replacement, GRAPH_KIT_INDEX);
    assert.ok(existsSync(GRAPH_KIT_INDEX), 'the aliased page source exists');
    assert.deepEqual(
      [...server.config.resolve.dedupe].sort(),
      ['react', 'react-dom', 'three'],
    );
  });

  it('the committed bundle is the host plus graph-kit, behind the file:// entry point', () => {
    const html = readFileSync(path.join(BUNDLE, 'index.html'), 'utf8');
    assert.ok(html.includes('<script defer src="./assets/index.js">'), 'classic deferred script, no module');
    const js = readFileSync(path.join(BUNDLE, 'assets/index.js'), 'utf8');
    assert.ok(js.includes('Your LLM-IDE session has ended'), 'the host notice is bundled');
    assert.ok(js.includes('OsAuthError'), 'graph-kit page code is bundled');
  });
});

describe('styles', () => {
  it('uses only --tok-* colours in the dev form (no literal colours in dev.css)', () => {
    const css = readFileSync(path.join(ROOT, 'src/dev.css'), 'utf8');
    const literal = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
    assert.deepEqual(literal, []);
  });

  it('keeps the generated tokens in step with the source of truth', () => {
    const generated = readFileSync(path.join(ROOT, 'src/tokens.generated.css'), 'utf8');
    assert.ok(generated.includes('--tok-color-accent:'));
    assert.ok(generated.includes(':root[data-theme="light"]'));
  });
});
