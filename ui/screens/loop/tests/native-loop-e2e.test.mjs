// End to end: the real Refactoring loop, as the desktop builds it, run by the real native runner against a real git
// repo in an isolated worktree. Everything is real except the AI: the file API behaves like the Rust host
// (`expected_hash: null` = create only, `force` overwrites, `create` refuses an existing path, a missing read
// throws not_found), shell stages run their command, the graph stages run graph-kit, and changed paths come from
// `git status --porcelain -z`. Skill stages are answered by a scripted agent that edits real files.
//
// The unit tests mock the file API as a no-op, which is how "the file already exists" reached a real run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initialProjectStore } from "../native/templates.ts";
import { batchRollbackReason } from "../native/store.ts";
import { runNativeLoop } from "../native/runner.ts";
import { createStageDeps } from "../native/stage-exec.ts";
import { runRefactorBatches } from "../native/refactor-batches.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LLM_IDE = path.resolve(HERE, "../../../..");
const GRAPH_KIT = path.join(LLM_IDE, "graph-kit/bin/graph-kit.js");
const SAMPLE = path.join(LLM_IDE, "system-tests");
const hasPytest = spawnSync("python3", ["-m", "pytest", "--version"]).status === 0;
const ready = hasPytest && fs.existsSync(GRAPH_KIT) && fs.existsSync(path.join(SAMPLE, "shop.py"));
const skip = ready ? false : "needs python3 -m pytest, graph-kit/bin/graph-kit.js and the system-tests sample (shop.py)";

/** The host rejects with `{ code, message }` (explorer/fs.ts FsError); the loop code reads `.code`. */
class FsError extends Error { constructor(code, message) { super(message); this.code = code; } }

const DISCOVER = process.env.LOOP_E2E_DISCOVER === "1";
const PLAN_REL = "llm-doc/loop/refactor/REFACTOR.md";
const REFUSED = new Set();

