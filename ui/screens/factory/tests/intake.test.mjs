import { test } from "node:test";
import assert from "node:assert/strict";
import { memFs } from "./mem-fs.mjs";
import { addItem, readItems } from "../items.ts";
import { listSpecFiles, runPlanFor, sendSummary, sendToFactory, workItemFromIssue, workItemFromSpec, workItemFromText } from "../intake.ts";

const NOW = new Date("2026-11-09T10:00:00.000Z");
const issue = (n, over = {}) => ({ id: `gh-${n}`, provider: "github", repo: "acme/web", number: n, title: `Fix ${n}`, body: `Body ${n}`, url: `https://github.com/acme/web/issues/${n}`, ...over });
const facts = (over = {}) => ({ live: null, lastRecord: null, worktreeExists: false, ship: null, shipStatusError: false, lastKnownColumn: null, ...over });
const recorder = () => {
  const calls = [];
  let n = 0;
  return { calls, start: (root, item, mode, opts) => { calls.push([root, item.key, mode, opts]); return opts?.runId ?? `run-${++n}`; } };
};

test("an issue becomes a work item keyed by provider, repo and number", () => {
  const w = workItemFromIssue(issue(12), NOW);
  assert.equal(w.key, "issue:github:acme/web#12");
  assert.equal(w.source, "issue");
  assert.equal(w.id, "github:acme/web#12");
  assert.equal(w.title, "#12 Fix 12");
  assert.equal(w.repo, "acme/web");
  assert.equal(w.provider, "github");
  assert.equal(workItemFromIssue(issue(3, { provider: "gitlab", repo: "grp/proj" }), NOW).provider, "gitlab");
  assert.match(w.body, /Body 12/);
  assert.equal(workItemFromIssue(issue(null, { id: "abc" }), NOW).key, "issue:github:acme/web#abc");
});

test("sending the same issue twice adds it once and reports it as existing", async () => {
  const fs = memFs();
  const { start } = recorder();
  const first = await sendToFactory(fs, [workItemFromIssue(issue(12), NOW)], { runIntake: false, projectRoot: "/p", start });
  assert.deepEqual(first, { added: 1, existing: [] });
  const again = await sendToFactory(fs, [workItemFromIssue(issue(12), NOW)], { runIntake: false, projectRoot: "/p", start });
  assert.deepEqual(again, { added: 0, existing: ["issue:github:acme/web#12"] });
  assert.equal((await readItems(fs)).length, 1);
});

test("runIntake queues intakeOnly runs for new items only", async () => {
  const fs = memFs();
  const rec = recorder();
  await addItem(fs, workItemFromIssue(issue(1), NOW));
  const r = await sendToFactory(fs, [1, 2, 3].map((n) => workItemFromIssue(issue(n), NOW)), { runIntake: true, projectRoot: "/p", start: rec.start });
  assert.deepEqual(r, { added: 2, existing: ["issue:github:acme/web#1"] });
  assert.deepEqual(rec.calls, [["/p", "issue:github:acme/web#2", "intakeOnly", undefined], ["/p", "issue:github:acme/web#3", "intakeOnly", undefined]]);
  assert.deepEqual((await readItems(fs)).map((i) => i.runIds), [[], ["run-1"], ["run-2"]]);
});

test("start after a ready intake uses continue mode and the same runId", () => {
  const item = { ...workItemFromIssue(issue(4), NOW), runIds: ["r1"] };
  const ready = facts({ lastRecord: { runId: "r1", mode: "intakeOnly", statusCode: "success", needsDecision: null, ship: null, endedAt: null }, worktreeExists: true });
  assert.deepEqual(runPlanFor("start", item, ready), { mode: "continue", runId: "r1" });
  assert.deepEqual(runPlanFor("start", item, facts()), { mode: "full" }, "no ready intake: a fresh full run");
  assert.deepEqual(runPlanFor("start", item, { ...ready, worktreeExists: false }), { mode: "full" }, "worktree gone: a fresh full run");
  assert.deepEqual(runPlanFor("start", { ...item, runIds: [] }, facts()), { mode: "full" });
});

test("intake and resume reuse the card's worktree when it still exists", () => {
  const item = { ...workItemFromIssue(issue(5), NOW), runIds: ["r1"] };
  assert.deepEqual(runPlanFor("intake", item, facts({ worktreeExists: true })), { mode: "intakeOnly", runId: "r1" });
  assert.deepEqual(runPlanFor("intake", item, facts()), { mode: "intakeOnly" });
  assert.deepEqual(runPlanFor("resume", item, facts({ worktreeExists: true })), { mode: "full", runId: "r1" });
  assert.deepEqual(runPlanFor("resume", item, facts()), { mode: "full" });
  // Resume of a card whose intake already passed continues after the Intake gate instead of re-running Intake and Plan.
  const ready = facts({ lastRecord: { runId: "r1", mode: "intakeOnly", statusCode: "success", needsDecision: null, ship: null, endedAt: null, entry: null }, worktreeExists: true });
  assert.deepEqual(runPlanFor("resume", item, ready), { mode: "continue", runId: "r1" });
});

test("specs come from llm-doc only, titled by their first heading", () => {
  const w = workItemFromSpec("llm-doc/specs/login.md", "intro\n# Login rework\n\nDetails", NOW);
  assert.equal(w.key, "spec:llm-doc/specs/login.md");
  assert.equal(w.title, "Login rework");
  assert.equal(w.body, "intro\n# Login rework\n\nDetails");
  assert.equal(w.repo, null);
  assert.equal(workItemFromSpec("llm-doc/notes.md", "no heading", NOW).title, "notes");
  for (const bad of ["code/a.md", "llm-doc/../x.md", "/abs/llm-doc/a.md", "llm-doc/a.txt"]) assert.throws(() => workItemFromSpec(bad, "x", NOW), /llm-doc/, bad);
});

test("listSpecFiles lists markdown under llm-doc and skips the readiness copies", async () => {
  const fs = memFs({ "llm-doc/a.md": "", "llm-doc/specs/b.md": "", "llm-doc/specs/c.txt": "", "llm-doc/factory/2026/11/r1-readiness.md": "", "code/x.md": "" });
  assert.deepEqual(await listSpecFiles(fs), ["llm-doc/a.md", "llm-doc/specs/b.md"]);
  assert.deepEqual(await listSpecFiles(memFs()), []);
});

test("free text items and the send summary", () => {
  const t = workItemFromText("Add dark mode", "Details", NOW, () => 0.5);
  assert.equal(t.source, "text");
  assert.equal(t.id, null);
  assert.match(t.key, /^text:/);
  assert.equal(sendSummary(2, 0), "Sent 2 items to the Factory.");
  assert.equal(sendSummary(1, 1), "Sent 1 item to the Factory (1 already there).");
  assert.equal(sendSummary(0, 1), "Already in the Factory.");
  assert.equal(sendSummary(0, 3), "All 3 are already in the Factory.");
  assert.equal(sendSummary(0, 0), "Nothing to send.");
});
