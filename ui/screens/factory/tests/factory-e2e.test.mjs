// End to end through the real modules: an open issue on the board → a full Factory run → one issue comment per step →
// the run record → the draft MR opened by itself (Refs the issue, against the clone's branch) → the card in Shipped.
// Only the outside world is faked: the host (worktrees, git), the agent stages, GitLab and the core routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as rm from "../../loop/native/run-manager.ts";
import { FACTORY_TEMPLATE, factoryRole } from "../../loop/native/factory.ts";
import { autoShipKind, decodeWorktreeDiff } from "../../loop/native/ship-model.ts";
import { appendRunRecord, setRunRecordAutoShip, setRunRecordShip } from "../../loop/native/history.ts";
import { decodeRepoConfig } from "../../settings/repo-config.ts";
import { postIssueText, postStageComment } from "../issue-comment-poster.ts";
import { autoShipRun } from "../auto-ship.ts";
import { attachRun, readItems } from "../items.ts";
import { sendToFactory, workItemFromIssue } from "../intake.ts";
import { latestRecords } from "../board-model.ts";
import { columnFor } from "../columns.ts";
import { memFs } from "./mem-fs.mjs";

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 60; i++) await tick(); }

const ROOT = "/p";
const REPO = "grid-devs/personal/dinesh/smart-input";
const MR = `https://gitlab.com/${REPO}/-/merge_requests/9`;
// The default process, with Structure verify's command already detected (a project with a lint script).
const FACTORY_LOOP = { id: "F", name: "Factory", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: "factory", runsOnSchedule: false, config: { ...structuredClone(FACTORY_TEMPLATE.config), stages: structuredClone(FACTORY_TEMPLATE.config.stages).map((s) => (s.name === "Structure verify" ? { ...s, command: "npm run lint", enabled: true, disabledByDetection: false } : s)) } };
const config = decodeRepoConfig({ saved: { gitlab: [{ id: "g", url: `https://gitlab.com/${REPO}`, clonePath: `${ROOT}/code/smart-input`, active: true }] } });

function world(outcome) {
  const fs = memFs();
  const w = { fs, comments: [], shipped: [], chain: Promise.resolve() };
  const request = async (path, body) => { if (path === "/kb/issues/comment") w.comments.push(body); return { status: 201, body: {} }; };
  const allowed = () => true;
  rm.resetRunManagerForTests();
  rm.configureRunManager({
    host: async (command, args) => {
      if (command === "loop_worktree_prepare") return { runId: args.runId, project: ROOT, repo: `${ROOT}/code/smart-input`, worktree: `${ROOT}/system/loop-worktrees/${args.runId}`, branch: `factory/${args.runId}`, baseCommit: "c41bd85197d3aaaa" };
      if (command === "loop_worktree_diff") return { text: "+.btn { color: teal }", truncated: false, patchId: "a".repeat(64), files: ["src/button.css"], additions: 1, deletions: 0 };
      if (command === "loop_changed_paths") return ["src/button.css"];
      if (command === "loop_work_root") return ROOT;
      return null;
    },
    core: { async request() { return {}; } },
    fsFor: () => fs,
    loadFactoryLoop: async () => FACTORY_LOOP,
    approve: async () => "tok",
    repoForSlug: () => "code/smart-input",
    createStageDeps: (ctx) => ({ __ctx: ctx }),
    // The agent stages: each stage starts and finishes; Review writes its report like the real skill would.
    runLoop: async (cfg, deps) => {
      for (const [index, stage] of cfg.stages.filter((s) => s.enabled).entries()) {
        deps.onProgress?.({ type: "stage-start", stage, index, count: cfg.stages.length, iteration: 1 });
        if (factoryRole(stage) === "review") await fs.write(`system/loop-worktrees/${deps.__ctx.runId}/.factory/REVIEW.md`, "Looks right.\nVerdict: approve\n", { expected_hash: null });
        const ok = !(outcome.failRole && factoryRole(stage) === outcome.failRole);
        deps.onProgress?.({ type: "stage-result", stage, ok, iteration: 1 });
        if (!ok) return { passed: false, iterationsUsed: 1, stages: [], iterations: [], failedStage: stage, statusSummary: `${stage.name} failed` };
      }
      return { passed: true, iterationsUsed: 1, stages: [], iterations: [], failedStage: null, statusSummary: "passed after 1 iteration" };
    },
    appendRecord: appendRunRecord,
    copyReadiness: async () => false,
    activeProject: () => ROOT,
    subscribeProject: () => () => {},
    now: () => new Date("2026-11-12T10:00:00Z"),
    rand: () => 0.5,
    newId: () => "e1",
    onStageResult: (e) => { w.chain = w.chain.then(() => postStageComment({ request, allowed, diffFiles: async () => ["src/button.css"], readText: async (p) => (await fs.read(p)).text }, e)); },
    autoShip: async (e) => {
      await w.chain;
      const kind = autoShipKind({ mode: e.mode, statusCode: e.statusCode, needsDecision: e.needsDecision, failedRole: e.failedStage ? factoryRole(e.failedStage) : null });
      if (!kind) return "";
      const out = await autoShipRun({
        repoConfig: () => config,
        diff: async () => decodeWorktreeDiff({ text: "+.btn { color: teal }", truncated: false, patchId: "a".repeat(64), files: ["src/button.css"], additions: 1, deletions: 0 }),
        repoBranch: async () => "dev",
        readText: async (p) => (await fs.read(p).catch(() => ({ text: null }))).text,
        ship: async (body) => { w.shipped.push(body); return { ok: true, url: MR, commit: "abc1234", reused: false }; },
        saveShip: (entry, ship) => setRunRecordShip(fs, entry, ship),
        saveBlocked: (entry, reason) => setRunRecordAutoShip(fs, entry, reason, new Date()),
        comment: async (text) => { await postIssueText({ request, allowed }, e.item, text); },
        now: () => new Date(),
      }, { info: e.info, item: e.item, entry: e.entry, kind, failedStage: e.failedStage?.name ?? null, runPrefix: e.runPrefix });
      return "shipped" in out ? `Draft MR: ${out.shipped}` : `MR not opened: ${out.blocked}`;
    },
  });
  return w;
}