const sha = (t) => `h${Buffer.from(t).toString("base64").length}:${t.length}:${[...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

/** The host's root-confined file API over a real folder, with the Rust write rules. */
function hostFs(root) {
  const abs = (rel) => {
    const p = path.resolve(root, rel || ".");
    if (p !== root && !p.startsWith(`${root}${path.sep}`)) throw new FsError("outside_root", `outside the project: ${rel}`);
    return p;
  };
  return {
    async read(rel, maxBytes) {
      const p = abs(rel);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new FsError("not_found", "the file does not exist");
      // Like fs_ops.rs read_file: over the limit is a status, not an error, and carries no text.
      if (typeof maxBytes === "number" && fs.statSync(p).size > maxBytes) return { status: "too_large", size: fs.statSync(p).size, mtime_ms: 0 };
      const text = fs.readFileSync(p, "utf8");
      return { status: "ok", text, hash: sha(text), size: text.length, mtime_ms: 0, encoding: "utf-8", bom: false, truncated: false };
    },
    async write(rel, text, o) {
      const p = abs(rel);
      if (fs.existsSync(p)) {
        if (!o.force) {
          if (o.expected_hash === null) {
            // Discovery mode (LOOP_E2E_DISCOVER=1): record the refusal and go on, to see what fails after it.
            if (!DISCOVER) throw new FsError("exists", "the file already exists");
            REFUSED.add(rel);
          }
          else if (o.expected_hash !== sha(fs.readFileSync(p, "utf8"))) throw new FsError("conflict", "the file changed on disk since it was opened");
        }
      } else if (o.expected_hash !== null && !o.force) {
        throw new FsError("conflict", "the file was deleted on disk");
      } else if (!fs.existsSync(path.dirname(p))) {
        throw new FsError("not_found", "the parent folder does not exist");
      }
      fs.writeFileSync(p, text);
      return { hash: sha(text), mtime_ms: 0, size: text.length };
    },
    async create(rel, kind) {
      const p = abs(rel);
      if (fs.existsSync(p)) throw new FsError("exists", "the file already exists");
      if (!fs.existsSync(path.dirname(p))) throw new FsError("not_found", "the parent folder does not exist");
      if (kind === "dir") fs.mkdirSync(p); else fs.writeFileSync(p, "");
      return rel;
    },
    async list(rel) {
      const p = abs(rel);
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new FsError("not_found", "the folder does not exist");
      const entries = fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
        name: d.name, path: rel ? `${rel}/${d.name}` : d.name, kind: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
        symlink: false, hidden: d.name.startsWith("."), ignored: false, size: 0, mtime_ms: 0,
      }));
      return { path: rel, entries, total: entries.length, next_offset: null, skipped: 0 };
    },
    async remove(rel) { fs.rmSync(abs(rel), { recursive: true, force: true }); },
  };
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const changedPaths = (cwd) => [...new Set(git(cwd, "status", "--porcelain", "-z").split("\0").filter(Boolean).map((e) => e.slice(3)))].sort();

/** A scripted stand-in for the AI skills: the edits a well-behaved agent would make, nothing more. */
function scriptedAgent(workTree, calls, opts = {}) {
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(workTree, rel)), { recursive: true }); fs.writeFileSync(path.join(workTree, rel), text); };
  const PLAN = "llm-doc/loop/refactor/REFACTOR.md";
  return async (body) => {
    const skill = body.skills[0] ?? "repair";
    calls.push(skill);
    opts.seen?.push({ skill, message: body.message });
    const before = new Set(changedPaths(workTree));
    let reply;
    if (skill === "skills/refactor-planner") {
      const r1 = ["### R1 — remove the dead legacy module (status: todo)", "", `- Files: ${opts.planFiles ?? "legacy.py"}`, "- Expect: none", "- Tests: tests/test_golden.py", "- Rules: AGENTS.md", ""];
      const r2 = ["### R2 — add a money formatter (status: todo)", "", "- Files: fmt.py", "- Expect: none", "- Tests: tests/test_golden.py", "- Rules: AGENTS.md", ""];
      write(PLAN, ["# Refactor plan", "", ...r1, ...(opts.twoBatches ? r2 : [])].join("\n"));
      reply = opts.twoBatches ? "Planned: R1, R2" : "Planned: R1";
      if (opts.emptyPlan) reply = "";
    } else if (skill === "skills/test-gap-writer") {
      write("tests/test_tax.py", "import shop\n\n\ndef test_jp_tax_is_ten_percent():\n    assert shop.TAX_RATES['JP'] == 0.10\n");
      // A misbehaving writer that also weakens an existing test so it can never fail.
      if (opts.weakenGolden) write("tests/test_golden.py", "def test_the_report_for_the_sample_orders_is_unchanged():\n    assert True\n");
      reply = "Covered: tests/test_tax.py — the JP tax rate";
    } else if (skill === "skills/refactor-apply") {
      // Applies the first todo batch: R1 removes legacy.py, R2 adds fmt.py.
      const id = /### (R\d+) .*\(status: todo\)/.exec(fs.readFileSync(path.join(workTree, PLAN), "utf8"))[1];
      if (opts.editOutside) fs.appendFileSync(path.join(workTree, opts.editOutside), "\n# a body change outside the input path\n");
      else if (id === "R1") fs.rmSync(path.join(workTree, "legacy.py"));
      else write("fmt.py", 'def money(x):\n    return f"{x:.2f}"\n');
      // A buggy batch: the JP tax rate changes, so the golden report test fails until a repair restores it.
      if (opts.applyBreaks || opts.breakBatch === id) write("shop.py", fs.readFileSync(path.join(workTree, "shop.py"), "utf8").replace('"JP": 0.10', '"JP": 0.12').replace("rate = 0.10", "rate = 0.12"));
      // `applyLeavesTodo`: an agent that claims the batch but never marks it in the plan.
      if (!opts.applyLeavesTodo) write(PLAN, fs.readFileSync(path.join(workTree, PLAN), "utf8").replace("(status: todo)", "(status: done)"));
      reply = `Applied: ${id}`;
    } else if (skill === "skills/refactor-conform") {
      write("llm-doc/loop/refactor/RULE-REVIEW.md", "No rule violations in R1.\n");
      reply = "Conformed: R1 — 0 fixes";
    } else if (skill === "repair") {
      // An unrepairable batch: the repair agent runs and does not finish, so the stage stays failed.
      if (opts.unrepairable) return { ran: true, resultSubtype: "error_during_execution", reply: "Could not make the tests pass", changedPaths: [], createdPaths: [] };
      git(workTree, "checkout", "--", "shop.py");
      reply = "Restored shop.py";
    } else {
      reply = `(no script for ${skill})`;
    }
    const after = changedPaths(workTree);
    const created = after.filter((p) => !before.has(p) && fs.existsSync(path.join(workTree, p)) && !git(workTree, "ls-files", p).trim());
    return { ran: true, resultSubtype: "success", reply, changedPaths: after.filter((p) => !before.has(p) || p === PLAN), createdPaths: created };
  };
}

/** A project with the sample repo cloned under code/, and the Refactoring loop the desktop makes for it. */
function makeProject() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loop-e2e-")));
  const repo = path.join(project, "code", "sample");
  fs.mkdirSync(repo, { recursive: true });
  for (const f of ["shop.py", "utils.py", "legacy.py", "pyproject.toml", "AGENTS.md"]) fs.copyFileSync(path.join(SAMPLE, f), path.join(repo, f));
  for (const d of ["data", "tests", "tools"]) fs.cpSync(path.join(SAMPLE, d), path.join(repo, d), { recursive: true });
  fs.rmSync(path.join(repo, "tests", "__pycache__"), { recursive: true, force: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "__pycache__/\n.pytest_cache/\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  fs.mkdirSync(path.join(project, "system", "graph"), { recursive: true });
  const loop = initialProjectStore("python3 -m pytest -q -p no:cacheprovider").loops.find((l) => l.defaultKey === "refactor");
  return { project, repo, loop };
}

/**
 * One full run, the way NativeLoopScreen drives it: in an isolated worktree when `runId` is set (Refactoring), else
 * in the main checkout (the Test loop).
 */
async function runRefactoring({ project, repo, loop }, runId, agentOpts = {}, drive = null) {
  const worktree = runId ? path.join(project, "system", "loop-worktrees", runId) : repo;
  if (runId) git(repo, "worktree", "add", "-q", "-b", `refactor/${runId}`, worktree);
  const log = [];
  const agentCalls = [];
  const agent = scriptedAgent(worktree, agentCalls, agentOpts);
  const stageById = new Map(loop.config.stages.map((s) => [s.id, s]));
  const host = async (command, args = {}) => {
    switch (command) {
      case "loop_run_stage": {
        const r = spawnSync("sh", ["-c", stageById.get(args.stageId).command], { cwd: worktree, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
        return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false };
      }
      case "loop_changed_paths": return changedPaths(worktree);
      case "loop_worktree_diff": return { text: git(worktree, "diff", "HEAD"), truncated: false };
      case "loop_revert_paths": {
        for (const p of args.paths ?? []) {
          if ((args.created ?? []).includes(p)) fs.rmSync(path.join(worktree, p), { recursive: true, force: true });
          else git(worktree, "checkout", "--", p);
        }
        return null;
      }
      case "graph_generate": {
        const outDir = path.join(project, args.out ?? "system/graph");
        fs.mkdirSync(outDir, { recursive: true });
        execFileSync(process.execPath, [GRAPH_KIT, "code", path.join(project, args.target ?? ""), "--out", path.join(outDir, "graph-code.json")], { stdio: "ignore" });
        return { path: `${args.out ?? "system/graph"}/graph-code.json`, nodes: 0, edges: 0 };
      }
      // The host's worktree checkpoint: the tree of the worktree as it is now, with nothing committed.
      case "loop_worktree_checkpoint": {
        git(worktree, "add", "-A", "--", ".", ":(exclude).factory");
        return git(worktree, "write-tree").trim();
      }
      case "loop_worktree_restore": {
        git(worktree, "add", "-A", "--", ".", ":(exclude).factory");
        git(worktree, "read-tree", "--reset", "-u", args.tree);
        return null;
      }
      default: throw new Error(`the fake host has no ${command}`);
    }
  };
  // The core client's 30 s default would cut every agent call; each call must carry a timeout that covers its body's.
  const core = {
    async request(p, o) {
      if (p !== "/kb/loop/agent-run") throw new Error(`no core route ${p}`);
      if (!(typeof o.timeoutMs === "number" && typeof o.body?.timeoutMs === "number" && o.timeoutMs >= o.body.timeoutMs)) {
        throw new Error(`agent-run request timeout ${o.timeoutMs} does not cover its body's ${o.body?.timeoutMs} ms (the core default is 30 s)`);
      }
      return agent(o.body);
    },
  };
  const fsx = hostFs(project);
  const ctx = {
    projectRoot: project, runId, runRoot: worktree, fs: fsx, host, core,
    log: (l) => log.push(l), approvalToken: async () => "token", isCancelled: () => false, markCancelled() {},
  };
  const deps = { ...createStageDeps(ctx, loop), log: (l) => log.push(l), isCancelled: () => false };
  // `drive` runs the Refactoring batch driver the way NativeLoopScreen wires it for a worktree run.
  const outcome = drive
    ? await runRefactorBatches(loop.config, deps, {
      maxBatches: drive.maxBatches,
      checkpoint: () => host("loop_worktree_checkpoint", { runId }),
      restore: (tree) => host("loop_worktree_restore", { runId, tree }),
      readPlan: async () => { try { return (await fsx.read(`${path.relative(project, worktree)}/${PLAN_REL}`, 2_000_000)).text; } catch { return null; } },
      writePlan: (text) => fsx.write(`${path.relative(project, worktree)}/${PLAN_REL}`, text, { expected_hash: null, force: true }),
      log: (l) => log.push(l),
    })
    : await runNativeLoop(loop.config, deps);
  return { outcome, log, agentCalls, worktree };
}

