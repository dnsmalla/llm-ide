import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSdkModel, SDK_TEXT, ToolPermissionsModel, UserPrefsModel, groupRules, ruleLabel, sdkLogText } from "../app-model.ts";
import { decodeAgentSdk, decodeAgentSdkUpdate, decodeToolPermissions, decodeUserPrefs, DecodeError } from "../decoders.ts";
import { serverRows } from "../notices.ts";
import { fakeClient, fixture, reply } from "./helpers.ts";

const r = (rel: string) => fixture(rel).response;

test("fixtures decode: tool permissions, SDK status, SDK update, prefs", () => {
  const p = decodeToolPermissions(r("agent/get-kb-agent-tool-approvals-200.json"));
  assert.equal(p.rules.length, 2);
  assert.equal(p.rules[0]!.pattern, "git log");
  assert.deepEqual(p.legacy.map((x) => x.toolName), ["WebSearch"]);
  const sdk = decodeAgentSdk(r("providers-usage/get-kb-agent-sdk-200-offline.json"));
  assert.equal(sdk.running, "0.3.301");
  assert.equal(sdk.latest, null);
  assert.equal(sdk.canUpdate, true);
  assert.match(sdk.error ?? "", /offline/);
  const up = decodeAgentSdkUpdate(r("providers-usage/post-kb-agent-sdk-update-200-turn-running.json"));
  assert.equal(up.ok, false);
  assert.match(up.log ?? "", /chat turn is running/);
  assert.equal(decodeUserPrefs(r("health-auth/get-auth-me-prefs-200.json")).language, null);
  assert.equal(decodeUserPrefs(r("health-auth/put-auth-me-prefs-200.json")).nativePlugins, true);
});

test("decoders reject wrong shapes instead of half-typing them", () => {
  assert.throws(() => decodeToolPermissions({ rules: "x" }), DecodeError);
  assert.throws(() => decodeToolPermissions({ rules: [{ projectRoot: 1 }] }), DecodeError);
  assert.deepEqual(decodeToolPermissions({}), { rules: [], legacy: [] }); // a server older than project rules
  assert.throws(() => decodeAgentSdkUpdate({}), DecodeError);
  assert.throws(() => decodeUserPrefs({}), DecodeError);
});

test("rules group by project in name order and read in words", () => {
  const p = decodeToolPermissions(r("agent/get-kb-agent-tool-approvals-200.json"));
  const more = [...p.rules, { projectRoot: "/a/first", toolName: "Edit", pattern: "", grantedAt: "2026-01-01T00:00:00Z" }];
  assert.deepEqual(groupRules(more).map((g) => g.project), ["/a/first", "/example/workspace"]);
  assert.equal(ruleLabel(more[0]!), "Bash: git log");
  assert.equal(ruleLabel(more[2]!), "Edit (any use)");
});

test("tool permissions: load, revoke one renders from the server's answer, a failed load is not 'nothing allowed'", async () => {
  const c = fakeClient({
    "GET /kb/agent/tool-approvals": () => reply("agent/get-kb-agent-tool-approvals-200.json"),
    "DELETE /kb/agent/tool-approvals": () => ({ status: 200, body: { rules: [], approvals: [], removed: 3 } }),
  });
  const m = new ToolPermissionsModel(c);
  await m.load();
  assert.equal(m.getState().perms.rules.length, 2);
  await m.revokeRule(m.getState().perms.rules[0]!);
  assert.deepEqual(c.calls.at(-1)!.body, { projectRoot: "/example/workspace", toolName: "Bash", pattern: "git log" });
  assert.equal(m.getState().perms.rules.length, 0);
  await m.revokeAll();
  assert.deepEqual(c.calls.at(-1)!.body, { all: true });

  const down = new ToolPermissionsModel(fakeClient({ "GET /kb/agent/tool-approvals": () => ({ status: 500, body: { error: { code: "X", message: "secret path /Users/me" } } }) }));
  await down.load();
  assert.equal(down.getState().loadFailed, true);
  assert.ok(!(down.getState().error ?? "").includes("/Users/me"));
});

