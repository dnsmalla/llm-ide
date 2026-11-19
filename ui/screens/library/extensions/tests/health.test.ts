import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionsApi } from "../api.ts";
import { DecodeError, decodeHealth, type HealthResult } from "../decoders.ts";
import { autoChecksOnOpen, checkedText, fixPlan, healthKey, onlyProblems, rowBadge, statusLine } from "../health-model.ts";
import { ExtensionsModel, filterItems } from "../model.ts";
import { LegacyModel, createLegacyApi, HEALTH_KIND } from "../legacy.ts";
import { fakeCore, fx, reply } from "./helpers.ts";

const P = "/auth/me/extensions";
const ok = (body: unknown) => ({ status: 200, body });
const res = (status: HealthResult["status"], over: Partial<HealthResult> = {}): HealthResult => ({ status, checkedAt: 1, problems: [], tools: [], ...over });

test("the check fixtures decode into the typed result", () => {
  const p = decodeHealth(fx("post-auth-me-extensions-check-200-problem").response);
  assert.equal(p.status, "problem");
  assert.deepEqual(p.problems[0], { code: "PROGRAM_MISSING", message: 'The program "npx" that this MCP server starts is not installed.', fix: "install-program", program: "npx" });
  const g = decodeHealth(fx("post-auth-me-extensions-check-200").response);
  assert.equal(g.status, "ok");
  assert.deepEqual(g.tools, [{ name: "list_issues", description: "List issues" }]);
});