test("the desktop's Refactoring loop is allowed to apply in its worktree", { skip }, () => {
  const { loop } = makeProject();
  assert.equal(loop.config.alwaysUseWorktree, true);
  assert.equal(batchRollbackReason(loop), null);
});

test("a full Refactoring run passes every stage on a real repo, and a second run does too", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  for (const runId of ["r1", "r2"]) {
    const { outcome, log, agentCalls, worktree } = await runRefactoring(p, runId);
    const summary = outcome.stages.map((o) => `${o.ok ? "ok  " : "FAIL"} ${o.stage.name}${o.ok ? "" : `\n      ${o.output.split("\n").slice(0, 4).join("\n      ")}`}`).join("\n");
    if (DISCOVER) console.log(`--- run ${runId}: ${outcome.statusSummary}\n${summary}\nwrites the host would refuse: ${[...REFUSED].join(", ") || "none"}\n--- log ---\n${log.join("\n")}`);
    assert.equal(outcome.passed, true, `run ${runId}: ${outcome.statusSummary}\n${summary}\n--- log tail ---\n${log.slice(-25).join("\n")}`);
    assert.deepEqual(agentCalls, ["skills/refactor-planner", "skills/test-gap-writer", "skills/refactor-apply", "skills/refactor-conform"]);
    assert.ok(!fs.existsSync(path.join(worktree, "legacy.py")), "the batch was applied in the worktree");
    assert.ok(fs.existsSync(path.join(p.repo, "legacy.py")), "the main checkout is untouched");
    assert.ok(fs.existsSync(path.join(p.project, `system/loop-runs/${runId}/graph/before.json`)), "the snapshot is the run's own");
    assert.ok(!fs.existsSync(path.join(p.project, "system/graph/graph-code.json")), "the project's main graph is never written by a worktree run");
  }
});

