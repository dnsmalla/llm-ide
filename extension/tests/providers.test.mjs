// Multi-provider routing + HTTP adapters. Pins which model id maps to
// which provider, that the OpenAI/Google adapters read the right response
// shape, that transient statuses retry, and that key verification reports
// ok/fail. fetch is mocked — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';

// Secrets must exist before kb/db (imported transitively) validates env.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { resolveProvider, providerApiKey, completeViaApi, callOpenAI, verifyProvider, cliInvocation, listProviderModels, chatModels, customBaseUrl, spawnCli, runViaCli, anthropicWebCliArgs, formatCliSpawnError, resolveCustomProviderDispatch, providerHasCli } =
  await import('../providers/providers.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { syncCustomProviders } = await import('../server/custom-providers.mjs');
import Database from 'better-sqlite3';

// In-memory secrets store for resolver tests (same schema as the vault).
function secretsDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_secrets (
      user_id TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, secret_key)
    );
    CREATE TABLE user_flags (
      user_id TEXT NOT NULL,
      flag TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '1',
      set_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, flag)
    );
  `);
  return db;
}

// Register one custom provider for 'user-1' in `db`. Returns the
// `custom:<id>` key. The registry is per user and per DB, so a fresh
// secretsDb() starts empty — no global teardown needed.
function registerCustom({ id = 'abc', name = 'GLM', baseURL = 'https://api.example.com/v1', vaultKey = 'custom.abc-123.apiKey', isEnabled = true } = {}, db = secretsDb()) {
  syncCustomProviders([{ id, name, baseURL, apiKey: vaultKey, models: [], isOpenAICompatible: true, isEnabled }], 'user-1', db);
  return `custom:${id}`;
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('resolveProvider: maps model families', () => {
  assert.equal(resolveProvider('claude-sonnet-4-6'), 'anthropic');
  assert.equal(resolveProvider('gpt-4o'), 'openai');
  assert.equal(resolveProvider('o3-mini'), 'openai');
  assert.equal(resolveProvider('codex-mini-latest'), 'openai');
  assert.equal(resolveProvider('gemini-1.5-flash'), 'google');
  assert.equal(resolveProvider('models/gemini-2.0-flash'), 'google');
  assert.equal(resolveProvider('deepseek-chat'), 'deepseek');
  assert.equal(resolveProvider('deepseek-reasoner'), 'deepseek');
  // GLM ids resolve to 'glm' — a provider with no adapter, so the caller
  // fails loudly and is pointed at Custom Providers. Defaulting them to
  // anthropic (the old behaviour) had Claude answer GLM requests silently.
  assert.equal(resolveProvider('glm-5.2'), 'glm');
  assert.equal(resolveProvider('glm-4.7'), 'glm');
  assert.equal(resolveProvider(''), 'anthropic');       // blank → default
  assert.equal(resolveProvider('mystery-model'), 'anthropic');
});

test('cliInvocation: codex is rooted with -C and pinned read-only; --yolo is never passed', () => {
  // A chat turn delegated to `codex exec` runs OUTSIDE this server's tool
  // loop, so no write it made could pass through the approval cards. The
  // ceiling is therefore the sandbox flag, not a prompt.
  const withCwd = cliInvocation('openai', 'do X', { cwd: '/tmp/proj' });
  assert.deepEqual(withCwd.args, ['exec', '-C', '/tmp/proj', '-s', 'read-only', '--', 'do X']);
  // No workspace known → no -C, but still read-only.
  assert.deepEqual(cliInvocation('openai', 'do X').args, ['exec', '-s', 'read-only', '--', 'do X']);
  for (const inv of [withCwd, cliInvocation('openai', 'do X'), cliInvocation('google', 'do X')]) {
    assert.ok(!inv.args.includes('--yolo'), 'chat must never auto-approve writes');
    assert.ok(!inv.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  }
  // gemini takes no documented read-only flag — it is rooted via the child
  // process cwd instead, so its argv stays the bare prompt form.
  assert.deepEqual(cliInvocation('google', 'do X', { cwd: '/tmp/proj' }).args, ['--prompt=do X']);
});

test('providerHasCli: only providers with a real CLI binary can run keyless', () => {
  // The predicate that decides "delegate to a logged-in CLI" vs "ask for a
  // key" for a non-Anthropic turn (llm_agent/runtime/route.mjs).
  assert.equal(providerHasCli('anthropic'), true);   // claude
  assert.equal(providerHasCli('openai'), true);      // codex
  assert.equal(providerHasCli('google'), true);      // gemini
  assert.equal(providerHasCli('deepseek'), false);   // cli: null
  assert.equal(providerHasCli('glm'), false);        // cli: null
  assert.equal(providerHasCli('custom'), false);     // cli: null
  assert.equal(providerHasCli('nope'), false);       // unknown provider
  assert.equal(providerHasCli(undefined), false);
});

test('providerApiKey: falls back to operator env when no user key', () => {
  process.env.OPENAI_API_KEY = 'sk-env-test';
  try {
    assert.equal(providerApiKey(null, 'openai'), 'sk-env-test');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
  assert.equal(providerApiKey(null, 'nonexistent'), null);
});

test('completeViaApi openai: returns assistant message content', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.match(url, /api\.openai\.com/);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'gpt-4o');
    assert.equal(body.messages[0].content, 'hello');
    return jsonRes(200, { choices: [{ message: { content: 'hi there' } }] });
  });
  try {
    const out = await completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'hello' });
    assert.equal(out, 'hi there');
  } finally { restore(); }
});

test('completeViaApi google: extracts text from candidate parts', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(url, /generativelanguage\.googleapis\.com/);
    assert.match(url, /gemini-1\.5-flash:generateContent/);
    return jsonRes(200, { candidates: [{ content: { parts: [{ text: 'g1' }, { text: 'g2' }] } }] });
  });
  try {
    const out = await completeViaApi('google', { apiKey: 'k', model: 'gemini-1.5-flash', prompt: 'x' });
    assert.equal(out, 'g1g2');
  } finally { restore(); }
});

test('completeViaApi: retries a transient 503 then succeeds', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return calls === 1 ? jsonRes(503, { error: 'overloaded' })
                       : jsonRes(200, { choices: [{ message: { content: 'ok' } }] });
  });
  try {
    const out = await completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  } finally { restore(); }
});

test('completeViaApi: throws on a non-transient 401 (no retry)', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; return jsonRes(401, { error: 'bad key' }); });
  try {
    await assert.rejects(
      () => completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' }),
      /HTTP 401/,
    );
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('callOpenAI: empty/absent model throws a clear error before any fetch (no opaque provider 1211)', async () => {
  // Regression for the iPhone-chat GLM "Unknown Model" (code 1211): the phone
  // forwarded provider="custom" with an empty model, runClaude → completeViaApi
  // → callOpenAI dropped the undefined `model` via JSON.stringify, so the
  // request reached GLM with NO model field → HTTP 400 code 1211. The guard
  // must turn that into a loud, actionable error and never hit the network.
  let fetched = false;
  const restore = mockFetch(async () => { fetched = true; return jsonRes(200, { choices: [{ message: { content: 'x' } }] }); });
  try {
    await assert.rejects(() => callOpenAI({ apiKey: 'k', model: undefined, prompt: 'hi' }), /No model id provided/);
    await assert.rejects(() => callOpenAI({ apiKey: 'k', model: '', prompt: 'hi' }), /No model id provided/);
    await assert.rejects(() => callOpenAI({ apiKey: 'k', model: '   ', prompt: 'hi' }), /No model id provided/);
    assert.equal(fetched, false, 'guard must throw before any network call');
  } finally { restore(); }
});

test('completeViaApi: empty model surfaces the same clear error (covers the runClaude/askAgent path)', async () => {
  // runClaude forwards provider+model into completeViaApi for non-Anthropic
  // providers. An empty model must fail clearly here too, not become an opaque
  // 1211 downstream. Uses the openai adapter (no custom baseUrl → no SSRF/DNS).
  const restore = mockFetch(async () => jsonRes(200, { choices: [{ message: { content: 'x' } }] }));
  try {
    await assert.rejects(
      () => completeViaApi('openai', { apiKey: 'k', model: undefined, prompt: 'hi' }),
      /No model id provided/,
    );
  } finally { restore(); }
});

test('listProviderModels openai: parses { data: [{id}] }', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.match(url, /api\.openai\.com\/v1\/models/);
    assert.equal(opts.method, 'GET');
    return jsonRes(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
  });
  try {
    assert.deepEqual(await listProviderModels('openai', { apiKey: 'k' }), ['gpt-4o', 'gpt-4o-mini']);
  } finally { restore(); }
});

test('listProviderModels google: strips models/ prefix from names', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models/);
    return jsonRes(200, { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }] });
  });
  try {
    assert.deepEqual(await listProviderModels('google', { apiKey: 'k' }), ['gemini-2.0-flash', 'gemini-1.5-pro']);
  } finally { restore(); }
});

test('listProviderModels: throws on a 401', async () => {
  const restore = mockFetch(async () => jsonRes(401, { error: 'bad key' }));
  try {
    await assert.rejects(() => listProviderModels('openai', { apiKey: 'k' }), /HTTP 401/);
  } finally { restore(); }
});

test('verifyProvider: key mode lists models (GET) and reports ok', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(opts.method, 'GET'); // no token-spending generate call
    return jsonRes(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
  });
  try {
    const r = await verifyProvider({ provider: 'openai', mode: 'key', apiKey: 'k' });
    assert.equal(r.ok, true);
    assert.match(r.detail, /2 models/);
  } finally { restore(); }
});

test('verifyProvider: key mode reports failure on a 401, never throws', async () => {
  const restore = mockFetch(async () => jsonRes(401, { error: 'nope' }));
  try {
    const r = await verifyProvider({ provider: 'anthropic', mode: 'key', apiKey: 'k' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /401/);
  } finally { restore(); }
});

test('verifyProvider: unknown provider fails gracefully', async () => {
  const r = await verifyProvider({ provider: 'skynet', mode: 'key', apiKey: 'k' });
  assert.equal(r.ok, false);
});

test('custom: resolveProvider never infers it from a model id', () => {
  // Custom is explicit-only (not prefix-routable), so arbitrary ids fall back
  // to the anthropic default rather than accidentally hitting the custom path.
  assert.equal(resolveProvider('mistral-large'), 'anthropic');
  assert.equal(resolveProvider('llama-3.1-70b'), 'anthropic');
});

test('deepseek: completeViaApi posts to the DeepSeek base URL', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-chat');
    return jsonRes(200, { choices: [{ message: { content: 'deepseek-reply' } }] });
  });
  try {
    const out = await completeViaApi('deepseek', {
      apiKey: 'k', model: 'deepseek-chat', prompt: 'x',
      baseUrl: 'https://api.deepseek.com',
    });
    assert.equal(out, 'deepseek-reply');
  } finally { restore(); }
});

test('custom: completeViaApi posts to the configured base URL', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://openrouter.example/api/v1/chat/completions');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek/deepseek-chat');
    return jsonRes(200, { choices: [{ message: { content: 'custom-reply' } }] });
  });
  try {
    const out = await completeViaApi('custom', {
      apiKey: 'k', model: 'deepseek/deepseek-chat', prompt: 'x',
      baseUrl: 'https://openrouter.example/api/v1/',   // trailing slash tolerated
    });
    assert.equal(out, 'custom-reply');
  } finally { restore(); }
});

test('custom: listProviderModels reads <baseUrl>/models', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://local.example/v1/models');
    assert.equal(opts.method, 'GET');
    return jsonRes(200, { data: [{ id: 'llama3' }, { id: 'qwen2.5' }] });
  });
  try {
    const ids = await listProviderModels('custom', { apiKey: 'k', baseUrl: 'https://local.example/v1' });
    assert.deepEqual(ids, ['llama3', 'qwen2.5']);
  } finally { restore(); }
});

test('custom: verifyProvider fails an endpoint that lists models but has no chat API', async () => {
  // e.g. a "decision API" that implements only GET /models: verification used
  // to pass on the model list alone, then every chat turn 404'd.
  const restore = mockFetch(async (url, opts) => {
    if (url.endsWith('/models')) return jsonRes(200, { data: [{ id: 'glm-5.1' }] });
    assert.equal(opts.method, 'POST');
    assert.equal(opts.body, '{}', 'no model, no messages: the probe runs no completion');
    return jsonRes(404, { statusMessage: 'Page not found: /api/v1/chat/completions' });
  });
  try {
    const r = await verifyProvider({ provider: 'custom', mode: 'key', apiKey: 'k', baseUrl: 'https://decisions.example/api/v1/' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /decisions\.example\/api\/v1\/chat\/completions does not exist/);
  } finally { restore(); }
});

test('custom: verifyProvider passes when the chat route rejects the empty probe', async () => {
  const restore = mockFetch(async (url) => url.endsWith('/models')
    ? jsonRes(200, { data: [{ id: 'llama3' }] })
    : jsonRes(400, { error: { message: 'model is required' } }));
  try {
    const r = await verifyProvider({ provider: 'custom', mode: 'key', apiKey: 'k', baseUrl: 'https://local.example/v1' });
    assert.equal(r.ok, true);
  } finally { restore(); }
});

test('callOpenAI: a 404 with no chat route says so; an unknown-model 404 keeps its text', async () => {
  let restore = mockFetch(async () => jsonRes(404, { statusMessage: 'Page not found: /api/v1/chat/completions' }));
  try {
    await assert.rejects(
      () => callOpenAI({ apiKey: 'k', model: 'glm-5.1', prompt: 'hi', baseUrl: 'https://decisions.example/api/v1' }),
      /no OpenAI-compatible chat API: https:\/\/decisions\.example\/api\/v1\/chat\/completions returned 404/);
  } finally { restore(); }
  restore = mockFetch(async () => jsonRes(404, { error: { code: 'model_not_found', message: 'The model `x` does not exist' } }));
  try {
    await assert.rejects(() => callOpenAI({ apiKey: 'k', model: 'x', prompt: 'hi' }), /model_not_found/);
  } finally { restore(); }
});

test('custom: verifyProvider reports failure when no base URL is set', async () => {
  const r = await verifyProvider({ provider: 'custom', mode: 'key', apiKey: 'k' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /base URL/i);
});

test('customBaseUrl: env fallback, trailing slash stripped', () => {
  process.env.LLMIDE_OPENAI_COMPAT_BASE_URL = 'https://x.example/v1/';
  try {
    assert.equal(customBaseUrl(null), 'https://x.example/v1');
  } finally {
    delete process.env.LLMIDE_OPENAI_COMPAT_BASE_URL;
  }
})

test('chatModels: openai keeps chat models, drops non-completion ones', () => {
  const ids = ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'text-embedding-3-small',
               'whisper-1', 'tts-1', 'dall-e-3', 'omni-moderation-latest'];
  assert.deepEqual(chatModels('openai', ids).sort(), ['gpt-4o', 'gpt-4o-mini', 'o3-mini']);
});

test('chatModels: google keeps gemini-*, drops embeddings', () => {
  const ids = ['gemini-2.0-flash', 'gemini-1.5-pro', 'text-embedding-004', 'aqa'];
  assert.deepEqual(chatModels('google', ids).sort(), ['gemini-1.5-pro', 'gemini-2.0-flash']);
});

test('chatModels: anthropic keeps claude-* only', () => {
  assert.deepEqual(chatModels('anthropic', ['claude-sonnet-4-6', 'whatever']), ['claude-sonnet-4-6']);
});

test('formatCliSpawnError: not-logged-in stdout never leaks argv prompt', () => {
  const err = {
    code: 1,
    message: 'Command failed: claude --strict-mcp-config -p ' + 'x'.repeat(500),
    stdout: 'Not logged in · Please run /login\n',
    stderr: '',
    bin: 'claude',
  };
  const msg = formatCliSpawnError(err, { bin: 'claude' });
  assert.match(msg, /not logged in/i);
  assert.doesNotMatch(msg, /Command failed/);
  assert.doesNotMatch(msg, /x{10}/);
});

test('formatCliSpawnError: raw CLI output is collapsed to one labeled line', () => {
  const err = {
    code: 1,
    stdout: 'INFO some startup banner\nActual error: quota exceeded\n',
    stderr: 'warning: something else\n',
  };
  const msg = formatCliSpawnError(err, { bin: 'claude' });
  assert.match(msg, /^claude failed: /, 'raw CLI output must be labeled as a CLI failure, not shown bare');
  assert.doesNotMatch(msg, /\n/, 'multi-line CLI dumps must collapse to one line for the chat error bubble');
  assert.match(msg, /quota exceeded/, 'the diagnostic content itself must survive');
});

test('formatCliSpawnError: a key spanning the length cap is redacted before truncation', () => {
  // Redaction must run on the FULL text, then truncate — slicing first
  // leaves the head of a credential visible when it straddles the boundary.
  const key = 'sk-boundary-secret-key-value';
  const err = { code: 1, stdout: 'x'.repeat(290) + ' ' + key + ' tail', stderr: '' };
  const msg = formatCliSpawnError(err, { bin: 'claude', apiKey: key });
  assert.doesNotMatch(msg, /sk-bounda/, 'no fragment of the key may survive truncation');
});

test('formatCliSpawnError: empty streams falls back to actionable hint', () => {
  const msg = formatCliSpawnError({ code: 1, message: 'Command failed: claude -p huge', stdout: '', stderr: '' }, { bin: 'claude' });
  assert.match(msg, /claude login|API key/i);
  assert.doesNotMatch(msg, /Command failed/);
});

test('cliInvocation: standard non-interactive form per provider', () => {
  assert.deepEqual(cliInvocation('anthropic', 'hi'), { bin: 'claude', args: ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', 'You are a helpful AI assistant.', '-p', 'hi'] });
  // codex is pinned read-only for chat delegation (see the dedicated test
  // below); no workspace passed here, so no -C.
  assert.deepEqual(cliInvocation('openai', 'hi'),    { bin: 'codex',  args: ['exec', '-s', 'read-only', '--', 'hi'] });
  assert.deepEqual(cliInvocation('google', 'hi'),    { bin: 'gemini', args: ['--prompt=hi'] });
  assert.equal(cliInvocation('skynet', 'hi'), null);
});

test('anthropicWebCliArgs: enables AND pre-approves a single web tool', () => {
  // Both flags matter: --tools makes the tool available, --allowedTools
  // pre-approves it so headless `-p` mode runs it instead of declining
  // ("I don't have permission to use WebFetch yet"). Regression guard.
  assert.deepEqual(
    anthropicWebCliArgs('q', { tool: 'WebSearch' }),
    ['--strict-mcp-config', '--setting-sources', '', '--tools', 'WebSearch', '--allowedTools', 'WebSearch', '-p', 'q'],
  );
  assert.deepEqual(
    anthropicWebCliArgs('q', { tool: 'WebFetch' }),
    ['--strict-mcp-config', '--setting-sources', '', '--tools', 'WebFetch', '--allowedTools', 'WebFetch', '-p', 'q'],
  );
});

test('cliInvocation: binary overridable via LLMIDE_<PROVIDER>_CLI', () => {
  process.env.LLMIDE_OPENAI_CLI = 'my-codex';
  try {
    assert.deepEqual(cliInvocation('openai', 'x'), { bin: 'my-codex', args: ['exec', '-s', 'read-only', '--', 'x'] });
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
  }
});

test('spawnCli: rejects an unknown provider without spawning', async () => {
  await assert.rejects(() => spawnCli('skynet', 'hi'), /unknown provider 'skynet'/);
});

test('spawnCli: invokes cliInvocation argv, closes stdin, resolves {stdout,stderr,bin}', async () => {
  // Override the binary to a harmless `echo`; cliInvocation('openai') yields
  // the codex argv, so this round-trips it back as stdout. Proves the spawn
  // resolves (stdin closed → no ~3s hang) and the shape.
  process.env.LLMIDE_OPENAI_CLI = 'echo';
  try {
    const out = await spawnCli('openai', 'hi');
    assert.equal(out.bin, 'echo');
    assert.equal(out.stdout.trim(), 'exec -s read-only -- hi');
    assert.equal(out.stderr, '');
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
  }
});

test('runViaCli: rejects an unknown provider with its own message', async () => {
  await assert.rejects(() => runViaCli('skynet', 'hi'), /runViaCli: unknown provider 'skynet'/);
});

test('runViaCli: trims CLI stdout and reports it', async () => {
  process.env.LLMIDE_OPENAI_CLI = 'echo';
  try {
    // No caller workspace → the isolated temp-dir form (see the isolation
    // tests below); `echo` round-trips the argv.
    assert.match(await runViaCli('openai', 'hi'), /^exec --skip-git-repo-check -C \S+llmide-cli-\S+ -s read-only -- hi$/);
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
  }
});

test('spawnCli: cwd really lands on the child process', async () => {
  // `pwd` prints the child's working directory, so this proves the spawn
  // option takes effect — without it the child inherits the SERVER's
  // directory, which is what made a delegated codex/gemini turn read the
  // wrong tree. argv is emptied because `pwd` rejects extra arguments.
  process.env.LLMIDE_OPENAI_CLI = 'pwd';
  try {
    const out = await spawnCli('openai', 'hi', { args: [], cwd: os.tmpdir() });
    assert.equal(fs.realpathSync(out.stdout.trim()), fs.realpathSync(os.tmpdir()));
    // No cwd → inherits the server's directory (this test process).
    const inherited = await spawnCli('openai', 'hi', { args: [] });
    assert.equal(fs.realpathSync(inherited.stdout.trim()), fs.realpathSync(process.cwd()));
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
  }
});

test('runViaCli: ENOENT surfaces the install/login hint', async () => {
  process.env.LLMIDE_OPENAI_CLI = 'definitely-not-a-real-binary-xyz';
  try {
    await assert.rejects(() => runViaCli('openai', 'hi'), /CLI not found — install it and log in/);
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
  }
});

test('completeViaApi: a quota 429 is NOT retried (would only burn quota)', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return jsonRes(429, { error: { code: 'insufficient_quota', message: 'exceeded your current quota' } });
  });
  try {
    await assert.rejects(
      () => completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' }),
      /HTTP 429/,
    );
    assert.equal(calls, 1); // no retry
  } finally { restore(); }
});

test('completeViaApi: a rate-limit 429 (no quota marker) IS retried', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return calls === 1 ? jsonRes(429, { error: { message: 'rate limit, slow down' } })
                       : jsonRes(200, { choices: [{ message: { content: 'ok' } }] });
  });
  try {
    const out = await completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  } finally { restore(); }
});

// ── resolveCustomProviderDispatch: custom:<uuid> credential resolution ────
// The single source of truth both dispatch paths use to turn a registered
// custom provider id into an {apiKey, baseUrl}. A failure must return a
// surfacable {error,message}, never throw into the model call.

test('resolveCustomProviderDispatch: returns apiKey+baseUrl for a registered, keyed provider', () => {
  const db = secretsDb();
  const pid = registerCustom({}, db);
  try {
    setSecret(db, 'user-1', 'custom.abc-123.apiKey', 'sk-glm-test');
    const r = resolveCustomProviderDispatch(pid, 'user-1', db);
    assert.equal(r.error, undefined);
    assert.equal(r.apiKey, 'sk-glm-test');
    assert.equal(r.baseUrl, 'https://api.example.com/v1');
    assert.equal(r.name, 'GLM');
  } finally { /* per-user, per-DB registry: nothing to reset */ }
});

test('resolveCustomProviderDispatch: {error:"not_found"} for an unregistered custom:uuid', () => {
  try {
    const r = resolveCustomProviderDispatch('custom:bogus', 'user-1', secretsDb());
    assert.equal(r.error, 'not_found');
    assert.match(r.message, /not found/);
  } finally { /* per-user, per-DB registry: nothing to reset */ }
});

test('resolveCustomProviderDispatch: {error:"no_key"} when no secret is stored', () => {
  const db = secretsDb();
  const pid = registerCustom({}, db);
  try {
    const r = resolveCustomProviderDispatch(pid, 'user-1', db); // no setSecret
    assert.equal(r.error, 'no_key');
    assert.match(r.message, /No API key configured for GLM/);
  } finally { /* per-user, per-DB registry: nothing to reset */ }
});

test('resolveCustomProviderDispatch: {error:"disabled"} when isEnabled is false', () => {
  const db = secretsDb();
  const pid = registerCustom({ isEnabled: false }, db);
  try {
    const r = resolveCustomProviderDispatch(pid, 'user-1', db);
    assert.equal(r.error, 'disabled');
    assert.match(r.message, /disabled/);
  } finally { /* per-user, per-DB registry: nothing to reset */ }
});

test('resolveCustomProviderDispatch: a non-allowlisted vault key degrades to {error:"no_key"}, not a throw', () => {
  // The resolver must swallow a vault error so a misconfigured key never throws
  // into the model call. 'custom.NotAllowed.apiKey' fails the charset gate.
  const db = secretsDb();
  const pid = registerCustom({ vaultKey: 'custom.NotAllowed.apiKey' }, db);
  try {
    const r = resolveCustomProviderDispatch(pid, 'user-1', db);
    assert.equal(r.error, 'no_key');
  } finally { /* per-user, per-DB registry: nothing to reset */ }
});

// ── Subscription (logged-in CLI) tiers: model flag + isolation ───────────

const { cliModelId, sweepStaleCliTempDirs } = await import('../providers/providers.mjs');

test('cliInvocation: the requested model rides the codex/gemini argv as -m', () => {
  // Without it a routed cheap model silently ran the CLI default and the
  // usage ledger recorded a model that never ran.
  assert.deepEqual(
    cliInvocation('openai', 'do X', { cwd: '/tmp/proj', model: 'gpt-5-mini' }).args,
    ['exec', '-C', '/tmp/proj', '-m', 'gpt-5-mini', '-s', 'read-only', '--', 'do X'],
  );
  assert.deepEqual(
    cliInvocation('google', 'do X', { model: 'gemini-2.5-flash' }).args,
    ['-m', 'gemini-2.5-flash', '--prompt=do X'],
  );
  // The Google API's `models/` resource prefix is not a CLI model id.
  assert.deepEqual(
    cliInvocation('google', 'do X', { model: 'models/gemini-2.5-pro' }).args,
    ['-m', 'gemini-2.5-pro', '--prompt=do X'],
  );
});

test('cliInvocation: a model id that could be read as a flag is omitted, never forwarded', () => {
  for (const bad of ['--yolo', '-s', 'gpt 5', 'gpt-5;rm', '', 'a'.repeat(200), 42, null]) {
    assert.deepEqual(cliInvocation('openai', 'p', { model: bad }).args, ['exec', '-s', 'read-only', '--', 'p'], String(bad));
    assert.deepEqual(cliInvocation('google', 'p', { model: bad }).args, ['--prompt=p'], String(bad));
  }
  assert.equal(cliModelId('openai', '--yolo'), null);
  assert.equal(cliModelId('openai', 'gpt-5'), 'gpt-5');
  assert.equal(cliModelId('google', 'models/gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(cliModelId('deepseek', 'deepseek-chat'), null, 'no CLI → no CLI model');
});

test('cliInvocation: an isolated codex run skips the git-repo check (temp dir is not a repo)', () => {
  assert.deepEqual(
    cliInvocation('openai', 'p', { cwd: '/tmp/iso', isolated: true, model: 'gpt-5' }).args,
    ['exec', '--skip-git-repo-check', '-C', '/tmp/iso', '-m', 'gpt-5', '-s', 'read-only', '--', 'p'],
  );
  // A caller-supplied workspace keeps today's argv exactly.
  assert.deepEqual(cliInvocation('openai', 'p', { cwd: '/tmp/proj' }).args, ['exec', '-C', '/tmp/proj', '-s', 'read-only', '--', 'p']);
});

// A fake CLI that reports where it ran and what it was given.
function fakeCli() {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/fakecli-`);
  const bin = `${dir}/fake-cli`;
  fs.writeFileSync(bin, '#!/bin/sh\necho "cwd=$(pwd)"\necho "entries=$(ls -A | wc -l | tr -d \' \')"\necho "mode=$(stat -c %a . 2>/dev/null || stat -f %Lp .)"\necho "argv=$*"\n', { mode: 0o755 });
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const field = (out, k) => out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);

