import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { SecretField, keyStatusLabel, scrubSecrets } from "../secret-field.ts";
import {
  CLAUDE_COMPATIBLE_ID, CLAUDE_COMPATIBLE_CATALOG_ID, CLAUDE_COMPATIBLE_LIMITS, CLAUDE_COMPATIBLE_PROVIDER, CLAUDE_KIND_LABEL, OPENAI_KIND_LABEL, describeClaudeConnectError, rowsFromCustom, slugOfRow, ProvidersApi, ProvidersModel, addChoices, buildConnectBody, cleanFallback, describeTest,
  newConnectForm, rowsFromCatalog, sortModels, toolsBadge, validateConnect,
} from "../providers-model.ts";
import { ApiError } from "../core-api.ts";
import { decodeCatalog, decodeConnectResult, decodeCustomEndpoints, decodeModelList, decodeTestResult, type Catalog, type CatalogProvider } from "../decoders.ts";
import { fakeClient, fixture, reply, deferred } from "./helpers.ts";
import { filterBy, windowRange } from "../virtual.ts";

const catalogBody = (): unknown => ({
  providers: (fixture("provider-catalog/get-kb-providers-catalog-200.json").response as { providers: unknown[] }).providers,
  settings: fixture("provider-catalog/get-kb-providers-settings-200.json").response,
});
const catalog = (): Catalog => decodeCatalog(catalogBody());
const prov = (id: string): CatalogProvider => catalog().providers.find((p) => p.id === id)!;

test("SecretField is write-only: take() clears, and it never serialises or inspects its value", () => {
  const f = new SecretField();
  f.set("sk-live-very-secret-1234");
  assert.deepEqual(f.state, { length: 24, filled: true });
  assert.ok(!JSON.stringify({ f }).includes("very"));
  assert.ok(!inspect(f).includes("very"));
  assert.ok(!`${f}`.includes("very"));
  assert.equal(f.take(), "sk-live-very-secret-1234");
  assert.equal(f.take(), "");
  assert.equal(f.state.filled, false);
});

test("key status words come from hasKey only", () => {
  assert.equal(keyStatusLabel(true, true), "Key stored");
  assert.equal(keyStatusLabel(false, true), "Key missing");
  assert.equal(keyStatusLabel(null, true), "Unknown");
  assert.equal(keyStatusLabel(false, false), "No key needed");
});

test("scrubSecrets redacts provider keys, bearer tokens, JWTs and key=value pairs", () => {
  const s = scrubSecrets("key sk-fixture-not-a-real-key-000000 and Bearer abcdef123456789 and eyJhbGciOi.eyJzdWIi.sig and api_key=hunter22 ok");
  assert.ok(!/sk-fixture|abcdef1234|eyJhbGci|hunter22/.test(s), s);
  assert.match(s, /ok$/);
});

test("rows: one per connection, with the adapter label; claude-compatible is disabled with a reason on a core without the route", () => {
  const rows = rowsFromCatalog(catalog());
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.kindLabel === OPENAI_KIND_LABEL));
  const claude = addChoices(catalog()).find((c) => c.id === CLAUDE_COMPATIBLE_ID)!;
  assert.equal(claude.available, false);
  assert.match(claude.unavailableReason!, /too old/);
  assert.equal(addChoices(catalog(), true).find((c) => c.id === CLAUDE_COMPATIBLE_ID)!.available, true);
  assert.match(claude.kindLabel, /Claude-compatible/);
});

test("validateConnect: key required, address rules, slug rules", () => {
  const openai = prov("openai");
  const f = newConnectForm("openai");
  assert.match(validateConnect(openai, f)[0]!.message, /needs an API key/);
  f.apiKey.set("k");
  assert.deepEqual(validateConnect(openai, f), []);
  const gw = prov("openai-compatible");
  const g = newConnectForm("openai-compatible");
  g.apiKey.set("k");
  assert.equal(validateConnect(gw, g)[0]!.field, "baseURL");
  g.baseURL = "http://192.168.1.20:3001/v1";
  assert.match(validateConnect(gw, g)[0]!.message, /private-network/);
  g.allowPrivate = true;
  assert.deepEqual(validateConnect(gw, g), []);
  g.baseURL = "https://user:pw@gw.example.com/v1";
  assert.match(validateConnect(gw, g)[0]!.message, /user name or password/);
  g.baseURL = "https://gw.example.com/v1";
  g.slug = "Bad Slug";
  assert.equal(validateConnect(gw, g)[0]!.field, "slug");
  const local = prov("ollama");
  assert.ok(!validateConnect(local, newConnectForm("ollama")).some((i) => i.field === "apiKey"));
});

