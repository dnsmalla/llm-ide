import { test } from "node:test";
import assert from "node:assert/strict";
import { _resetMrWatchForTests, watchMrsOnce } from "../mr-watch.ts";
import { memFs } from "./mem-fs.mjs";

const URL9 = "https://gitlab.com/g/p/-/merge_requests/9";
const item = { key: "issue:2", source: "issue", id: "2", title: "Colorful buttons", body: "", repo: "g/p", provider: "gitlab", addedAt: "2026-11-12T00:00:00.000Z", runIds: ["r1"] };
const record = { statusCode: "success", factoryMode: "full", endedAt: "2026-11-12T10:00:00.000Z", worktree: { runId: "r1", branch: "factory/r1", baseCommit: "abc", repo: "/p/code/p" }, ship: { provider: "gitlab", url: URL9, commit: "c1", reused: false } };

function project() {
  return memFs({
    "system/factory/items.json": JSON.stringify({ schemaVersion: 1, items: [item] }),
    "system/loop-runs/index-2026-11.jsonl": JSON.stringify({ id: "e1", startedAt: "2026-11-12T09:00:00.000Z", factoryRunId: "r1" }) + "\n",
    "system/loop-runs/2026-11/e1.json": JSON.stringify(record),
  });
}

function deps(fs, status, over = {}) {
  _resetMrWatchForTests();
  const started = [];
  const notices = [];
  const counts = {};
  const asked = [];
  return {
    started, notices, counts, asked,
    d: {
      projectRoot: () => "/p",
      fs: () => fs,
      worktrees: async () => new Map([["r1", { runId: "r1", worktree: "/p/system/loop-worktrees/r1" }]]),
      live: () => [],
      shipStatus: async (reqs) => { asked.push(reqs); return new Map([[URL9, status]]); },
      readCounts: () => counts,
      writeCounts: (c) => { Object.assign(counts, c); },
      start: (root, it, mode, opts) => { started.push({ root, key: it.key, mode, runId: opts?.runId }); return opts?.runId ?? "new"; },
      notice: (m) => notices.push(m),
      ...over,
    },
  };
}

const open = (comments) => ({ url: URL9, state: "open", ci: "none", ciSummary: null, comments });

test("a person's MR comment restarts the card from the first step, with the feedback written, even with the board closed", async () => {
  const fs = project();
  const w = deps(fs, open([{ author: "dinesh", body: "Use the brand colours", at: "2026-11-12T11:00:00Z" }]));
  assert.equal(await watchMrsOnce(w.d), 1);
  assert.deepEqual(w.started, [{ root: "/p", key: "issue:2", mode: "rework", runId: "r1" }]);
  assert.deepEqual(w.asked[0], [{ url: URL9, since: "2026-11-12T10:00:00.000Z" }], "comments only since the run ended");
  assert.match(fs.files.get("system/loop-worktrees/r1/.factory/FEEDBACK.md"), /Use the brand colours/);
  assert.equal(Object.values(w.counts)[0], 1);
  assert.match(w.notices[0], /Colorful buttons/);
  assert.equal(await watchMrsOnce(w.d), 0, "the same record never restarts twice");
});

test("no restart for bot comments, a live run, an interrupted run, the limit, or a merged MR (which resets the count)", async () => {
  const bot = deps(project(), open([{ author: "sonar[bot]", body: "ok", at: "2026-11-12T11:00:00Z", bot: true }]));
  assert.equal(await watchMrsOnce(bot.d), 0);
  const live = deps(project(), open([{ author: "d", body: "x", at: "2026-11-12T11:00:00Z" }]), { live: () => [{ runId: "r1", itemKey: "issue:2", projectRoot: "/p" }] });
  assert.equal(await watchMrsOnce(live.d), 0);
  const fs = project();
  fs.put("system/loop-worktrees/r1/.factory/RUN.json", "{}");
  const interrupted = deps(fs, { ...open([]), state: "closed" });
  assert.equal(await watchMrsOnce(interrupted.d), 0);
  const capped = deps(project(), { ...open([]), state: "closed" });
  capped.counts["/p\u0000issue:2"] = 3;
  assert.equal(await watchMrsOnce(capped.d), 0);
  const merged = deps(project(), { ...open([]), state: "merged" });
  merged.counts["/p\u0000issue:2"] = 2;
  assert.equal(await watchMrsOnce(merged.d), 0);
  assert.equal(merged.counts["/p\u0000issue:2"], undefined);
  for (const w of [bot, live, interrupted, capped, merged]) assert.equal(w.started.length, 0);
});

test("a restart that fails is retried at the next check and is not counted", async () => {
  let fail = true;
  const w = deps(project(), { ...open([]), state: "closed" }, { start: (root, it, mode, opts) => { if (fail) throw new Error("project switched"); w.started.push({ mode }); return opts.runId; } });
  assert.equal(await watchMrsOnce(w.d), 0);
  assert.equal(Object.keys(w.counts).length, 0);
  fail = false;
  assert.equal(await watchMrsOnce(w.d), 1);
  assert.deepEqual(w.started, [{ mode: "rework" }]);
});

test("no project, no shipped card or an unreachable status does nothing and never throws", async () => {
  assert.equal(await watchMrsOnce(deps(project(), open([]), { projectRoot: () => null }).d), 0);
  assert.equal(await watchMrsOnce(deps(memFs(), open([])).d), 0);
  assert.equal(await watchMrsOnce(deps(project(), open([]), { shipStatus: async () => { throw new Error("offline"); } }).d), 0);
  assert.equal(await watchMrsOnce(deps(project(), "error").d), 0);
});
