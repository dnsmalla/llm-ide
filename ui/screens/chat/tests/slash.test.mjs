import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, fakeCore, CHAT, REPO } from "./helpers.mjs";

let c, ext;
before(async () => {
  c = await loadChat("slash");
  ext = await import(join(REPO, "scripts/extract-chat-slash-builtins.mjs"));
});

const asJson = (b) => ({ label: b.label, aliases: [...b.aliases], description: b.description, insert: b.insert, action: b.action.kind === "openSection" ? { kind: "openSection", section: b.action.section } : { kind: b.action.kind } });

test("built-ins match the Swift list (drift guard)", () => {
  const swift = ext.extractBuiltins();
  assert.deepEqual(c.BUILTINS.map(asJson), swift, "slash/builtins.ts drifted from ChatSlashCommands.builtins; update the port and fixture");
  const fixture = JSON.parse(readFileSync(join(CHAT, "slash/fixtures/builtins.swift.json"), "utf8"));
  assert.deepEqual(fixture, swift, "run: node scripts/extract-chat-slash-builtins.mjs --write ui/screens/chat/slash/fixtures/builtins.swift.json");
});

test("the extractor notices a changed Swift list", () => {
  const src = readFileSync(ext.SWIFT_SOURCE, "utf8");
  const changed = ext.extractBuiltins(src.replace('description: "Open Settings"', 'description: "Open the Settings"'));
  assert.notDeepEqual(c.BUILTINS.map(asJson), changed);
  const added = ext.extractBuiltins(src.replace('Builtin(label: "/hooks"', 'Builtin(label: "/zap", description: "x", action: .clearChat),\n        Builtin(label: "/hooks"'));
  assert.equal(added.length, c.BUILTINS.length + 1);
  assert.throws(() => ext.extractBuiltins("nothing here"));
});

test("built-in recognisers: case and whitespace tolerant, aliases, /model argument", () => {
  assert.deepEqual(c.parseBuiltin("  /CLEAR "), { kind: "clearChat" });
  assert.deepEqual(c.parseBuiltin("/new"), { kind: "clearChat" });
  assert.deepEqual(c.parseBuiltin("/settings"), { kind: "openSection", section: "settings" });
  assert.deepEqual(c.parseBuiltin("/model  sonnet "), { kind: "switchModel", argument: "sonnet" });
  assert.deepEqual(c.parseBuiltin("/model"), { kind: "switchModel", argument: "" });
  assert.equal(c.parseBuiltin("/clear now"), null);
  assert.equal(c.parseBuiltin("/modelx"), null);
  assert.equal(c.parseBuiltin("hello /clear"), null);
  assert.ok(c.RESERVED_NAMES.has("/reset") && c.RESERVED_NAMES.has("/plugins"));
  assert.equal(c.builtinDetail(c.BUILTINS[0]), "Clear this conversation (aliases: /reset, /new)");
});

test("sanitize: text only, bidi and controls removed, capped", () => {
  const evil = "A\u202Eevil\u2066x\u2069\u200B\u0007\nline2\u2028end\uFEFF";
  const s = c.safeLine(evil);
  assert.equal(s, "Aevilx line2 end");
  assert.ok(!/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u0000-\u001F\u2028\u2029\uFEFF]/.test(s));
  assert.equal(c.safeLine("x".repeat(500), 50).length, 50);
  assert.ok(c.safeLine("x".repeat(500), 50).endsWith("…"));
  assert.equal(c.safeLine(42), "");
  assert.equal(c.safeLine("<script>alert(1)</script>"), "<script>alert(1)</script>"); // text stays text; React escapes it
  assert.equal(c.safeToken("summary"), "summary");
  assert.equal(c.safeToken("a b"), null);
  assert.equal(c.safeToken("/etc"), null);
  assert.equal(c.safeToken("x".repeat(65)), null);
  assert.equal(c.ownedDetail("acme", "does things"), "acme · does things");
  assert.equal(c.ownedDetail("", "does things"), "does things");
  assert.equal(c.safeLine("y".repeat(5_000_000), 80).length, 80); // a huge value costs O(cap)
});