test("copy-key is offered only for the legacy ids and sends copyKeyFrom instead of a key", () => {
  const f = newConnectForm("openai");
  f.copyKey = true;
  assert.deepEqual(validateConnect(prov("openai"), f), []);
  assert.deepEqual(buildConnectBody(prov("openai"), f), { catalogId: "openai", copyKeyFrom: "openai" });
  const g = newConnectForm("groq");
  g.copyKey = true;
  assert.match(validateConnect(prov("groq"), g)[0]!.message, /needs an API key/);
});

test("buildConnectBody takes the key out of the field", () => {
  const f = newConnectForm("groq");
  f.apiKey.set("sk-x");
  const body = buildConnectBody(prov("groq"), f);
  assert.equal(body.apiKey, "sk-x");
  assert.equal(f.apiKey.state.filled, false);
});

test("connect flow: the key goes in the POST body once, never in the path, and no state keeps it", async () => {
  const client = fakeClient({
    "GET /kb/providers/catalog": () => ({ status: 200, body: catalogBody() }),
    "POST /kb/providers/catalog/connect": () => reply("provider-catalog/post-kb-providers-catalog-connect-200.json"),
  });
  const m = new ProvidersModel(new ProvidersApi(client));
  await m.load();
  const form = newConnectForm("groq");
  form.apiKey.set("sk-fixture-not-a-real-key-000000");
  assert.equal(await m.connect(prov("groq"), form), true);
  const post = client.calls.find((c) => c.method === "POST")!;
  assert.equal((post.body as { apiKey: string }).apiKey, "sk-fixture-not-a-real-key-000000");
  for (const c of client.calls) assert.ok(!c.path.includes("sk-"), c.path);
  assert.ok(!JSON.stringify(m.getState()).includes("sk-fixture"));
  assert.equal(form.apiKey.state.filled, false);
  assert.equal(m.getState().adding, false);
});

test("a refused connect shows a plain sentence and clears the key", async () => {
  const client = fakeClient({ "POST /kb/providers/catalog/connect": () => reply("provider-catalog/post-kb-providers-catalog-connect-409-limit.json") });
  const m = new ProvidersModel(new ProvidersApi(client));
  const form = newConnectForm("groq");
  form.apiKey.set("sk-secret-secret-1");
  assert.equal(await m.connect(prov("groq"), form), false);
  assert.match(m.getState().error!, /most provider connections/);
  assert.equal(form.apiKey.state.filled, false);
  assert.ok(!JSON.stringify(m.getState()).includes("secret"));
});

test("invalid form never reaches the network", async () => {
  const client = fakeClient({});
  const m = new ProvidersModel(new ProvidersApi(client));
  assert.equal(await m.connect(prov("openai"), newConnectForm("openai")), false);
  assert.equal(client.calls.length, 0);
  assert.match(m.getState().error!, /needs an API key/);
});

test("remove needs the connection's name typed; a wrong name does nothing", async () => {
  const client = fakeClient({
    "GET /kb/providers/catalog": () => ({ status: 200, body: catalogBody() }),
    "POST /kb/providers/catalog/disconnect": () => reply("provider-catalog/post-kb-providers-catalog-disconnect-200.json"),
  });
  const m = new ProvidersModel(new ProvidersApi(client));
  await m.load();
  const row = m.getState().rows[0]!;
  m.requestRemove(row);
  assert.equal(await m.confirmRemove("nope"), false);
  assert.equal(client.calls.filter((c) => c.path.endsWith("disconnect")).length, 0);
  assert.equal(await m.confirmRemove(`  ${row.name} `), true);
  assert.deepEqual(client.calls.find((c) => c.path.endsWith("disconnect"))!.body, { id: row.id });
  assert.equal(m.getState().pendingRemove, null);
});

test("a load that finishes after a newer one (or after a change) is dropped", async () => {
  const first = deferred<{ status: number; body: unknown }>();
  let n = 0;
  const client = fakeClient({
    "GET /kb/providers/catalog": () => (n++ === 0 ? first.promise : { status: 200, body: { providers: [], settings: fixture("provider-catalog/get-kb-providers-settings-200-defaults.json").response } }),
  });
  const m = new ProvidersModel(new ProvidersApi(client));
  const slow = m.load();
  await m.load();
  assert.equal(m.getState().rows.length, 0);
  first.resolve({ status: 200, body: catalogBody() });
  await slow;
  assert.equal(m.getState().rows.length, 0, "the stale answer did not overwrite the newer one");
});