test("a full Test loop run passes every stage in the main checkout, and a second run does too", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  const testLoop = initialProjectStore("python3 -m pytest -q -p no:cacheprovider").loops.find((l) => l.defaultKey === "test");
  for (const round of [1, 2]) {
    const { outcome, log } = await runRefactoring({ ...p, loop: testLoop }, null);
    const summary = outcome.stages.map((o) => `${o.ok ? "ok  " : "FAIL"} ${o.stage.name}${o.ok ? "" : `\n      ${o.output.split("\n").slice(0, 4).join("\n      ")}`}`).join("\n");
    if (DISCOVER) console.log(`--- test loop round ${round}: ${outcome.statusSummary}\n${summary}\n--- log ---\n${log.join("\n")}`);
    assert.equal(outcome.passed, true, `round ${round}: ${outcome.statusSummary}\n${summary}`);
  }
  assert.ok(fs.existsSync(path.join(p.repo, "tests/test_tax.py")), "Test Write's test is kept in the main checkout");
});

test("a Plan agent that returns no reply fails the run, and the Plan stage says so", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  const { outcome, log, agentCalls } = await runRefactoring(p, "e1", { emptyPlan: true, unrepairable: true });
  if (DISCOVER) console.log(`--- empty plan: ${outcome.statusSummary}\n--- log ---\n${log.join("\n")}`);
  assert.equal(outcome.passed, false, outcome.statusSummary);
  const plan = outcome.stages.find((o) => o.stage.skillId === "skills/refactor-planner");
  assert.equal(plan.ok, false);
  assert.match(plan.output, /^the agent returned no reply\n/, plan.output);
  assert.ok(!agentCalls.includes("skills/refactor-apply"), "nothing is applied after a Plan with no reply");
});

test("an Apply that says Applied but leaves its batch at todo fails the stage and the run", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  const { outcome, log } = await runRefactoring(p, "e2", { applyLeavesTodo: true, unrepairable: true });
  if (DISCOVER) console.log(`--- apply leaves todo: ${outcome.statusSummary}\n--- log ---\n${log.join("\n")}`);
  assert.equal(outcome.passed, false, outcome.statusSummary);
  const apply = outcome.stages.find((o) => o.stage.skillId === "skills/refactor-apply");
  assert.equal(apply.ok, false);
  assert.match(apply.output, /the plan still shows R1 as todo after Apply/, apply.output);
});