test('runViaCli: no cwd → runs in a fresh, empty, private temp dir that is removed afterwards', async () => {
  const { bin, cleanup } = fakeCli();
  process.env.LLMIDE_GOOGLE_CLI = bin;
  try {
    const out = await runViaCli('google', 'hi', { model: 'gemini-2.5-flash' });
    const ran = field(out, 'cwd');
    assert.notEqual(fs.realpathSync(os.tmpdir()), ran);
    assert.ok(!ran.startsWith(fs.realpathSync(process.cwd())), 'never the server cwd');
    assert.equal(field(out, 'entries'), '0');
    assert.equal(field(out, 'mode'), '700');
    assert.equal(field(out, 'argv'), '-m gemini-2.5-flash --prompt=hi');
    assert.equal(fs.existsSync(ran), false, 'temp dir removed');
  } finally {
    delete process.env.LLMIDE_GOOGLE_CLI;
    cleanup();
  }
});

test('runViaCli: codex without cwd gets --skip-git-repo-check -C <tmp> read-only; temp dir removed on failure too', async () => {
  const { bin, cleanup } = fakeCli();
  process.env.LLMIDE_OPENAI_CLI = bin;
  try {
    const out = await runViaCli('openai', 'hi', { model: 'gpt-5' });
    const ran = field(out, 'cwd');
    const argv = field(out, 'argv');
    assert.match(argv, /^exec --skip-git-repo-check -C (\S+) -m gpt-5 -s read-only -- hi$/);
    // -C names the directory the child actually ran in (pwd is realpath'd).
    const cDir = argv.split(' ')[3];
    assert.ok(ran.endsWith(`/${cDir.split('/').pop()}`), `${ran} vs ${cDir}`);
    assert.equal(fs.existsSync(ran), false);
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
    cleanup();
  }
  // Failing spawn: the temp dir still goes away.
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('llmide-cli-')).length;
  process.env.LLMIDE_OPENAI_CLI = 'definitely-not-a-real-binary-xyz';
  try {
    await assert.rejects(() => runViaCli('openai', 'hi'), /CLI not found/);
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
  }
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('llmide-cli-')).length;
  assert.equal(after, before);
});