test("rank: prefix, contains, subsequence, description tiers; stable; empty keeps order", () => {
  const mk = (label, detail = "") => c.item("skill", `s:${label}`, label, detail);
  const pool = [mk("graph-skill"), mk("sum"), mk("summary"), mk("assume"), mk("other", "about summary"), mk("zzz")];
  assert.deepEqual(c.rank(pool, "sum").map((x) => x.label), ["sum", "summary", "assume", "other"]);
  assert.deepEqual(c.rank(pool, "gsk").map((x) => x.label), ["graph-skill"]); // subsequence
  assert.deepEqual(c.rank(pool, "").map((x) => x.label), pool.map((x) => x.label));
  assert.deepEqual(c.rank(pool, "nomatch"), []);
  assert.equal(c.bestIndex(c.rank(pool, "sum"), "sum"), 0);
  assert.equal(c.isSubsequence("abc", "aXbXc"), true);
  assert.equal(c.isSubsequence("abc", "acb"), false);
});

test("rank: 5,000 entries rank in a frame", () => {
  const pool = Array.from({ length: 5000 }, (_, i) => c.item("skill", `s${i}`, `skill-${i}-${i % 7 ? "alpha" : "beta"}`, `description number ${i}`));
  const t0 = performance.now();
  for (const q of ["s", "sk", "alpha", "beta-3", "descr", "zq"]) c.rank(pool, q);
  const per = (performance.now() - t0) / 6;
  assert.ok(per < 25, `rank took ${per.toFixed(1)} ms per query`);
});

test("trigger detection: leading slash without whitespace, last token with @", () => {
  assert.deepEqual(c.detectTrigger("/sum"), { kind: "command", query: "sum" });
  assert.deepEqual(c.detectTrigger("/"), { kind: "command", query: "" });
  assert.equal(c.detectTrigger("/sum mary"), null);
  assert.equal(c.detectTrigger("hello /sum"), null);
  assert.deepEqual(c.detectTrigger("see @src/ui"), { kind: "mention", query: "src/ui", tokenStart: 4 });
  assert.deepEqual(c.detectTrigger("@"), { kind: "mention", query: "", tokenStart: 0 });
  assert.equal(c.detectTrigger("mail me@x.com now"), null);
  assert.equal(c.detectTrigger("see @a "), null); // ends in whitespace: no token being typed
  assert.equal(c.detectTrigger(`/${"a".repeat(400)}`), null);
  assert.equal(c.detectTrigger("x".repeat(30_000)), null);
  assert.equal(c.draftRemovingLastToken("hello @src/u"), "hello ");
  assert.equal(c.draftRemovingLastToken("hello "), "hello ");
});

