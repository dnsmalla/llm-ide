import { test } from "node:test";
import assert from "node:assert/strict";
import { memFs } from "./mem-fs.mjs";
import { prepareHumanReview, requestChanges } from "../human-review.ts";
import { worktreePrefix } from "../send-back.ts";

const FILE = "system/loop-worktrees/r1/.factory/HUMAN-REVIEW.md";
const item = { key: "issue:x1", source: "issue", id: "x1", title: "One", body: "", repo: null, addedAt: "2026-11-09T00:00:00.000Z", runIds: ["r0", "r1"] };

test("requestChanges writes HUMAN-REVIEW.md then starts one humanReview run in the same worktree", async () => {
  const fs = memFs();
  const calls = [];
  const start = (root, it, mode, opts) => { calls.push([root, it.key, mode, opts, fs.files.has(FILE)]); return opts.runId; };
  const id = await requestChanges({ fs, start, projectRoot: "/p" }, item, "  Handle the empty password.  ");
  assert.equal(id, "r1");
  assert.deepEqual(calls, [["/p", "issue:x1", "humanReview", { runId: "r1" }, true]]);
  const text = fs.files.get(FILE);
  assert.match(text, /^# Human review/);
  assert.match(text, /Handle the empty password\./);
});

test("empty text throws and starts nothing; no run throws no run", async () => {
  const fs = memFs();
  let started = 0;
  const start = () => { started++; return "x"; };
  await assert.rejects(requestChanges({ fs, start, projectRoot: "/p" }, item, "   "), /Write what should change before sending it back\./);
  await assert.rejects(requestChanges({ fs, start, projectRoot: "/p" }, { ...item, runIds: [] }, "x"), /no run/);
  assert.equal(started, 0);
  assert.equal(fs.files.has(FILE), false);
});

test("a second request overwrites, and the text is trimmed to 4000 chars", async () => {
  const fs = memFs();
  await prepareHumanReview(fs, worktreePrefix("r1"), "first");
  await prepareHumanReview(fs, worktreePrefix("r1"), "second " + "x".repeat(5000));
  const text = fs.files.get(FILE);
  assert.equal(text.includes("first"), false);
  assert.match(text, /second/);
  assert.ok(text.length < 4100);
});

test("requestChanges reports the note through onUserSignal", async () => {
  const signals = [];
  await requestChanges({ fs: memFs(), projectRoot: "/p", start: () => "r1", onUserSignal: (s) => signals.push(s) }, item, "  Rename it.  ");
  assert.deepEqual(signals, [{ kind: "human_review", runId: "r1", payload: { note: "Rename it." } }]);
});