test('runViaCli: a caller-supplied cwd is used as is (no temp dir, no skip flag)', async () => {
  const { bin, cleanup } = fakeCli();
  const proj = fs.mkdtempSync(`${os.tmpdir()}/proj-`);
  process.env.LLMIDE_OPENAI_CLI = bin;
  try {
    const out = await runViaCli('openai', 'hi', { cwd: proj });
    assert.equal(field(out, 'cwd'), fs.realpathSync(proj));
    assert.equal(field(out, 'argv'), `exec -C ${proj} -s read-only -- hi`);
    assert.ok(fs.existsSync(proj), 'the caller\'s dir is never removed');
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
    cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('cliInvocation: a prompt that looks like a flag stays the prompt (codex `--`, gemini `--prompt=`)', () => {
  // codex (clap): everything after `--` is positional, so a prompt such as
  // "--yolo" or "resume" can never become a flag or a subcommand.
  const codex = cliInvocation('openai', '--yolo', { model: 'gpt-5' }).args;
  assert.deepEqual(codex.slice(-2), ['--', '--yolo']);
  assert.equal(codex.filter((a) => a === '--yolo').length, 1, 'only the prompt slot holds it');
  // gemini (yargs): `--prompt=<value>` is ONE token whose value is taken
  // verbatim — a separate `-p <value>` would let yargs read a dash-led value
  // as the next flag. The argv must carry no standalone flag-shaped prompt.
  const gemini = cliInvocation('google', '--yolo -s', { model: 'gemini-2.5-flash' }).args;
  assert.deepEqual(gemini, ['-m', 'gemini-2.5-flash', '--prompt=--yolo -s']);
  assert.ok(!gemini.includes('--yolo') && !gemini.includes('-p'));
});

test('formatCliSpawnError: names the right CLI login per provider', () => {
  const notLoggedIn = { code: 1, stdout: 'Not logged in · Please run /login\n', stderr: '' };
  assert.match(formatCliSpawnError(notLoggedIn, { bin: 'codex', provider: 'openai' }), /`codex login`/);
  assert.doesNotMatch(formatCliSpawnError(notLoggedIn, { bin: 'codex', provider: 'openai' }), /claude login/);
  assert.match(formatCliSpawnError(notLoggedIn, { bin: 'gemini', provider: 'google' }), /`gemini`.*sign in/);
  assert.match(formatCliSpawnError(notLoggedIn, { bin: 'claude' }), /`claude login`/);
  const empty = { code: 1, stdout: '', stderr: '' };
  assert.match(formatCliSpawnError(empty, { bin: 'codex', provider: 'openai' }), /`codex login`/);
  assert.match(formatCliSpawnError({ code: 'ENOENT' }, { bin: 'gemini', provider: 'google' }), /gemini CLI not found/);
});

test('formatCliSpawnError: never echoes stack frames or absolute paths (kept in the log only)', () => {
  // The broken-codex shape on this machine: the shim exits 1 with a Node
  // stack naming its vendored native binary.
  const err = {
    code: 1, stdout: '',
    stderr: 'Error: spawn /opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex ENOENT\n'
      + '    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n'
      + '    at onErrorNT (node:internal/child_process:483:16)\n',
  };
  const msg = formatCliSpawnError(err, { bin: 'codex', provider: 'openai' });
  assert.doesNotMatch(msg, /\/opt\/homebrew|node_modules|ChildProcess|onErrorNT/);
  assert.match(msg, /codex/);
  assert.match(msg, /reinstall|install/i);
});

// A fake CLI that exits non-zero with or without stdout.
function scriptCli(body) {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/fakecli-`);
  const bin = `${dir}/fake-cli`;
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('runViaCli: a CLI that cannot run is tagged PROVIDER_UNAVAILABLE (the code the Mac retries on)', async () => {
  const cases = [
    ['missing binary', 'definitely-not-a-real-binary-xyz', null],
    ['non-zero exit, no stdout', null, 'echo "boom" >&2; exit 1'],
    ['not logged in', null, 'echo "Not logged in"; exit 1'],
  ];
  for (const [label, binName, body] of cases) {
    const fake = body ? scriptCli(body) : null;
    process.env.LLMIDE_OPENAI_CLI = fake ? fake.bin : binName;
    try {
      await assert.rejects(() => runViaCli('openai', 'hi'),
        (err) => err.code === 'PROVIDER_UNAVAILABLE' && err.cliCantRun === true, label);
    } finally {
      delete process.env.LLMIDE_OPENAI_CLI;
      fake?.cleanup();
    }
  }
  // A CLI that ran and answered with an error on stdout is a real failure of a
  // working route — not tagged.
  const real = scriptCli('echo "model overloaded, try later"; exit 1');
  process.env.LLMIDE_OPENAI_CLI = real.bin;
  try {
    await assert.rejects(() => runViaCli('openai', 'hi'),
      (err) => err.code !== 'PROVIDER_UNAVAILABLE' && !err.cliCantRun);
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
    real.cleanup();
  }
});

test('runViaCli: an aborted request kills the CLI and removes its temp dir', async () => {
  const slow = scriptCli('pwd > "$0.cwd"; sleep 5; echo late');
  process.env.LLMIDE_GOOGLE_CLI = slow.bin;
  const ctl = new AbortController();
  const started = Date.now();
  try {
    // Abort once the CLI has demonstrably started (wrote its cwd) — a fixed
    // delay raced the spawn under a loaded test run.
    const poll = setInterval(() => { if (fs.existsSync(`${slow.bin}.cwd`)) { clearInterval(poll); ctl.abort(); } }, 20);
    await assert.rejects(() => runViaCli('google', 'hi', { signal: ctl.signal }), (err) => err.name === 'AbortError');
    clearInterval(poll);
    assert.ok(Date.now() - started < 4500, 'did not wait for the CLI to finish');
    const ran = fs.readFileSync(`${slow.bin}.cwd`, 'utf8').trim();
    assert.equal(fs.existsSync(ran), false, 'temp dir removed on abort');
  } finally {
    delete process.env.LLMIDE_GOOGLE_CLI;
    slow.cleanup();
  }
});

test('sweepStaleCliTempDirs: removes llmide-cli-* dirs older than the cutoff, nothing else', async () => {
  const root = fs.mkdtempSync(`${os.tmpdir()}/sweep-`);
  try {
    const old = `${root}/llmide-cli-old`;
    const fresh = `${root}/llmide-cli-fresh`;
    const other = `${root}/something-else`;
    for (const d of [old, fresh, other]) fs.mkdirSync(d);
    fs.writeFileSync(`${old}/f`, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(other, twoHoursAgo, twoHoursAgo);
    const removed = await sweepStaleCliTempDirs({ root, maxAgeMs: 3600_000 });
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(other));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('completeViaApi meters an OpenAI reply into the turn total with prompt_tokens kept whole (the quota counts it)', async () => {
  const { newTurnTokenTotals, countTurnTokens } = await import('../kb/usage.mjs');
  const restore = mockFetch(async () => jsonRes(200, {
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 50, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 30 } },
  }));
  try {
    const totals = newTurnTokenTotals();
    await countTurnTokens(totals, () =>
      completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'hello', meter: { userId: 'u-meter', endpoint: '/t' } }));
    assert.deepEqual(totals, { inputTokens: 50, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0, calls: 1, unmeteredCalls: 0 });
  } finally { restore(); }
});

test('completeViaApi without a metering user notes an unmetered call on the turn', async () => {
  const { newTurnTokenTotals, countTurnTokens } = await import('../kb/usage.mjs');
  const restore = mockFetch(async () => jsonRes(200, {
    choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 50, completion_tokens: 8 },
  }));
  try {
    const totals = newTurnTokenTotals();
    await countTurnTokens(totals, () => completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'hello' }));
    assert.equal(totals.calls, 0);
    assert.equal(totals.unmeteredCalls, 1);
  } finally { restore(); }
});
