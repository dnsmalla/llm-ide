// Reasoning-effort picker (the Mac's "Effort" section): labels, which models offer it, the stale-pick rule, the
// persisted pick, and the turn body. Pure helpers first, then the picker markup and the controller's request body.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html, fakeCore, sse, until, tick, fixtures } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("effort"); });

const claude = (rows) => ({ id: "anthropic", label: "Claude", catalog: false, models: rows.map(([model, levels]) => ({ provider: "anthropic", model, label: model, effortLevels: levels })) });

test("effort labels capitalise the raw level and keep an unknown level readable", () => {
  assert.equal(c.effortLabel("medium"), "Medium");
  assert.equal(c.effortLabel("xhigh"), "Xhigh");
  assert.equal(c.effortLabel("auto"), "Auto");
  assert.equal(c.effortLabel(""), "");
});

test("a stored pick the model offers is used; any other pick falls back to Auto without an error", () => {
  assert.equal(c.effectiveEffort("high", ["low", "high"]), "high");
  assert.equal(c.effectiveEffort("max", ["low", "high"]), "auto", "a level this model does not offer is dropped");
  assert.equal(c.effectiveEffort("high", []), "auto", "no levels: nothing is offered");
  assert.equal(c.effectiveEffort("auto", ["low"]), "auto");
});

test("the levels come from the model the next turn runs on: the default is the first Claude row", () => {
  const groups = [claude([["claude-opus-5", ["low", "medium", "high", "max"]], ["claude-haiku-5", []]])];
  assert.deepEqual(c.effortLevelsFor(groups, null, null), ["low", "medium", "high", "max"]);
  assert.deepEqual(c.effortLevelsFor(groups, "anthropic", "claude-haiku-5"), [], "a model that reports no levels");
});

test("a saved model that differs only by a [1m] or date suffix still finds its row", () => {
  const groups = [claude([["claude-opus-5", ["low", "high"]]])];
  assert.deepEqual(c.effortLevelsFor(groups, "anthropic", "claude-opus-5[1m]"), ["low", "high"]);
  assert.deepEqual(c.effortLevelsFor(groups, "anthropic", "claude-opus-5-20260101"), ["low", "high"]);
  assert.deepEqual(c.effortLevelsFor(groups, "anthropic", "claude-unknown-9"), [], "an unlisted id offers no levels");
});

test("catalog and custom providers never offer effort", () => {
  const cat = { id: "conn-1", label: "OpenAI", catalog: true, provider: "custom:cat-openai", models: [{ provider: "custom:cat-openai", model: "gpt-5", label: "gpt-5", toolsSupported: true }] };
  assert.deepEqual(c.effortLevelsFor([claude([["claude-opus-5", ["high"]]]), cat], "custom:cat-openai", "gpt-5"), []);
  assert.deepEqual(c.effortLevelsFor([claude([["claude-opus-5", ["high"]]])], "custom:uuid-1", "claude-opus-5"), []);
});

test("the turn sends effort only when the user chose a level the model offers", () => {
  assert.equal(c.turnEffort("high", ["low", "high"]), "high");
  assert.equal(c.turnEffort("auto", ["low", "high"]), undefined);
  assert.equal(c.turnEffort("max", ["low", "high"]), undefined, "a stale pick is not sent");
});

test("the pick is remembered across launches and a storage failure is not an error", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(c.loadEffortPick(storage), "auto");
  c.saveEffortPick("high", storage);
  assert.equal(c.loadEffortPick(storage), "high");
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(c.loadEffortPick(broken), "auto");
  assert.doesNotThrow(() => c.saveEffortPick("low", broken));
});

test("the effort control is hidden when the model offers no levels, and lists Auto then the levels", () => {
  assert.equal(html(h(c.EffortPicker, { levels: [], value: "auto", onChange: () => {} })), "");
  const out = html(h(c.EffortPicker, { levels: ["low", "high"], value: "high", onChange: () => {} }));
  assert.match(out, /aria-label="Effort"/);
  const order = [...out.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["Auto", "Low", "High"]);
  assert.match(out, /value="high" selected=""/);
});

test("the controller sends effort in the turn body only when given", async () => {
  const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
  const turn = () => [sse(FX.init, FX.mode_set), sse({ type: "delta", text: "ok" }), sse(FX.usage, FX.result)];
  const run = async (opts) => {
    const core = fakeCore({ streams: [turn()] });
    const store = new c.MemoryChatStore();
    store.seed("a", "Chat A");
    const ctl = new c.ChatController({ core, store, workspaceRoot: () => "/proj", newId: () => "t1", sleep: () => tick(1), abortGraceMs: 30 });
    ctl.send("a", "hi", opts);
    await until(() => ctl.getState("a").phase === "idle" && ctl.getState("a").turnSeq === 1);
    return core.calls.find((x) => x.method === "STREAM").body;
  };
  assert.equal((await run({ mode: "auto", effort: "high" })).effort, "high");
  assert.equal("effort" in (await run({ mode: "auto" })), false);
});

test("every Chat surface shares one pick: a set notifies the others and is stored once; a storage that throws still works", () => {
  const mem = new Map([["chat.effort", "low"]]);
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const s = c.createEffortStore(storage);
  assert.equal(s.get(), "low", "read from storage on first use");
  let seen = 0;
  const off = s.subscribe(() => seen++);
  s.set("high");
  assert.equal(s.get(), "high");
  assert.equal(mem.get("chat.effort"), "high");
  assert.equal(seen, 1);
  s.set("high");
  assert.equal(seen, 1, "an unchanged pick does not notify");
  off();
  s.set("low");
  assert.equal(seen, 1, "unsubscribed");
  const broken = c.createEffortStore({ getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } });
  assert.equal(broken.get(), "auto");
  broken.set("max");
  assert.equal(broken.get(), "max", "kept for this session even when it cannot be stored");
});

test("the model listing carries each Claude row's effort levels as the core sends them (models.mjs entries)", async () => {
  const core = fakeCore({ json: { "POST /kb/providers/models": { models: ["claude-opus-5", "claude-haiku-5"], entries: [
    { id: "claude-opus-5", displayName: "Opus 5", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-5", displayName: "Haiku 5", effortLevels: [] }, { id: "claude-old", effortLevels: ["high", 7, ""] }, { id: "claude-bare" }] } } });
  const { groups } = await c.loadModelGroups(core);
  assert.equal(groups[0].provider, "anthropic");
  assert.deepEqual(groups[0].models.map((m) => m.effortLevels), [["low", "medium", "high", "xhigh", "max"], [], ["high"], []]);
});