test("items: untrusted catalog data is dropped or sanitised, not trusted", () => {
  const cmds = c.decodeCommands({ commands: [
    { trigger: "good", description: "ok\u202E", args: [{ name: "path", required: true }, { name: "bad name", required: true }], pluginName: "acme" },
    { trigger: "bad trigger", description: "x", args: [] },
    { trigger: "clear", description: "shadow", args: [] },     // collides with a built-in
    { trigger: "../x", description: "x", args: [] },
    { trigger: 7 }, null,
  ] });
  assert.deepEqual(cmds.map((x) => x.trigger), ["good", "clear"]);
  assert.equal(c.commandInsert(cmds[0]), "/good path= ");
  const items = c.buildCommandItems(cmds);
  assert.ok(items.some((i) => i.label === "/good"));
  assert.equal(items.filter((i) => i.label === "/clear").length, 1, "a plugin command shadowed by a built-in is not listed");
  assert.equal(items.find((i) => i.label === "/good").detail, "acme · ok");

  const lib = c.buildLibraryItems({ skills: [
    { id: "skills/design", name: "design", description: "d", sourceName: "kit" },
    { id: "../../etc/passwd", name: "evil", description: "", sourceName: "" },
    { id: "skills/a b", name: "space", description: "", sourceName: "" },
  ] });
  assert.deepEqual(lib.map((x) => x.skillId), ["skills/design"]);

  const cat = c.buildCatalogItems({ skills: { global: [{ name: "search-kb", description: "d" }], internal: [], plugins: [{ pluginName: "p", skills: [{ name: "s1", description: "x\n\ny" }] }] }, subagents: { plugins: [{ pluginName: "p", subagents: [{ name: "reviewer", description: "r" }] }] } });
  assert.deepEqual(cat.skills.map((x) => x.insert), ["Use the search-kb skill:", "Use the s1 skill:"]);
  assert.equal(cat.skills[1].detail, "p · x y");
  assert.equal(cat.subagents[0].insert, "Use the reviewer subagent:");

  const hooks = c.buildHookItems({ plugins: [{ name: "a", displayName: "A", hookCount: 2 }, { name: "b", hookCount: 0 }, { name: "c", declaresHooks: true }] });
  assert.deepEqual(hooks.map((x) => x.target.id), ["a", "c"]);
  const mcp = c.buildMcpItems({ plugins: [{ id: "fs", name: "Filesystem", enabled: true, consented: false, transport: "stdio" }] });
  assert.equal(mcp[0].detail, "needs consent · stdio");

  const big = c.decodeCommands({ commands: Array.from({ length: 30_000 }, (_, i) => ({ trigger: `c${i}`, description: "", args: [] })) });
  assert.equal(big.length, c.MAX_ITEMS_PER_SOURCE);
});

test("loader: lazy, 60 s TTL, 5 s backoff, partial failure keeps old items, no overlap", async () => {
  let now = 1_000_000;
  let fail = new Set();
  let calls = 0;
  const core = { async json(_m, path) {
    calls++;
    const p = path.split("?")[0];
    if (fail.has(p)) throw new Error("down");
    if (p === "/kb/agent/commands") return { commands: [{ trigger: "go", description: "d", args: [] }] };
    if (p === "/kb/agent/catalog") return { skills: { global: [{ name: "alpha", description: "" }], internal: [], plugins: [] }, subagents: { plugins: [] } };
    if (p === "/kb/agent/skill-library") return { skills: [] };
    if (p === "/auth/me/plugins") return { plugins: [] };
    if (p === "/auth/me/mcp-plugins") return { plugins: [] };
    throw new Error(`unexpected ${p}`);
  } };
  const loader = c.createCatalogLoader(core, () => now);
  assert.equal(loader.snapshot().complete, false);
  assert.ok(loader.snapshot().commands.length >= 8, "built-ins are there before any fetch");
  const [a, b] = await Promise.all([loader.ensure(), loader.ensure()]);
  assert.equal(calls, 5, "concurrent opens share one round");
  assert.equal(a, b);
  assert.equal(a.complete, true);
  assert.ok(a.commands.some((i) => i.label === "/go"));
  await loader.ensure();
  assert.equal(calls, 5, "fresh snapshot: no refetch");
  now += 61_000;
  fail = new Set(["/kb/agent/catalog"]);
  const s = await loader.ensure();
  assert.equal(calls, 10);
  assert.equal(s.complete, false);
  assert.deepEqual(s.skills.map((x) => x.label), ["alpha"], "a failed source keeps its previous items");
  await loader.ensure();
  assert.equal(calls, 10, "failure backoff: not retried within 5 s");
  now += 6_000;
  fail = new Set();
  assert.equal((await loader.ensure()).complete, true);
  loader.invalidate();
  await loader.ensure();
  assert.equal(calls, 20);
});