test("a batch that breaks the tests is repaired, and iteration 2 neither re-plans, re-applies nor retakes the baseline", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  const { outcome, log, agentCalls, worktree } = await runRefactoring(p, "r3", { applyBreaks: true });
  const summary = outcome.stages.map((o) => `${o.ok ? "ok  " : "FAIL"} ${o.stage.name}`).join("\n");
  if (DISCOVER) console.log(`--- repair run: ${outcome.statusSummary}\n${summary}\n--- log ---\n${log.join("\n")}`);
  assert.equal(outcome.passed, true, `${outcome.statusSummary}\n${summary}`);
  assert.ok(outcome.iterationsUsed >= 2, "the failed Test was repaired and the loop went round again");
  assert.deepEqual(agentCalls.filter((c) => c !== "repair"), ["skills/refactor-planner", "skills/test-gap-writer", "skills/refactor-apply", "skills/refactor-conform"], "each skill ran once");
  const before = JSON.parse(fs.readFileSync(path.join(p.project, "system/loop-runs/r3/graph/before.json"), "utf8"));
  assert.ok(before.nodes.some((n) => n.id === "file:legacy.py"), "the baseline is the tree before the batch, not the refactored one");
  assert.ok(!fs.existsSync(path.join(worktree, "legacy.py")));
});

test("a test writer that weakens an existing test is reverted and the stage fails", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  const { outcome, worktree } = await runRefactoring(p, "r4", { weakenGolden: true });
  const writer = outcome.stages.find((o) => o.stage.name === "Refactor Test Write");
  assert.equal(writer.ok, false, "the weakening write is caught");
  assert.match(writer.output, /tests\/test_golden\.py/);
  assert.equal(fs.readFileSync(path.join(worktree, "tests/test_golden.py"), "utf8"), fs.readFileSync(path.join(p.repo, "tests/test_golden.py"), "utf8"), "the existing test is restored");
});