test("a failed reload keeps the previous list and shows a sentence", async () => {
  let ok = true;
  const client = fakeClient({ "GET /kb/providers/catalog": () => (ok ? { status: 200, body: catalogBody() } : { status: 500, body: {} }) });
  const m = new ProvidersModel(new ProvidersApi(client));
  await m.load();
  const count = m.getState().rows.length;
  ok = false;
  await m.load();
  assert.equal(m.getState().rows.length, count);
  assert.equal(m.getState().phase, "ready");
  assert.match(m.getState().error!, /backend hit an error/);
});

test("test result: the server detail is scrubbed and only shown as technical detail", () => {
  const refused = describeTest(decodeTestResult(fixture("provider-catalog/post-kb-providers-catalog-test-200-refused.json").response));
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /did not accept the check/);
  const leak = describeTest({ ok: false, detail: "HTTP 401 for key sk-abcdefghij123456 refused" });
  assert.ok(!leak.detail.includes("sk-abcdef"));
  assert.match(describeTest({ ok: true, detail: "x", modelCount: 1 }).summary, /1 chat model available/);
});

test("model list helpers: badges, tools-first order", () => {
  const list = decodeModelList(fixture("provider-catalog/post-kb-providers-catalog-models-200-live.json").response);
  assert.equal(toolsBadge(list.models[0]!), "tools (yours)");
  assert.equal(toolsBadge({ ...list.models[0]!, toolsSupported: false }), null);
  const sorted = sortModels([{ ...list.models[0]!, id: "z", toolsSupported: false }, { ...list.models[1]!, id: "a" }]);
  assert.equal(sorted[0]!.id, "a");
});

test("fallback order keeps only connected providers, once each", () => {
  const out = cleanFallback([{ provider: "custom:a" }, { provider: "custom:a" }, { provider: "custom:gone", model: "m" }, { provider: "custom:b", model: "m" }], new Set(["custom:a", "custom:b"]));
  assert.deepEqual(out, [{ provider: "custom:a" }, { provider: "custom:b", model: "m" }]);
});

test("virtual window: 5,000 rows render a small slice; clamps at both ends", () => {
  const w = windowRange({ total: 5000, rowHeight: 40, scrollTop: 40_000, viewportHeight: 400, overscan: 5 });
  assert.equal(w.start, 995);
  assert.equal(w.end, 1015);
  assert.equal(w.padTop + (w.end - w.start) * 40 + w.padBottom, w.totalHeight);
  assert.deepEqual(windowRange({ total: 0, rowHeight: 40, scrollTop: 0, viewportHeight: 400 }).end, 0);
  const tail = windowRange({ total: 100, rowHeight: 10, scrollTop: 99_999, viewportHeight: 100 });
  assert.equal(tail.end, 100);
  assert.ok(tail.start >= 0 && tail.start <= tail.end);
  assert.equal(windowRange({ total: 10, rowHeight: 10, scrollTop: -50, viewportHeight: 30 }).start, 0);
});

test("1,000+ connections: rows build and filter quickly", () => {
  const providers = [{
    id: "openai-compatible", name: "Other", baseURL: "", keyRequired: true, local: false, customBaseURL: true, allowPrivate: false, docsUrl: "", notes: "",
    connections: Array.from({ length: 5000 }, (_, i) => ({ id: `cat-openai-compatible-c${i}`, provider: `custom:cat-openai-compatible-c${i}`, catalogId: "openai-compatible", name: `Gateway ${i}`, baseURL: `https://g${i}.example.com/v1`, allowPrivate: false, enabled: true, hasKey: i % 2 === 0 })),
  }];
  const t0 = performance.now();
  const rows = rowsFromCatalog({ providers, settings: catalog().settings });
  const hit = filterBy(rows, "gateway 4999", (r) => r.name);
  assert.equal(rows.length, 5000);
  assert.equal(hit.length, 1);
  assert.ok(performance.now() - t0 < 500);
});

// ---- Claude-compatible endpoints (core API 99) ------------------------------------------------

const customBody = (): unknown => fixture("provider-catalog/get-kb-providers-custom-200.json").response;
const catalogRoutes = () => ({
  "GET /kb/providers/catalog": () => ({ status: 200, body: catalogBody() }),
  "GET /kb/providers/settings": () => reply("provider-catalog/get-kb-providers-settings-200.json"),
});