test("command menu: fixed group order with headers; best global prefix match is selected", () => {
  const snap = { ...{ commands: c.buildCommandItems([]), skills: [c.item("skill", "s1", "summarize", "d")], subagents: [], library: [c.item("librarySkill", "l1", "design", "d", { skillId: "skills/design" })], hooks: [], mcp: [], complete: true } };
  const modes = c.buildModeItems(c.MODES);
  const models = c.buildModelItems([{ label: "Claude", models: [{ provider: "anthropic", model: "claude-sonnet-5", label: "Sonnet 5" }] }]);
  const all = c.buildCommandView({ catalog: snap, modes, models }, "");
  assert.deepEqual([...all.headers.values()], ["Commands", "Skills", "Skill Library", "Modes", "Models"]);
  assert.equal(all.selected, 0);
  const q = c.buildCommandView({ catalog: snap, modes, models }, "des");
  assert.equal(q.items[q.selected].label, "design", "a prefix hit in a later group beats an earlier weak hit");
  // The seven surfaces of the Mac menu (built-ins, skills, plugins, MCP, commands, modes, models) are all reachable kinds.
  const kinds = new Set(["command", "skill", "subagent", "librarySkill", "hook", "mcp", "mode", "model"].map((k) => c.SECTION_TITLES[k]));
  assert.equal(kinds.size, 8);
});

const mkSources = (extra = {}) => {
  const catalog = {
    snapshot: () => ({ commands: c.buildCommandItems([{ trigger: "go", description: "d", args: [{ name: "x", required: true }], pluginName: null }]), skills: [c.item("skill", "skill:alpha", "alpha", "d", { insert: "Use the alpha skill:" })], subagents: [], library: [c.item("librarySkill", "lib:skills/design", "design", "d", { skillId: "skills/design" })], hooks: [c.item("hook", "hook:p", "P", "1 hook", { target: { kind: "plugin", id: "p" } })], mcp: [], complete: true }),
    ensure: async () => catalog.snapshot(), invalidate() {}, subscribe: () => () => {},
  };
  const log = { draft: null, mode: null, model: null, nav: null };
  const timers = [];
  const model = new c.ComposerModel({
    catalog, sources: { modes: () => c.MODES, models: () => [{ label: "Claude", models: [{ provider: "anthropic", model: "claude-sonnet-5", label: "Sonnet 5" }] }] },
    actions: { setDraft: (t) => { log.draft = t; }, setMode: (m) => { log.mode = m; }, setModel: (p, m) => { log.model = [p, m]; }, navigate: (t) => { log.nav = t; } },
    attachments: null, mentions: null, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, ...extra,
  });
  return { model, log, timers };
};

test("model: '/' opens, ranks, accepts a command; no-arg command suppresses the echo", () => {
  const { model, log } = mkSources();
  model.update("/");
  assert.equal(model.getState().open, true);
  model.update("/cl");
  assert.equal(model.getState().view.items[model.getState().view.selected].label, "/clear");
  assert.equal(model.accept(), true);
  assert.equal(log.draft, "/clear");
  assert.equal(model.getState().open, false);
  model.update("/clear"); // the echo of our own write must not reopen the menu
  assert.equal(model.getState().open, false);
  model.update("/clea");
  assert.equal(model.getState().open, true, "the next user edit reopens");
  model.update("/go");
  assert.equal(model.accept(), true);
  assert.equal(log.draft, "/go x= ", "a plugin command inserts its required arguments");
  assert.equal(model.getState().open, false);
});

test("model: arrows wrap, Escape hides until the draft changes, hover selects", () => {
  const { model } = mkSources();
  model.update("/");
  const n = model.getState().view.items.length;
  model.moveUp();
  assert.equal(model.getState().view.selected, n - 1);
  model.moveDown();
  assert.equal(model.getState().view.selected, 0);
  model.select(3);
  assert.equal(model.getState().view.selected, 3);
  model.dismiss();
  assert.equal(model.getState().open, false);
  model.update("/");
  assert.equal(model.getState().open, false, "same draft after Escape stays closed");
  model.update("/a");
  assert.equal(model.getState().open, true);
});

