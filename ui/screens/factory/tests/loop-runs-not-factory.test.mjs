import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleFacts } from "../board-model.ts";
import { factoryRuns, isLoopRun } from "../../loop/native/run-manager.ts";

const run = (over) => ({ runId: "r", itemKey: "loop:L1", projectRoot: "/p", mode: "full", state: "running", startedAt: null, note: null, log: [], progress: null, ...over });
const item = (key) => ({ key, source: "issue", id: "1", title: "T", body: "", repo: "a/b", provider: "github", runIds: [] });
const ctx = (live) => ({ projectRoot: "/p", live, records: new Map(), worktrees: new Map(), ship: new Map(), lastKnown: new Map() });

test("a loop run is not a Factory run: the Factory board filters it out and no card matches it", () => {
  const live = [run({ runId: "a" }), run({ runId: "b", itemKey: "issue:github:a/b#1" })];
  assert.equal(isLoopRun(live[0]), true);
  assert.deepEqual(factoryRuns(live).map((r) => r.runId), ["b"]);
  assert.equal(assembleFacts(item("issue:github:a/b#1"), ctx(factoryRuns(live))).live.runId, "b");
  assert.equal(assembleFacts(item("issue:github:a/b#2"), ctx(factoryRuns([live[0]]))).live, null, "a loop run holds no Factory card");
});

test("the Factory board reads the run manager through factoryLiveRuns", async () => {
  const { readFileSync } = await import("node:fs");
  const board = readFileSync(new URL("../Board.tsx", import.meta.url), "utf8");
  assert.match(board, /useState<readonly LiveRun\[\]>\(\(\) => factoryLiveRuns\(\)\)/);
  assert.match(board, /const now = factoryLiveRuns\(\);/);
  assert.equal(/\bliveRuns\(\)/.test(board), false);
});
