import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const model = await load("memory/memory-model.ts");
const { MemoryBody } = await load("memory/ProjectMemoryView.tsx");

const SCHEMA = join(fileURLToPath(new URL(".", import.meta.url)), "../../../../schema/http/fixtures/agent");
const fixture = (name) => JSON.parse(readFileSync(join(SCHEMA, name), "utf8"));

/** A fake core: `routes` maps "GET <path without query>" to a body, or a function returning a body or throwing. */
function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(method, path, body, signal) {
      calls.push({ method, path, body, signal });
      const key = `${method} ${path.split("?")[0]}`;
      const r = routes[key];
      if (!r) return { status: 404, body: { error: { code: "NOT_FOUND" } } };
      const v = typeof r === "function" ? await r(path) : r;
      if (v instanceof Error) throw v;
      return { status: 200, body: v };
    },
  };
}

test("fixtures decode: project facts with a repo, an empty project, and a session list", () => {
  const withFacts = fixture("get-kb-agent-project-memory-200-facts.json").response;
  assert.deepEqual(model.decodeProjectMemory(withFacts), {
    facts: ["[db|engine] The project stores data in SQLite.", "[perf|store] The project keeps its cache in memory."],
    repo: "/example/workspace",
  });
  assert.deepEqual(model.decodeProjectMemory(fixture("get-kb-agent-project-memory-200-empty.json").response), { facts: [], repo: null });
  assert.deepEqual(model.decodeSessionMemory(fixture("get-kb-agent-session-memory-200.json").response), ["The user prefers short answers."]);
});

test("decoders are strict: a malformed reply throws instead of reading as nothing remembered", () => {
  assert.throws(() => model.decodeProjectMemory(null));
  assert.throws(() => model.decodeProjectMemory([]));
  assert.throws(() => model.decodeProjectMemory({ facts: "x", repo: null }));
  assert.throws(() => model.decodeSessionMemory({}));
  // Non-string items are dropped, and a non-string repo is "no repo", not a crash.
  assert.deepEqual(model.decodeProjectMemory({ facts: ["ok", 3, null], repo: 7 }), { facts: ["ok"], repo: null });
});

test("paths: each candidate is a repo parameter in order, the open folder goes last, values are encoded", () => {
  assert.equal(
    model.projectMemoryPath({ repos: ["/a b", "/c&d"], workspaceRoot: "/w" }),
    "/kb/agent/project-memory?repo=%2Fa+b&repo=%2Fc%26d&workspaceRoot=%2Fw",
  );
  assert.equal(model.projectMemoryPath({ repos: [] }), "/kb/agent/project-memory?");
  assert.equal(model.sessionMemoryPath("p9 x&y"), "/kb/agent/session-memory?sessionId=p9+x%26y");
});

test("load: both sections come from their routes, with the candidates sent to the project route", async () => {
  const client = fakeClient({
    "GET /kb/agent/project-memory": fixture("get-kb-agent-project-memory-200-facts.json").response,
    "GET /kb/agent/session-memory": fixture("get-kb-agent-session-memory-200.json").response,
  });
  const out = await model.loadMemory(client, { repos: ["/x"], workspaceRoot: "/example/workspace", sessionId: "p9-memory-session" });
  assert.equal(out.projectFailed, false);
  assert.equal(out.project.repo, "/example/workspace");
  assert.deepEqual(out.session, ["The user prefers short answers."]);
  assert.deepEqual(client.calls.map((c) => c.path), [
    "/kb/agent/project-memory?repo=%2Fx&workspaceRoot=%2Fexample%2Fworkspace",
    "/kb/agent/session-memory?sessionId=p9-memory-session",
  ]);
});

test("load: a project failure keeps the session facts; a session failure is an empty list", async () => {
  const failing = fakeClient({
    "GET /kb/agent/project-memory": new Error("boom"),
    "GET /kb/agent/session-memory": { facts: ["kept"] },
  });
  const a = await model.loadMemory(failing, { repos: ["/x"], sessionId: "s1" });
  assert.deepEqual([a.projectFailed, a.project, a.session], [true, null, ["kept"]]);
  const b = await model.loadMemory(
    fakeClient({ "GET /kb/agent/project-memory": { facts: ["p"], repo: "/x" }, "GET /kb/agent/session-memory": { error: 1 } }),
    { repos: ["/x"], sessionId: "s1" },
  );
  assert.deepEqual([b.projectFailed, b.session], [false, []]);
});