test("two batches are both applied in one Refactoring run, each with its own baseline", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  const { outcome, log, agentCalls, worktree } = await runRefactoring(p, "b1", { twoBatches: true }, { maxBatches: 3 });
  const summary = outcome.stages.map((o) => `${o.ok ? "ok  " : "FAIL"} ${o.stage.name}`).join("\n");
  if (DISCOVER) console.log(`--- two batches: ${outcome.statusSummary}\n${summary}\n--- log ---\n${log.join("\n")}`);
  assert.equal(outcome.passed, true, `${outcome.statusSummary}\n${summary}\n--- log tail ---\n${log.slice(-25).join("\n")}`);
  assert.equal(outcome.statusSummary, "2 batches applied (R1, R2)");
  assert.deepEqual(agentCalls, ["skills/refactor-planner", "skills/test-gap-writer", "skills/refactor-apply", "skills/refactor-conform", "skills/test-gap-writer", "skills/refactor-apply", "skills/refactor-conform"]);
  const plan = fs.readFileSync(path.join(worktree, PLAN_REL), "utf8");
  assert.match(plan, /### R1 .*\(status: done\)/);
  assert.match(plan, /### R2 .*\(status: done\)/);
  assert.ok(!fs.existsSync(path.join(worktree, "legacy.py")), "R1 is applied");
  assert.ok(fs.existsSync(path.join(worktree, "fmt.py")), "R2 is applied");
  // Batch 2's baseline was retaken after batch 1: legacy.py is no longer in the graph it is judged against.
  const before = JSON.parse(fs.readFileSync(path.join(p.project, "system/loop-runs/b1/graph/before.json"), "utf8"));
  assert.ok(!before.nodes.some((n) => n.id === "file:legacy.py"), "the baseline for batch 2 is the tree after batch 1");
});

test("a batch that breaks the tests and cannot be repaired is rolled back, and the earlier batch stays", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  const { outcome, log, worktree } = await runRefactoring(p, "b2", { twoBatches: true, breakBatch: "R2", unrepairable: true }, { maxBatches: 3 });
  if (DISCOVER) console.log(`--- rollback: ${outcome.statusSummary}\n--- log ---\n${log.join("\n")}`);
  assert.equal(outcome.passed, true, outcome.statusSummary);
  assert.match(outcome.statusSummary, /^1 batch applied \(R1\); R2 rolled back: /);
  assert.equal(outcome.failedStage, null, "a later rollback does not fail the run");
  // The worktree is the state after R1: legacy.py gone, R2's module and its tax change absent.
  assert.ok(!fs.existsSync(path.join(worktree, "legacy.py")), "R1 is kept");
  assert.ok(!fs.existsSync(path.join(worktree, "fmt.py")), "R2's new file is removed");
  assert.equal(fs.readFileSync(path.join(worktree, "shop.py"), "utf8"), fs.readFileSync(path.join(p.repo, "shop.py"), "utf8"), "R2's edit is reverted");
  const plan = fs.readFileSync(path.join(worktree, PLAN_REL), "utf8");
  assert.match(plan, /### R1 .*\(status: done\)/);
  assert.match(plan, /### R2 .*\(status: blocked\)\n- Blocked: Test — Test failed; repair did not complete\n/);
});

test("the Test loop's map finds untested functions even when the project has no graph yet", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  assert.ok(!fs.existsSync(path.join(p.project, "system/graph/graph-code.json")), "no project graph before the run");
  const testLoop = initialProjectStore("python3 -m pytest -q -p no:cacheprovider").loops.find((l) => l.defaultKey === "test");
  const { outcome } = await runRefactoring({ ...p, loop: testLoop }, null);
  const map = outcome.stages.find((o) => o.stage.name === "Test Map");
  const m = /(\d+) function\(s\) · (\d+) untested/.exec(map.output);
  assert.ok(m, map.output);
  assert.ok(Number(m[1]) >= 20, `the map sees the app's functions, not just its test files: ${map.output}`);
  assert.ok(Number(m[2]) > 0, `some functions are untested (utils.py, legacy.py): ${map.output}`);
  const json = JSON.parse(fs.readFileSync(path.join(p.repo, "system/loop/test/TEST-MAP.json"), "utf8"));
  assert.ok(json.entries.some((e) => e.path === "utils.py" && e.testedBy.length === 0), "utils.py is listed as untested");
});

test("a Plan that lists a file outside the input path fails the Plan stage, and the message names the batch and file", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  p.loop.inputPath = "tools";
  const { outcome, log } = await runRefactoring(p, "s1", { unrepairable: true });
  if (DISCOVER) console.log(`--- plan outside input path: ${outcome.statusSummary}\n--- log ---\n${log.join("\n")}`);
  assert.equal(outcome.passed, false, outcome.statusSummary);
  const plan = outcome.stages.find((o) => o.stage.skillId === "skills/refactor-planner");
  assert.equal(plan.ok, false);
  assert.match(plan.output, /batch R1 lists legacy\.py, which is outside the input path tools/, plan.output);
});

test("a Plan inside the input path passes, and the planner is told the input path", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  p.loop.inputPath = "tools";
  const seen = [];
  const { outcome, log } = await runRefactoring(p, "s2", { planFiles: "tools/measure.py", unrepairable: true, seen });
  if (DISCOVER) console.log(`--- plan inside input path: ${outcome.statusSummary}\n--- log ---\n${log.join("\n")}`);
  const plan = outcome.stages.find((o) => o.stage.skillId === "skills/refactor-planner");
  assert.equal(plan.ok, true, plan.output);
  const planner = seen.find((c) => c.skill === "skills/refactor-planner");
  assert.match(planner.message, /^Target path: tools$/m);
  assert.match(planner.message, /^Input path: tools \(relative to the repository root\)\./m);
});

test("an Apply that edits a file outside the input path fails with the contract message", { skip, timeout: 240_000 }, async () => {
  const p = makeProject();
  p.loop.inputPath = "tools";
  const { outcome, log, worktree } = await runRefactoring(p, "s3", { planFiles: "tools/measure.py", editOutside: "shop.py", unrepairable: true });
  if (DISCOVER) console.log(`--- apply outside input path: ${outcome.statusSummary}\n--- log ---\n${log.join("\n")}`);
  assert.equal(outcome.passed, false, outcome.statusSummary);
  const apply = outcome.stages.find((o) => o.stage.skillId === "skills/refactor-apply");
  assert.equal(apply.ok, false);
  assert.match(apply.output, /Apply changed shop\.py, which is outside the input path tools and is more than an import update/, apply.output);
  assert.match(fs.readFileSync(path.join(worktree, "shop.py"), "utf8"), /a body change outside the input path/, "the edit is in the worktree, and the contract is what failed it");
});