test("agent SDK: status, forced check uses ?force=1, update refused while a turn runs, no update when remote access is on", async () => {
  const c = fakeClient({
    "GET /kb/agent-sdk": () => reply("providers-usage/get-kb-agent-sdk-200-offline.json"),
    "GET /kb/agent-sdk?force=1": () => reply("providers-usage/get-kb-agent-sdk-200-offline.json"),
    "POST /kb/agent-sdk/update": () => reply("providers-usage/post-kb-agent-sdk-update-200-turn-running.json"),
  });
  const m = new AgentSdkModel(c);
  await m.load(false);
  await m.load(true);
  assert.deepEqual(c.calls.map((x) => x.path), ["/kb/agent-sdk", "/kb/agent-sdk?force=1"]);
  await m.update();
  assert.equal(m.getState().result?.ok, false);
  assert.equal(c.calls.filter((x) => x.method === "POST").length, 1);

  const remote = fakeClient({ "GET /kb/agent-sdk": () => ({ status: 200, body: { running: "1", canUpdate: false, updateAvailable: true } }), "POST /kb/agent-sdk/update": () => ({ status: 200, body: {} }) });
  const m2 = new AgentSdkModel(remote);
  await m2.load();
  await m2.update();
  assert.equal(remote.calls.some((x) => x.method === "POST"), false);
  assert.ok(SDK_TEXT.confirmWord.length > 0);
});

test("SDK log is scrubbed, control characters dropped, and bounded", () => {
  const out = sdkLogText(`npm ok\u0007 sk-ant-api03-${"a".repeat(40)} ${"x".repeat(900)}`)!;
  assert.ok(!out.includes("sk-ant-api03"));
  assert.ok(!out.includes("\u0007"));
  assert.ok(out.length <= 604);
  assert.equal(sdkLogText(null), null);
});

test("preferences: a failed load stays unloaded and cannot save; a save sends the whole object and rolls back on failure", async () => {
  const bad = fakeClient({ "GET /auth/me/prefs": () => ({ status: 500, body: {} }) });
  const m0 = new UserPrefsModel(bad);
  await m0.load();
  assert.equal(m0.getState().prefs, null);
  await m0.setLanguage("ja");
  assert.equal(bad.calls.some((x) => x.method === "PUT"), false);

  let fail = false;
  const c = fakeClient({
    "GET /auth/me/prefs": () => ({ status: 200, body: { prefs: { language: "en", bilingual: true } } }),
    "PUT /auth/me/prefs": (b) => (fail ? { status: 500, body: {} } : { status: 200, body: { prefs: b } }),
  });
  const m = new UserPrefsModel(c);
  await m.load();
  await m.setLanguage("ja");
  assert.deepEqual(c.calls.at(-1)!.body, { language: "ja", bilingual: true });
  assert.equal(m.getState().prefs?.language, "ja");
  await m.setLanguage("klingon"); // not in the list: ignored
  assert.equal(c.calls.filter((x) => x.method === "PUT").length, 1);
  fail = true;
  await m.setNativePlugins(false);
  assert.equal(m.getState().prefs?.nativePlugins, null); // rolled back
  assert.ok(m.getState().error);
});

test("server rows: running, identity and log path; no answer is a warning, never 'running'", () => {
  const rows = serverRows({ appVersion: "1", coreTrust: "spawned", coreLogPath: "/l/core.log", platform: "mac" }, { status: "ok", apiVersion: 80, schemaVersion: 1, features: null, checks: { db: true, fts: false } });
  assert.equal(rows.find((x) => x.label === "Backend")!.value, "Running");
  assert.match(rows.find((x) => x.label === "Health checks")!.value, /Failing: fts/);
  assert.equal(rows.find((x) => x.label === "Log file")!.value, "/l/core.log");
  const none = serverRows(null, null);
  assert.equal(none[0]!.tone, "warning");
  assert.equal(none[0]!.value, "No answer");
});
