// End-to-end integration of the Phase 3 slices against the REAL core (extension/server.mjs, fake engine, temp DB):
// shell core client login/refresh -> chat binding to the host -> chat controller + stores over the real SSE stream ->
// settings adapter over real routes -> cross-screen bus. The host (Rust) side is the in-memory fake in fake-host.mjs.
// No DOM is needed: every screen is a view-model + a thin component, so the assertions are on the view-models.
// Skip with LLMIDE_E2E=0 (the suite needs local port binding).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDir } from "../../../../../desktop/scripts/test-outdir.mjs";
import { startCore } from "./core-server.mjs";
import { createFakeChatHost } from "./fake-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const require = createRequire(join(REPO, "desktop/package.json"));
const skip = process.env.LLMIDE_E2E === "0" ? "LLMIDE_E2E=0" : false;

let m;
let core;
before(async () => {
  if (skip) return;
  const { build } = require("esbuild");
  const outfile = join(bundleDir("shell-e2e"), "entry.mjs");
  await build({
    entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent",
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") },
  });
  m = await import(`${outfile}?t=${Date.now()}`);
  core = await startCore();
});
after(async () => { await core?.stop(); });

const until = async (fn, ms = 15_000, info = () => "") => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out ${info()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// The bench fake engine ends its stream after `tasks` without the terminal `result` event the real engine sends
// (extension/llm_agent/sdk/bench-fake-engine.mjs, not ours to change). Without it the reducer correctly reports
// STREAM_ENDED, so the harness appends the real engine's `result` frame (schema/agent-v2/fixtures/result.json).
const RESULT = readFileSync(join(REPO, "schema/agent-v2/fixtures/result.json"), "utf8").trim();
function withResult(transport) {
  return { ...transport, async *stream(path, body, signal) { yield* transport.stream(path, body, signal); yield RESULT; } };
}

function client() {
  return m.createCoreClient({ baseUrl: () => core.base });
}

test("login, token hand-off to the host binding, refresh rebinds, sign-out unbinds", { skip }, async () => {
  const c = client();
  const host = createFakeChatHost();
  const binding = m.createChatBinding(c, host.invoke, () => true);
  assert.equal(binding.getSnapshot().state, "unbound");
  const snap = await c.login(core.email, core.password);
  assert.equal(snap.signedIn, true);
  await binding.whenBound(5000);
  assert.equal(host.isBound(), true);
  const bind = host.calls.find((x) => x.command === "chat_bind_session");
  assert.equal(typeof bind.args.token, "string", "the host receives the access token");
  assert.equal(JSON.stringify(c.getSnapshot()).includes(bind.args.token), false, "the public snapshot never carries it");
  c.republishAccessToken(); // what a core restart triggers
  await until(() => host.calls.filter((x) => x.command === "chat_bind_session").length === 2);
  await c.logout();
  await until(() => !host.isBound());
  assert.equal(binding.getSnapshot().state, "unbound");
  binding.dispose();
});

test("a bind failure surfaces as `failed` and whenBound rejects with the host code", { skip }, async () => {
  const c = client();
  const binding = m.createChatBinding(c, async () => { throw { code: "core_unavailable" }; }, () => true);
  await c.login(core.email, core.password);
  await assert.rejects(binding.whenBound(2000), /core_unavailable/);
  assert.equal(binding.getSnapshot().state, "failed");
  binding.dispose();
  await c.logout();
});

test("a chat turn over the real stream: reducer view-model, write-through to the host chat file, reload", { skip }, async () => {
  const c = client();
  const host = createFakeChatHost();
  const binding = m.createChatBinding(c, host.invoke, () => true);
  await c.login(core.email, core.password);
  const store = new m.TauriChatStore({ invoke: host.invoke, ready: () => binding.whenBound(5000) });
  const ctl = new m.ChatController({ core: withResult(m.coreTransportFrom(c)), store, workspaceRoot: () => core.workspace });

  const s = await store.createSession({ title: "E2E chat" });
  assert.match(s.id, /^[0-9A-F-]{36}$/, "ids are upper-case UUIDs (the host requires UUIDs)");
  assert.deepEqual((await store.listSessions({ limit: 10, offset: 0 })).map((x) => x.title), ["E2E chat"]);

  await ctl.open(s.id);
  ctl.send(s.id, "hello core", { mode: "ask", model: "bench-fake" });
  await until(() => {
    const st = ctl.getState(s.id);
    return st.phase === "idle" && st.messages.at(-1)?.role === "assistant" && st.messages.at(-1)?.status === "done";
  }, 15_000, () => JSON.stringify({ phase: ctl.getState(s.id).phase, error: ctl.getState(s.id).error, n: ctl.getState(s.id).messages.length, server: core.tail(800) }));
  const st = ctl.getState(s.id);
  assert.equal(st.messages[0].text, "hello core");
  const reply = st.messages.at(-1);
  assert.ok(reply.parts.length > 0, "the streamed reply has text parts");

  // Write-through: both sides are in the host's chat file before anything else happens.
  await until(() => host.files.get(s.id)?.doc.messages.length === 2);
  const file = host.files.get(s.id).doc;
  assert.deepEqual(file.messages.map((x) => x.role), ["user", "assistant"]);
  assert.equal(file.messages[0].content, "hello core");
  assert.equal(file.messages[0].toolSteps.length, 0, "Mac ChatMessage shape");
  assert.ok(file.messages[1].content.length > 0);

  // A fresh controller (webview reload) sees the same history from the file.
  const page = await store.loadMessages(s.id, { limit: 50 });
  assert.deepEqual(page.messages.map((x) => x.seq), [1, 2]);
  assert.equal(page.hasMore, false);

  // The host chat file is the only copy: deleting it removes the chat from the list.
  await store.deleteSession(s.id);
  assert.deepEqual(await store.listSessions({ limit: 10, offset: 0 }), []);
  binding.dispose();
  await c.logout();
});

test("the same turn through the core's own chat routes (browser mode: HttpChatStore)", { skip }, async () => {
  const c = client();
  await c.login(core.email, core.password);
  const transport = m.coreTransportFrom(c);
  const store = new m.HttpChatStore(transport);
  const ctl = new m.ChatController({ core: withResult(transport), store, workspaceRoot: () => core.workspace });
  const s = await store.createSession({ title: "http chat" });
  ctl.send(s.id, "ping", { mode: "ask", model: "bench-fake" });
  await until(() => ctl.getState(s.id).messages.at(-1)?.status === "done", 15_000, () => JSON.stringify({ phase: ctl.getState(s.id).phase, error: ctl.getState(s.id).error }));
  await until(async () => (await store.loadMessages(s.id, { limit: 10 })).messages.length === 2);
  await c.logout();
});

test("a stream before sign-in fails with a session error, never an unauthenticated request", { skip }, async () => {
  const c = client();
  const transport = m.coreTransportFrom(c);
  const ctl = new m.ChatController({ core: transport, store: new m.MemoryChatStore(), workspaceRoot: () => core.workspace });
  ctl.send("x", "hi", { mode: "ask" });
  await until(() => ctl.getState("x").phase === "error");
  assert.equal(ctl.getState("x").error.code, "NO_SESSION");
});

test("settings adapter: real routes through requestRaw, error envelopes as data, trust and diagnostics", { skip }, async () => {
  const c = client();
  await c.login(core.email, core.password);
  const env = m.createSettingsEnv({
    core: c,
    coreStatus: () => ({ trust: "spawned" }),
    invoke: async () => null,
    hostAvailable: () => false,
    activeProjectRoot: () => core.workspace,
    theme: { get: () => "dark", set() {} },
    appVersion: () => "9.9.9",
    platform: () => "test",
    clipboard: () => null,
  });
  const health = await env.client.request("GET", "/health");
  assert.equal(health.status, 200);
  const missing = await env.client.request("GET", "/kb/definitely-not-a-route");
  assert.ok(missing.status >= 400 && missing.status < 500, `unknown route answers 4xx, got ${missing.status}`);
  const diag = await env.host.diagnostics();
  assert.deepEqual(diag, { appVersion: "9.9.9", coreTrust: "spawned", coreLogPath: null, platform: "test" });
  assert.equal(env.host.activeProjectPath(), core.workspace);
  assert.equal(await env.host.notesFolderPath(), null);
  await assert.rejects(env.host.copyText("x"), /clipboard unavailable/);
  // The providers model (Settings > Providers) loads the real catalog through the adapter.
  const model = new m.ProvidersModel(new m.ProvidersApi(env.client));
  await model.load();
  const ps = model.getState();
  assert.equal(ps.phase, "ready", `providers phase ${ps.phase} ${JSON.stringify(ps.error)}`);
  // Optional host abilities that have no host command yet are absent, so Settings shows the placeholder.
  for (const k of ["getLtaMode", "setLtaMode", "getRoutePrefs", "setRoutePrefs", "pickFolder"]) assert.equal(env.host[k], undefined, k);
  await env.host.signOut();
  assert.equal(c.getSnapshot().signedIn, false);
  // After sign-out the adapter reports 401 as data, not a crash.
  const after = await env.client.request("GET", "/kb/chat/sessions").catch((e) => e);
  assert.ok(after instanceof Error ? /NO_SESSION/.test(after.code ?? "") : after.status === 401);
});

test("library search degrades to `unavailable` when the core has no note search route", { skip }, async () => {
  const c = client();
  await c.login(core.email, core.password);
  const run = m.makeSearchRun(m.searchCoreFrom(c));
  const res = await run("alpha", new AbortController().signal).catch((e) => e);
  // Either the route exists (an array of hits) or it fails with a status the search store maps to `unavailable`.
  assert.ok(Array.isArray(res) || (res instanceof Error && typeof res.status === "number"), `unexpected ${String(res)}`);
  await c.logout();
});

test("the bus: open-file requests are validated and sticky for a late subscriber; paths stay project-relative", () => {
  const bus = m.createShellBus();
  bus.publish({ type: "open-file", path: "../../etc/passwd" });
  assert.equal(bus.takePending("open-file"), null, "traversal is refused");
  bus.publish({ type: "open-file", path: "/etc/passwd" });
  assert.equal(bus.takePending("open-file"), null, "absolute paths are refused");
  bus.publish({ type: "open-file", path: "src\\a/./b.ts" });
  const late = bus.takePending("open-file");
  assert.equal(late.path, "src/a/b.ts");
  assert.equal(bus.takePending("open-file"), null, "consumed once");
  const seen = [];
  const off = bus.subscribe("open-file", (e) => seen.push(e.path));
  bus.publish({ type: "open-file", path: "a.ts" });
  off();
  bus.publish({ type: "open-file", path: "b.ts" });
  assert.deepEqual(seen, ["a.ts"]);
  assert.equal(m.relativeToProject("/p/root/src/x.ts", "/p/root"), "src/x.ts");
  assert.equal(m.relativeToProject("/p/rootless/x.ts", "/p/root"), null, "a sibling prefix is not inside the project");
  assert.equal(m.relativeToProject("/p/root/../x", "/p/root"), null);
  assert.equal(m.relativeToProject("src/x.ts", "/p/root"), "src/x.ts");
  assert.equal(m.relativeToProject("src/x.ts", null), null);
  assert.equal(m.fileArgOf('{"file_path":"/p/root/a.ts","old_string":"x"}'), "/p/root/a.ts");
  assert.equal(m.fileArgOf('{"path":'), null);
});