test("custom endpoint fixtures decode: managed and synced, never a key; strict on shape", () => {
  const list = decodeCustomEndpoints(customBody());
  assert.deepEqual(list.map((e) => [e.id, e.source, e.hasKey]), [["ac-glm", "connection", true], ["zai", "synced", true]]);
  assert.deepEqual(decodeCustomEndpoints(fixture("provider-catalog/get-kb-providers-custom-200-empty.json").response), []);
  // Only the listed fields survive: a key-shaped field a hostile core adds is dropped.
  const withKey = decodeCustomEndpoints({ providers: [{ ...(customBody() as { providers: object[] }).providers[0], apiKey: "sk-leak-0000000000", token: "t" }] });
  assert.ok(!JSON.stringify(withKey).includes("sk-leak"));
  assert.throws(() => decodeCustomEndpoints({ providers: [{ ...(customBody() as { providers: object[] }).providers[0], source: "mac" }] }), /source/);
  assert.throws(() => decodeCustomEndpoints({ providers: [{ id: "x" }] }));
  assert.throws(() => decodeCustomEndpoints({ providers: "no" }));
  const conn = decodeConnectResult(fixture("provider-catalog/post-kb-providers-catalog-connect-200-claude-compatible.json").response);
  assert.deepEqual([conn.id, conn.provider, conn.catalogId], ["ac-glm", "custom:ac-glm", "anthropic-compatible"]);
});

test("rows from custom endpoints: Claude label, synced ones read-only, slug from the id", () => {
  const rows = rowsFromCustom(decodeCustomEndpoints(customBody()));
  assert.ok(rows.every((r) => r.kindLabel === CLAUDE_KIND_LABEL && r.catalogId === CLAUDE_COMPATIBLE_CATALOG_ID));
  assert.equal(rows[0]!.readOnly, undefined);
  assert.equal(rows[1]!.readOnly, true);
  assert.equal(slugOfRow(rows[0]!), "glm");
  assert.equal(slugOfRow({ ...rows[0]!, id: "ac-default" }), "default");
  assert.equal(slugOfRow({ ...rows[0]!, catalogId: "groq", id: "cat-groq" }), null);
  assert.equal(slugOfRow({ ...rows[0]!, catalogId: "openai-compatible", id: "cat-openai-compatible-home" }), "home");
});

test("load: catalog rows plus Claude-compatible rows; a core without the route (404) keeps the catalog and offers nothing", async () => {
  const withRoute = fakeClient({ ...catalogRoutes(), "GET /kb/providers/custom": () => ({ status: 200, body: customBody() }) });
  const m = new ProvidersModel(new ProvidersApi(withRoute));
  await m.load();
  const st = m.getState();
  assert.equal(st.phase, "ready");
  assert.equal(st.customRoute, "ok");
  assert.ok(st.rows.some((r) => r.id === "ac-glm") && st.rows.some((r) => r.id === "zai" && r.readOnly));
  assert.equal(addChoices(st.catalog!, st.customRoute === "ok").find((c) => c.id === CLAUDE_COMPATIBLE_ID)!.available, true);

  const old = new ProvidersModel(new ProvidersApi(fakeClient(catalogRoutes())));
  await old.load();
  assert.equal(old.getState().phase, "ready");
  assert.equal(old.getState().customRoute, "unsupported");
  assert.equal(old.getState().custom.length, 0);
  assert.equal(old.getState().error, null, "an older core is not an error");

  const broken = new ProvidersModel(new ProvidersApi(fakeClient({ ...catalogRoutes(), "GET /kb/providers/custom": () => ({ status: 500, body: { error: { code: "X" } } }) })));
  await broken.load();
  assert.equal(broken.getState().phase, "ready");
  assert.equal(broken.getState().customRoute, "failed");
});

test("connect a Claude-compatible endpoint: the request carries catalogId anthropic-compatible, the key once, then the field is empty", async () => {
  let connected = false;
  const client = fakeClient({
    ...catalogRoutes(),
    "GET /kb/providers/custom": () => ({ status: 200, body: connected ? customBody() : { providers: [] } }),
    "POST /kb/providers/catalog/connect": () => { connected = true; return reply("provider-catalog/post-kb-providers-catalog-connect-200-claude-compatible.json"); },
  });
  const m = new ProvidersModel(new ProvidersApi(client));
  await m.load();
  const f = newConnectForm(CLAUDE_COMPATIBLE_PROVIDER.id);
  f.apiKey.set("sk-fixture-not-a-real-key-000000");
  f.baseURL = "https://gw.example.com/anthropic";
  f.slug = "glm";
  f.name = "GLM gateway";
  assert.equal(await m.connect(CLAUDE_COMPATIBLE_PROVIDER, f), true);
  const sent = client.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(sent.body, { catalogId: "anthropic-compatible", apiKey: "sk-fixture-not-a-real-key-000000", baseURL: "https://gw.example.com/anthropic", slug: "glm", name: "GLM gateway" });
  assert.equal(f.apiKey.state.filled, false, "the key left the field");
  assert.ok(m.getState().rows.some((r) => r.id === "ac-glm"));
  assert.ok(!JSON.stringify(m.getState()).includes("sk-fixture"), "no key in the model state");
});