test("a hostile check answer is refused or cleaned", () => {
  assert.throws(() => decodeHealth({ status: "great", checkedAt: 1, problems: [] }), DecodeError);
  assert.throws(() => decodeHealth({ status: "ok", problems: [] }), DecodeError);
  const r = decodeHealth({
    status: "problem",
    checkedAt: 5,
    problems: Array.from({ length: 50 }, () => ({ code: "X", message: "bad‮\u0000 <b>text</b>" + "a".repeat(2000), fix: "rm -rf", detail: { program: "np‮x" } })),
    tools: Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`, description: "d​" })),
  });
  assert.equal(r.problems.length, 10);
  assert.equal(r.tools.length, 48);
  assert.equal(r.problems[0]!.fix, "none"); // unknown fix: no button
  assert.ok(r.problems[0]!.message.length <= 300);
  assert.doesNotMatch(r.problems[0]!.message, /[‮\u0000]/);
  assert.equal(r.problems[0]!.program, "npx");
});

test("status wording for each status", () => {
  assert.equal(statusLine(undefined).text, "Not checked yet");
  assert.equal(statusLine(res("ok")).text, "Working");
  assert.equal(statusLine(res("problem")).text, "Problem");
  assert.equal(statusLine(res("unknown")).text, "Can't be checked here");
  assert.equal(statusLine(res("ok"), true).text, "Checking…");
  assert.equal(checkedText(undefined), "");
  assert.equal(checkedText(0, 180_000), "Checked 3 minutes ago");
  assert.equal(checkedText(0, 1000), "Checked just now");
});

test("every fix maps to its action; install-program shows the program and no button", () => {
  assert.deepEqual(fixPlan({ fix: "repair" }), { type: "button", action: "repair", label: "Repair" });
  assert.deepEqual(fixPlan({ fix: "consent" }), { type: "button", action: "consent", label: "Allow…" });
  assert.deepEqual(fixPlan({ fix: "switch-off" }), { type: "button", action: "switch-off", label: "Switch off" });
  assert.equal(fixPlan({ fix: "set-credential" }).type, "text");
  assert.deepEqual(fixPlan({ fix: "install-program", program: "uvx" }), { type: "text", text: "Install uvx, then press Check." });
  assert.deepEqual(fixPlan({ fix: "none" }), { type: "none" });
});

test("auto check on open: never for a program-starting item", () => {
  assert.equal(autoChecksOnOpen("mcp", true), false);
  assert.equal(autoChecksOnOpen("catalog", true), false);
  assert.equal(autoChecksOnOpen("catalog", false), true);
  assert.equal(autoChecksOnOpen("plugin", false), true);
  assert.equal(autoChecksOnOpen("skill-kit", false), true);
});

test("row badge and the Problems filter use only known results", () => {
  assert.equal(rowBadge(undefined), null);
  assert.equal(rowBadge(res("ok")), null);
  assert.equal(rowBadge(res("unknown")), null);
  assert.equal(rowBadge(res("problem")), "Problem");
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const health = { [healthKey("catalog", "a")]: res("problem"), [healthKey("catalog", "b")]: res("ok") };
  assert.deepEqual(onlyProblems(items, health, () => "catalog").map((i) => i.id), ["a"]);
});

test("model: Check sends force, keeps the result, and the Problems filter shows only problem rows", async () => {
  const bodies: unknown[] = [];
  const core = fakeCore({
    [`GET ${P}/installed`]: () => reply("get-auth-me-extensions-installed-200-2"),
    [`GET ${P}/active`]: () => reply("get-auth-me-extensions-active-200"),
    [`POST ${P}/check`]: (c) => { bodies.push(c.body); return reply("post-auth-me-extensions-check-200-problem"); },
  });
  const model = new ExtensionsModel(createExtensionsApi(core));
  await model.init();
  const first = model.getSnapshot().items[0]!;
  assert.equal(filterItems(model.getSnapshot().items, "", { only: true, health: model.getSnapshot().health }).length, 0);
  await model.check(first.id);
  assert.deepEqual(bodies[0], { kind: "catalog", id: first.id, force: true });
  const s = model.getSnapshot();
  assert.equal(s.health[healthKey("catalog", first.id)]?.status, "problem");
  assert.deepEqual(filterItems(s.items, "", { only: true, health: s.health }).map((i) => i.id), [first.id]);
  assert.equal(s.healthChecking.length, 0);
});

test("model: after a fix a known result is checked again; an unchecked item is not", async () => {
  let n = 0;
  const core = fakeCore({
    [`GET ${P}/installed`]: () => reply("get-auth-me-extensions-installed-200-2"),
    [`GET ${P}/active`]: () => reply("get-auth-me-extensions-active-200"),
    [`POST ${P}/toggle`]: () => reply("post-auth-me-extensions-toggle-200"),
    [`POST ${P}/check`]: () => { n++; return ok({ status: "ok", checkedAt: 2, problems: [] }); },
  });
  const model = new ExtensionsModel(createExtensionsApi(core));
  await model.init();
  const item = model.getSnapshot().items.find((i) => i.id === "skill:acme/tidy")!;
  await model.disable(item);
  assert.equal(n, 0);
  await model.check(item.id);
  await model.disable(item);
  assert.equal(n, 2);
});

test("legacy model: the check uses the kind of its pane and the shared decoder", async () => {
  const bodies: unknown[] = [];
  const core = fakeCore({ [`POST ${P}/check`]: (c) => { bodies.push(c.body); return reply("post-auth-me-extensions-check-200"); } });
  const model = new LegacyModel(createLegacyApi(core), "mcp-plugins");
  await model.check("linear");
  assert.deepEqual(bodies[0], { kind: "mcp", id: "linear", force: true });
  assert.equal(model.getSnapshot().health[healthKey("mcp", "linear")]?.tools.length, 1);
  assert.deepEqual(HEALTH_KIND, { plugins: "plugin", "llm-sources": "skill-kit", "mcp-plugins": "mcp" });
});

test("opening a row checks a plugin or skill kit on its own, an MCP server only on the button", async () => {
  const hits: unknown[] = [];
  const core = fakeCore({
    [`GET /auth/me/plugins`]: () => ok({ plugins: [{ name: "runner", displayName: "Runner", version: "1", enabled: true, format: "claude", skillCount: 0, hookCount: 0, mcpServerCount: 0, commands: [], subagents: [], unsupportedComponents: [], pendingComponents: [] }] }),
    [`POST ${P}/check`]: (c) => { hits.push(c.body); return reply("post-auth-me-extensions-check-200"); },
  });
  const plugins = new LegacyModel(createLegacyApi(core), "plugins");
  await plugins.load();
  plugins.select("runner");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(hits, [{ kind: "plugin", id: "runner" }]);
});

// ---- catalog automatic checks, re-check and bulk rules ------------------------------------------------
const withMcp = (i: any) => ({ ...i, members: [...i.members, { memberId: "mcp:srv", type: "mcp", name: "srv", executable: true }], declared: { executableKinds: ["mcp"] } });
function catalogSetup() {
  const base: any[] = structuredClone((fx("get-auth-me-extensions-installed-200-2").response as { items: any[] }).items);
  let items = base;
  const checksSeen: unknown[] = [];
  const core = fakeCore({
    [`GET ${P}/installed`]: () => ok({ corrupt: false, items }),
    [`GET ${P}/active`]: () => reply("get-auth-me-extensions-active-200"),
    [`POST ${P}/toggle`]: (c) => (() => { const it = items.find((i) => i.id === (c.body as any).id); return ok({ ok: true, item: { ...it, state: { ...it.state, enabled: (c.body as any).enabled } } }); })(),
    [`POST ${P}/check`]: (c) => { checksSeen.push(c.body); return ok({ status: "ok", checkedAt: 2, problems: [] }); },
  });
  const model = new ExtensionsModel(createExtensionsApi(core));
  return { model, checksSeen, setItems: (n: any[]) => (items = n), base };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("selecting a catalog item with an MCP member sends no check; a skill item is checked", async () => {
  const { model, checksSeen, setItems, base } = catalogSetup();
  const skill = base.find((i) => i.kind === "skill")!;
  setItems([withMcp(base.find((i) => i.kind === "plugin")!), skill]);
  await model.init();
  model.select(base.find((i) => i.kind === "plugin")!.id);
  await settle();
  assert.equal(checksSeen.length, 0);
  model.select(skill.id);
  await settle();
  assert.deepEqual(checksSeen, [{ kind: "catalog", id: skill.id }]);
});

test("an item auto-checked as a skill that gains an MCP server is not re-checked after a fix; its result is cleared", async () => {
  const { model, checksSeen, setItems, base } = catalogSetup();
  const skill = base.find((i) => i.kind === "skill")!;
  await model.init();
  model.select(skill.id);
  await settle();
  assert.equal(checksSeen.length, 1);
  setItems([withMcp(skill)]);
  await model.loadInstalled();
  assert.ok(model.getSnapshot().health[healthKey("catalog", skill.id)]);
  await model.disable(model.item(skill.id)!);
  assert.equal(checksSeen.length, 1, "no check request");
  assert.equal(model.getSnapshot().health[healthKey("catalog", skill.id)], undefined);
});

test("bulk switching sends no check and clears the switched items' results", async () => {
  const { model, checksSeen, base } = catalogSetup();
  await model.init();
  const target = model.getSnapshot().items.find((i) => i.id === "skill:acme/tidy")!;
  await model.check(target.id);
  const n = checksSeen.length;
  model.toggleChecked(target.id);
  await model.bulkSwitch(!target.enabled);
  assert.equal(checksSeen.length, n);
  assert.equal(model.getSnapshot().health[healthKey("catalog", target.id)], undefined);
  void base;
});

test("a failed automatic check shows no notice and is not retried; a pressed Check reports the failure", async () => {
  const core = fakeCore({
    [`GET ${P}/installed`]: () => reply("get-auth-me-extensions-installed-200-2"),
    [`GET ${P}/active`]: () => reply("get-auth-me-extensions-active-200"),
  });
  const model = new ExtensionsModel(createExtensionsApi(core));
  await model.init();
  const skill = model.getSnapshot().items.find((i) => i.kind === "skill")!;
  model.select(skill.id); await settle();
  assert.equal(model.getSnapshot().notice, null);
  model.select(null); model.select(skill.id); await settle();
  assert.equal(core.calls.filter((c) => c.path === `${P}/check`).length, 1);
  await model.check(skill.id);
  assert.ok(model.getSnapshot().notice?.error);
});

test("results of items no longer installed are dropped on reload", async () => {
  const { model, setItems, base } = catalogSetup();
  await model.init();
  const a = model.getSnapshot().items[0]!;
  await model.check(a.id);
  setItems(base.filter((i) => i.id !== a.id));
  await model.loadInstalled();
  assert.equal(model.getSnapshot().health[healthKey("catalog", a.id)], undefined);
});