test("load: no candidate and no folder means no project request; a blank session id means no session request", async () => {
  const client = fakeClient({});
  const out = await model.loadMemory(client, { repos: [], workspaceRoot: null, sessionId: "   " });
  assert.deepEqual(out, { project: null, projectFailed: false, session: [] });
  assert.deepEqual(client.calls, []);
});

test("load: an abort is rethrown, not shown as a failure", async () => {
  const ac = new AbortController();
  ac.abort();
  const client = fakeClient({ "GET /kb/agent/project-memory": new Error("aborted") });
  await assert.rejects(model.loadMemory(client, { repos: ["/x"] }, ac.signal));
});

test("fact text: the recency stamp is shown as a date, not inline; control and bidi characters are removed", () => {
  const f = "[db|engine] The project uses SQLite. (t:2026-10-01)";
  assert.equal(model.factText(f), "[db|engine] The project uses SQLite.");
  assert.equal(model.factLearned(f), "2026-10-01");
  assert.equal(model.factLearned("No stamp here."), null);
  assert.equal(model.factText("evil‮fdp\u0007 text"), "evilfdp text");
});

test("prune: one project fact, all project facts, and this chat's memory send the documented DELETE bodies", async () => {
  const client = fakeClient({
    "DELETE /kb/agent/project-memory": { facts: ["[db|x] keeps SQLite."] },
    "DELETE /kb/agent/session-memory": { removed: 2 },
  });
  assert.deepEqual(await model.deleteProjectFact(client, { workspaceRoot: "/w" }, "/r", "[db|x] old (t:2026-10-01)"), ["[db|x] keeps SQLite."]);
  assert.deepEqual(await model.clearProjectFacts(client, {}, "/r"), ["[db|x] keeps SQLite."]);
  await model.forgetSessionMemory(client, "s1");
  assert.deepEqual(client.calls.map((c) => [c.method, c.path, c.body]), [
    ["DELETE", "/kb/agent/project-memory", { repo: "/r", fact: "[db|x] old (t:2026-10-01)", workspaceRoot: "/w" }],
    ["DELETE", "/kb/agent/project-memory", { repo: "/r", all: true }],
    ["DELETE", "/kb/agent/session-memory", { sessionId: "s1" }],
  ]);
});

test("body: with actions, session Forget and per-fact trash are rendered; without actions it stays read only", () => {
  const data = { project: { facts: ["[db|x] uses SQLite."], repo: "/x" }, projectFailed: false, session: ["chat fact"] };
  const out = html(h(MemoryBody, { state: { status: "ready", data }, actions: { onDeleteFact: () => {}, onForgetSession: () => {} } }));
  assert.match(out, />Forget<\/button>/);
  assert.match(out, /aria-label="Forget \[db\|x\] uses SQLite\."/);
  assert.doesNotMatch(html(h(MemoryBody, { state: { status: "ready", data } })), />Forget<\/button>/);
});

test("body: loading, no project, nothing yet, a failed load and the two sections", () => {
  const ready = (data) => html(h(MemoryBody, { state: { status: "ready", data } }));
  assert.match(html(h(MemoryBody, { state: { status: "loading" } })), /Loading memory/);
  assert.match(ready({ project: null, projectFailed: false, session: [] }), /Open a project folder/);
  assert.match(ready({ project: { facts: [], repo: "/x" }, projectFailed: false, session: [] }), /Nothing remembered yet/);
  const failed = ready({ project: null, projectFailed: true, session: [] });
  assert.match(failed, /load project memory/);
  assert.doesNotMatch(failed, /Nothing remembered yet|Open a project folder/);
  const both = ready({ project: { facts: ["[db|x] uses SQLite. (t:2026-09-30)"], repo: "/x" }, projectFailed: false, session: ["asked for short answers"] });
  assert.match(both, /aria-label="Session memory"/);
  assert.match(both, /aria-label="Project facts"/);
  assert.match(both, /Learned 2026-09-30/);
  assert.doesNotMatch(both, /<button/, "read only: no Forget or Clear actions");
});

test("body: hostile fact text is rendered as text, never as markup", () => {
  const out = html(h(MemoryBody, { state: { status: "ready", data: { project: { facts: ["<img src=x onerror=alert(1)>‮evil"], repo: "/x" }, projectFailed: false, session: [] } } }));
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("‮"));
});

test("review: facts are capped in count and length", async () => {
  const mm = await load("memory/memory-model.ts");
  const many = mm.decodeProjectMemory({ facts: Array.from({ length: 1500 }, () => "x".repeat(5000)), repo: "/r" });
  assert.equal(many.facts.length, 1000);
  assert.equal(many.facts[0].length, 2000);
});
