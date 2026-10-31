import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemAuthError, createSystemHost, sectionForTarget, toSystemSkills, type SystemHostDeps } from "../system-host.ts";

function deps(over: Partial<SystemHostDeps> = {}): SystemHostDeps {
  return {
    request: async () => ({ status: 200, body: { ok: true } }),
    watch: () => () => {},
    openSection: () => true,
    openFile: () => true,
    projectGraph: async () => null,
    loadFile: async () => null,
    ...over,
  };
}

test("Mac page targets map to the desktop sections; codeGraph stays inside Graph", () => {
  assert.equal(sectionForTarget("loop"), "loop");
  assert.equal(sectionForTarget("autoTasks"), "autotasks");
  assert.equal(sectionForTarget("settings"), "settings");
  assert.equal(sectionForTarget("library"), "library");
  assert.equal(sectionForTarget("explorer"), "explorer");
  assert.equal(sectionForTarget("codeGraph"), "graph");
});

test("loadState asks for the window and refuses a refused session", async () => {
  const calls: unknown[] = [];
  const h = createSystemHost(deps({ request: async (m, p) => { calls.push([m, p]); return { status: 200, body: { window: "week" } }; } }));
  assert.deepEqual(await h.loadState("week"), { window: "week" });
  assert.deepEqual(calls, [["GET", "/kb/os/state?window=week"]]);
  const refused = createSystemHost(deps({ request: async () => ({ status: 401, body: null }) }));
  await assert.rejects(() => refused.loadState("day"), SystemAuthError);
});

test("cancel sends only the server-declared POST path", async () => {
  const calls: unknown[] = [];
  const h = createSystemHost(deps({ request: async (m, p, b) => { calls.push([m, p, b]); return { status: 200, body: {} }; } }));
  await h.cancel({ method: "POST", path: "/kb/loop/cancel", body: { id: "x" } });
  assert.deepEqual(calls, [["POST", "/kb/loop/cancel", { id: "x" }]]);
  await assert.rejects(() => h.cancel({ method: "GET", path: "/kb/loop/cancel" }), /Unsupported cancel/);
  await assert.rejects(() => h.cancel({ method: "POST", path: "https://evil" }), /Unsupported cancel/);
});

test("skills: only id+name rows survive; sourceName maps to source", () => {
  assert.deepEqual(toSystemSkills({ skills: [
    { id: "a", name: "Alpha", description: "d", sourceName: "kit" },
    { id: 1, name: "bad" },
    { name: "no id" },
    "nope",
  ] }), [{ id: "a", name: "Alpha", description: "d", source: "kit" }]);
  assert.deepEqual(toSystemSkills(null), []);
});

test("open/openFile delegate and report the host's answer", () => {
  const opened: unknown[] = [];
  const h = createSystemHost(deps({ openSection: (t) => { opened.push(t); return t !== "loop"; }, openFile: (p, l) => { opened.push([p, l]); return true; } }));
  assert.equal(h.open("settings"), true);
  assert.equal(h.open("loop"), false);
  assert.equal(h.openFile?.("code/a.ts", 3), true);
  assert.deepEqual(opened, ["settings", "loop", ["code/a.ts", 3]]);
});