test("model: skills become chips (max 5, no duplicates); send folds directives and skill ids in, one message only", () => {
  const { model } = mkSources();
  model.update("/alpha");
  model.accept();
  model.update("/des");
  const it = model.getState().view.items[model.getState().view.selected];
  assert.equal(it.label, "design");
  model.accept();
  assert.deepEqual(model.getState().skills.map((s) => s.kind), ["directive", "library"]);
  model.update("/alpha"); model.accept();
  assert.equal(model.getState().skills.length, 2, "no duplicate chip");
  const p = model.consumeForSend("do it");
  assert.equal(p.text, "Use the alpha skill:\n\ndo it");
  assert.deepEqual(p.skills, ["skills/design"]);
  assert.equal(p.attachments, undefined);
  assert.equal(model.getState().skills.length, 0, "chips apply to exactly one message");
  assert.equal(model.consumeForSend("again").text, "again");
});

test("model: mode and model rows act on the picker, hook rows navigate", () => {
  const { model, log } = mkSources();
  model.update("/plan");
  const row = model.getState().view.items.find((i) => i.kind === "mode" && i.mode === "plan");
  model.select(model.getState().view.items.indexOf(row));
  model.accept();
  assert.equal(log.mode, "plan");
  model.update("/sonnet");
  model.select(model.getState().view.items.findIndex((i) => i.kind === "model"));
  model.accept();
  assert.deepEqual(log.model, ["anthropic", "claude-sonnet-5"]);
  model.update("/P");
  model.select(model.getState().view.items.findIndex((i) => i.kind === "hook"));
  model.accept();
  assert.deepEqual(log.nav, { kind: "plugin", id: "p" });
});

test("builtin-actions: /model resolves by id, label or unique substring", () => {
  const groups = [{ label: "Claude", models: [{ provider: "anthropic", model: "claude-sonnet-5", label: "Sonnet 5" }, { provider: "anthropic", model: "claude-haiku-5", label: "Haiku 5" }] }];
  assert.deepEqual(c.resolveModelArg("haiku", groups), { provider: "anthropic", model: "claude-haiku-5" });
  assert.deepEqual(c.resolveModelArg("Sonnet 5", groups), { provider: "anthropic", model: "claude-sonnet-5" });
  assert.equal(c.resolveModelArg("claude", groups), null, "ambiguous");
  assert.equal(c.resolveModelArg("", groups), null);
  const said = [];
  c.runBuiltin({ kind: "switchModel", argument: "claude" }, groups, { clearChat() {}, openSection() {}, setModel() { said.push("set"); }, say: (m) => said.push(m) });
  assert.match(said[0], /No single model matches/);
});

test("CompletionMenu: 5,000 rows render a bounded window with listbox semantics", () => {
  const items = Array.from({ length: 5000 }, (_, i) => c.item("skill", `s${i}`, `skill-${i}`, `description ${i}`));
  const view = { items, headers: c.headerIndex(items), selected: 2 };
  const out = html(h(c.CompletionMenu, { id: "m1", view, loading: false, note: null, label: "Commands and skills", onPick() {}, onHover() {} }));
  const opts = out.match(/role="option"/g) ?? [];
  assert.ok(opts.length > 0 && opts.length <= 20, `rendered ${opts.length} options`);
  assert.match(out, /role="listbox"[^>]*aria-label="Commands and skills"/);
  assert.match(out, /aria-setsize="5000"/);
  assert.match(out, /aria-posinset="1"/);
  assert.match(out, /id="m1-opt-2"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="m1-opt-2"/);
  assert.match(out, /Skills/); // the section header
  const note = html(h(c.CompletionMenu, { id: "m2", view: { items: [], headers: new Map(), selected: 0 }, loading: true, note: null, label: "x", onPick() {}, onHover() {} }));
  assert.match(note, /role="status"[^>]*>Searching/);
});

test("CompletionMenu: hostile text renders as text", () => {
  const it = c.item("skill", "x", "<img src=x onerror=alert(1)>", "<script>boom()</script>");
  const out = html(h(c.CompletionMenu, { id: "m", view: { items: [it], headers: new Map(), selected: 0 }, loading: false, note: null, label: "x", onPick() {}, onHover() {} }));
  assert.ok(!out.includes("<img") && !out.includes("<script"));
  assert.match(out, /&lt;img/);
});