async function runIssue(w) {
  const issue = workItemFromIssue({ id: "77", provider: "gitlab", repo: REPO, number: 2, title: "Make buttons more colorful in Smart Input UI", body: "Use the brand colours.", url: `https://gitlab.com/${REPO}/-/issues/2` });
  await sendToFactory(w.fs, [issue], { runIntake: false, projectRoot: ROOT, start: rm.startRun });
  const runId = rm.startRun(ROOT, issue, "full");
  await attachRun(w.fs, issue.key, runId);
  await settle();
  await w.chain;
  await settle();
  const [item] = await readItems(w.fs);
  const record = (await latestRecords(w.fs, new Set([runId]))).get(runId);
  return { item, record, column: record ? columnFor({ live: null, lastRecord: record, worktreeExists: true, ship: null, shipStatusError: false, lastKnownColumn: null }) : null };
}

test("an open issue runs every step, comments after each one, and opens its draft MR by itself", async () => {
  const w = world({});
  const { record, column } = await runIssue(w);
  const steps = w.comments.map((c) => /Factory · `([^`]+)`\*\* — (\w[\w ]*)/.exec(c.body)?.slice(1).join(":"));
  assert.deepEqual(steps, ["Plan:passed", "Implement:passed", "Structure verify:passed", "Verify:passed", "Test gaps:passed", "Doc review:passed", "Review:passed", "Ship:draft MR opened"], "one comment per step, in order, then the Ship comment");
  const structure = w.comments.find((c) => /`Structure verify`/.test(c.body)).body;
  assert.doesNotMatch(structure, /Test command/, "a custom shell step is not reported as the Verify step");
  assert.ok(w.comments.every((c) => c.provider === "gitlab" && c.repo === REPO && c.number === 2), "every comment lands on issue #2");
  assert.match(w.comments.find((c) => /Implement/.test(c.body)).body, /`src\/button\.css`/);
  assert.match(w.comments.find((c) => /`Review`/.test(c.body)).body, /Review verdict: `approve`/);
  assert.equal(w.shipped.length, 1);
  assert.deepEqual({ repo: w.shipped[0].repo, base: w.shipped[0].base, title: w.shipped[0].title }, { repo: REPO, base: "dev", title: "#2 Make buttons more colorful in Smart Input UI" });
  assert.match(w.shipped[0].body, /^Refs #2$/m);
  assert.equal(record.ship.url, MR);
  assert.equal(column.column, "shipped");
});

test("a run whose tests fail still reaches the MR, labelled, and the issue says so", async () => {
  const w = world({ failRole: "verify" });
  const { column } = await runIssue(w);
  assert.match(w.comments.find((c) => /`Verify`/.test(c.body)).body, /— failed/);
  assert.equal(w.shipped[0].title, "[Tests failing] #2 Make buttons more colorful in Smart Input UI");
  assert.match(w.shipped[0].body, /^> \*\*The Factory's tests failed \(Verify\)\.\*\*/);
  assert.equal(column.column, "shipped");
});