test("Claude-compatible form: key and an https address are required; http needs the private-network opt-in", () => {
  const f = newConnectForm(CLAUDE_COMPATIBLE_PROVIDER.id);
  assert.match(validateConnect(CLAUDE_COMPATIBLE_PROVIDER, f)[0]!.message, /needs an API key/);
  f.apiKey.set("k");
  assert.equal(validateConnect(CLAUDE_COMPATIBLE_PROVIDER, f)[0]!.field, "baseURL");
  f.baseURL = "http://10.0.0.5:11434";
  assert.match(validateConnect(CLAUDE_COMPATIBLE_PROVIDER, f)[0]!.message, /private-network/);
  f.allowPrivate = true;
  assert.deepEqual(validateConnect(CLAUDE_COMPATIBLE_PROVIDER, f), []);
});

test("a refused Claude-compatible connect is explained in plain words, without the server's text", async () => {
  const client = fakeClient({
    ...catalogRoutes(),
    "GET /kb/providers/custom": () => ({ status: 200, body: { providers: [] } }),
    "POST /kb/providers/catalog/connect": () => ({ status: 400, body: { error: { code: "VALIDATION_FAILED", message: "Base URL host is a link-local address 169.254.169.254 sk-secret" } } }),
  });
  const m = new ProvidersModel(new ProvidersApi(client));
  await m.load();
  const f = newConnectForm(CLAUDE_COMPATIBLE_PROVIDER.id);
  f.apiKey.set("k");
  f.baseURL = "https://gw.example.com/anthropic";
  assert.equal(await m.connect(CLAUDE_COMPATIBLE_PROVIDER, f), false);
  const err = m.getState().error!;
  assert.match(err, /operator setting/);
  assert.ok(!/169\.254|sk-secret/.test(err));
  assert.equal(describeClaudeConnectError(new ApiError(409, "LIMIT")), "You have reached the most provider connections one account can have. Remove one first.");
});

test("a managed endpoint can be tested, switched off and removed through the catalog routes; a synced one is read-only", async () => {
  const client = fakeClient({
    ...catalogRoutes(),
    "GET /kb/providers/custom": () => ({ status: 200, body: customBody() }),
    "POST /kb/providers/catalog/test": (b) => ({ status: 200, body: { ok: true, detail: "ok sk-fixture-not-a-real-key-000000", modelCount: 3 } }),
    "POST /kb/providers/catalog/connect": () => reply("provider-catalog/post-kb-providers-catalog-connect-200-claude-compatible.json"),
    "POST /kb/providers/catalog/disconnect": () => ({ status: 200, body: { ok: true, removed: true } }),
  });
  const m = new ProvidersModel(new ProvidersApi(client));
  await m.load();
  const managed = m.getState().rows.find((r) => r.id === "ac-glm")!;
  const synced = m.getState().rows.find((r) => r.id === "zai")!;
  await m.test(managed);
  assert.deepEqual(client.calls.find((c) => c.path.endsWith("/test"))!.body, { id: "ac-glm" });
  assert.ok(!JSON.stringify(m.getState().testResults).includes("sk-fixture"), "the test detail is scrubbed");
  await m.setEnabled(managed, false);
  assert.deepEqual(client.calls.find((c) => c.path.endsWith("/connect"))!.body, { catalogId: "anthropic-compatible", name: "GLM gateway", enabled: false, baseURL: "https://gw.example.com/anthropic", slug: "glm" });
  const before = client.calls.length;
  await m.test(synced);
  await m.setEnabled(synced, false);
  m.requestRemove(synced);
  assert.equal(client.calls.length, before, "no request for a synced endpoint");
  assert.equal(m.getState().pendingRemove, null);
  m.requestRemove(managed);
  assert.equal(await m.confirmRemove("GLM gateway"), true);
  assert.deepEqual(client.calls.find((c) => c.path.endsWith("/disconnect"))!.body, { id: "ac-glm" });
});

test("the plain-language limits name each real restriction", () => {
  const text = CLAUDE_COMPATIBLE_LIMITS.join(" ");
  assert.match(text, /one-shot completions/);
  assert.match(text, /model tier roles/);
  assert.match(text, /connects to the address itself/);
  assert.match(text, /operator setting/);
});
