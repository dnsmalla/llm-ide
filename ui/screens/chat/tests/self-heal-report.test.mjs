import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("self-heal-report"); });

const user = (text) => ({ role: "user", id: "u", text });
const assistant = (text) => ({ role: "assistant", id: "a", parts: [{ kind: "text", sealed: [text.slice(0, 3)], open: text.slice(3) }, { kind: "tool", id: "t" }], notices: [], status: "done" });

test("the report is the description plus the last user and assistant turns, labelled as data", () => {
  const msg = c.buildChatReport("the plan card never saves", [user("first"), assistant("old"), user("save the plan"), assistant("I saved it to llm-doc/plans.\n\nDone.")]);
  assert.match(msg, /^Reported from Chat: the plan card never saves\n/);
  assert.match(msg, /Last user message \(data\): save the plan/);
  assert.match(msg, /Last assistant reply \(data\): I saved it to llm-doc\/plans\. Done\./);
  assert.ok(!msg.includes("first"), "only the last exchange");
});

test("long text is cut, and an empty chat still reports the description", () => {
  const long = "x".repeat(5000);
  const msg = c.buildChatReport(long, [user(long), assistant(long)]);
  assert.ok(msg.length < 2000, "fits the incident message cap");
  assert.equal(c.buildChatReport("broken", []), "Reported from Chat: broken");
});

test("nothing is recorded without a description or when Self-Heal is off; the user is told what to do next", async () => {
  const sent = [];
  const deps = (on, pending = 0) => ({ report: async (m) => { if (on) sent.push(m); return on; }, pending: () => pending });
  assert.match(await c.reportFromChat(deps(true), "   ", []), /Describe what is wrong/);
  assert.match(await c.reportFromChat(deps(false), "it crashes", []), /only available in debug desktop builds/);
  assert.equal(sent.length, 0);
  const ok = await c.reportFromChat(deps(true), "it crashes", [user("hi")]);
  assert.match(ok, /Try to fix/);
  assert.equal(sent.length, 1);
  assert.match(await c.reportFromChat(deps(true, 1), "again", []), /as soon as the core is reachable/);
});
