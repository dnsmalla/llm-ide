import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTestPlan, writeTestPlan, testSuiteExists } from "../native/test-plan.ts";
import { runTestSteps, TEST_RECIPE } from "../native/test-steps.ts";
import { nextTodo, splitPhases } from "../native/step-driver.ts";
import { decodeConfig } from "../native/model.ts";

const entry = (path, fn = "f", over = {}) => ({ path, function: fn, line: 1, fanIn: 0, loc: 10, testedBy: [], ...over });
const map = (entries) => ({ generatedAt: "", source: "graph", entries, untestedFunctions: 0, testedFunctions: 0, untestedFiles: 0, notes: [] });
const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "svc", testDir: "svc/tests", runner: "pytest", command: "pytest", languages: ["py"] }] };
const heads = (text) => [...text.matchAll(/^### (T\d+) (\S+) \(status: (\w+)\)$/gm)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);

test("one step per untested file, area by area, with functions and the test file", () => {
  const m = map([
    entry("svc/a.py", "one"), entry("svc/a.py", "two", { fanIn: 2 }), entry("web/x.ts", "x", { fanIn: 1 }), entry("web/y.ts", "y"), entry("web/z.ts", "z"),
    entry("svc/done.py", "d", { testedBy: ["svc/tests/test_done.py"] }),
    entry("svc/tests/test_a.py", "t"), entry("web/vendor/lib.ts", "v"), entry("web/node_modules/p/i.ts", "n"),
  ]);
  const { plan, info } = mergeTestPlan(null, m, structure);
  // web has 3 untested files (weight 4), svc has 1 (weight 3): web first, fan-in then path inside it.
  assert.deepEqual(heads(plan), ["T1 web/x.ts todo", "T2 web/y.ts todo", "T3 web/z.ts todo", "T4 svc/a.py todo"].filter((l) => !l.includes("vendor")));
  assert.match(plan, /### T4 svc\/a\.py \(status: todo\)\n- Area: svc\n- Functions: one, two\n- Test file: svc\/tests\/test_a\.py\n/);
  assert.doesNotMatch(plan, /### T1 web\/x\.ts[^#]*Test file/, "no test root owns web/");
  assert.equal(info.todo.length, 4);
  assert.match(plan, /\| todo \| 4 \|/);
  assert.match(plan, /\| areas \| 2 \|/);
});

test("statuses, ids and reason lines survive; a tested todo becomes done; a gone todo is dropped; new files append", () => {
  const first = mergeTestPlan(null, map([entry("a/1.py"), entry("a/2.py"), entry("a/3.py"), entry("a/4.py")]), structure).plan;
  const edited = first
    .replace("### T1 a/1.py (status: todo)", "### T1 a/1.py (status: skipped)\n- Skipped: trivial")
    .replace("### T2 a/2.py (status: todo)", "### T2 a/2.py (status: blocked)\n- Blocked: Test — failed");
  const m2 = map([entry("a/1.py"), entry("a/2.py"), entry("a/3.py", "f", { testedBy: ["a/tests/x.py"] }), entry("b/new.py")]); // a/4.py is gone
  const { plan } = mergeTestPlan(edited, m2, structure);
  assert.deepEqual(heads(plan), ["T5 b/new.py todo", "T1 a/1.py skipped", "T2 a/2.py blocked", "T3 a/3.py done"]);
  assert.match(plan, /\(status: skipped\)\n- Skipped: trivial\n- Area: a\n/);
  assert.match(plan, /\(status: blocked\)\n- Blocked: Test — failed\n/);
  const again = mergeTestPlan(plan, m2, structure).plan;
  assert.equal(again, plan, "a second merge changes nothing");
  // T4 was dropped, so its number is never reused: the next new file is T6.
  assert.match(mergeTestPlan(plan, map([...m2.entries, entry("c/n.py")]), structure).plan, /### T6 c\/n\.py \(status: todo\)/);
});

test("a file over 500 lines goes to Refactor first and is not a step", () => {
  const { plan, info } = mergeTestPlan(null, map([entry("a/big.py", "f", { loc: 900 }), entry("a/ok.py")]), structure);
  assert.deepEqual(heads(plan), ["T1 a/ok.py todo"]);
  assert.match(plan, /## Refactor first\n[\s\S]*- a\/big\.py \(900 lines\)/);
  assert.deepEqual(info.refactorFirst, [{ path: "a/big.py", loc: 900 }]);
});

test("a file-walk entry (function *) has no Functions line", () => {
  assert.doesNotMatch(mergeTestPlan(null, map([entry("a/x.py", "*")]), structure).plan, /Functions/);
});

test("a plan over ~250 lines keeps the next 40 todo steps and moves finished ones to the done file", () => {
  const files = Array.from({ length: 100 }, (_, i) => entry(`a/f${String(i).padStart(3, "0")}.py`));
  const first = mergeTestPlan(null, map(files), structure);
  assert.equal(heads(first.plan).length, 40);
  assert.match(first.plan, /\| todo \| 100 \|/);
  assert.match(first.plan, /60 more todo steps are not listed yet/);
  const marked = first.plan.replace("### T1 a/f000.py (status: todo)", "### T1 a/f000.py (status: done)");
  const next = mergeTestPlan(marked, map(files.slice(1)), structure, first.done);
  assert.match(next.done, /### T1 a\/f000\.py \(status: done\)/);
  assert.ok(!next.plan.includes("T1 a/f000.py"));
  assert.equal(heads(next.plan).length, 40);
  assert.match(next.plan, /\| done \| 1 \|/);
  assert.match(next.plan, /\| nextId \| 42 \|/);
  const ids = new Set([...heads(next.plan), ...heads(next.done)].map((h) => h.split(" ")[0]));
  assert.equal(ids.size, 41, "ids are unique across both files");
});

test("writeTestPlan reads the previous plan and writes both files", async () => {
  const files = {};
  const fs = { async read(p) { if (!(p in files)) throw new Error("missing"); return { status: "ok", text: files[p] }; }, async write(p, t) { files[p] = t; }, async create() {} };
  await writeTestPlan(fs, "repo", map([entry("a/x.py")]), structure);
  assert.match(files["repo/llm-doc/loop/test/TEST-PLAN.md"], /### T1 a\/x\.py \(status: todo\)/);
});

// ---- the Test recipe of the shared step driver
const stage = (id, over = {}) => ({ id, name: id, kind: "shellCommand", order: 0, enabled: true, severity: "blocking", allowsRepair: true, ...over });
const S = [
  stage("map", { kind: "testMap", testOp: "map", defaultKey: "test-map" }),
  stage("write", { kind: "skill", skillId: "skills/test-gap-writer", defaultKey: "test-write" }),
  stage("test", { defaultKey: "test" }),
  stage("custom"),
];
const cfg = (over = {}) => decodeConfig({ stages: S, maxIterations: 1, maxRepairsPerStage: 1, consecutiveFailureStop: 3, stageDelaySeconds: 0, ...over });
const T = (id, status = "todo") => `### ${id} a/${id}.py (status: ${status})\n- Area: a\n`;

function fake(plan, { fail = [], skip = [], leave = [] } = {}) {
  const st = { plan, ran: [], restores: [], current: null, snaps: {}, n: 0 };
  const deps = {
    async runStage(s) {
      st.ran.push(s.id);
      if (s.id === "write") {
        st.current = nextTodo(TEST_RECIPE, st.plan).id;
        if (!leave.includes(st.current)) st.plan = st.plan.replace(`### ${st.current} a/${st.current}.py (status: todo)`, `### ${st.current} a/${st.current}.py (status: ${skip.includes(st.current) ? "skipped" : "done"})`);
      }
      if (s.id === "test" && fail.includes(st.current)) return { ok: false, output: "TAP version 13\nok 1 - a\nnot ok 2 - totals add the tax\n  expected 3" };
      return { ok: true, output: "" };
    },
    async repair() { return { ok: false, output: "no" }; }, log() {}, isCancelled() { return false; },
  };
  const opts = {
    async checkpoint() { const t = `t${++st.n}`; st.snaps[t] = st.plan; return t; },
    async restore(t) { st.restores.push(t); st.plan = st.snaps[t]; },
    async readPlan() { return st.plan; }, async writePlan(t) { st.plan = t; }, log() {},
  };
  return { st, deps, opts };
}

test("the Test recipe splits map-and-before from write-and-after; an unknown stage keeps its position", () => {
  const { planning, batch } = splitPhases(TEST_RECIPE, S);
  assert.deepEqual(planning.map((s) => s.id), ["map"]);
  assert.deepEqual(batch.map((s) => s.id), ["write", "test", "custom"]);
});

test("steps run one at a time up to the limit, each marked by the agent", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2") + T("T3") + T("T4"), { skip: ["T2"] });
  const out = await runTestSteps(cfg(), deps, opts); // default limit 3
  assert.equal(out.passed, true);
  assert.equal(out.statusSummary, "2 steps done (T1, T3); T2 skipped; step limit (3) reached");
  assert.equal(st.ran.filter((i) => i === "map").length, 1, "planning runs once");
  assert.equal(nextTodo(TEST_RECIPE, st.plan).id, "T4");
});

test("a failed step is rolled back and blocked, and the run goes on with the next step", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2"), { fail: ["T1"] });
  const out = await runTestSteps(cfg(), deps, opts);
  assert.equal(out.passed, true);
  assert.deepEqual(st.restores, ["t1"]);
  assert.match(st.plan, /### T1 a\/T1\.py \(status: blocked\)\n- Blocked: test — /);
  assert.match(st.plan, /### T2 a\/T2\.py \(status: done\)/);
  assert.match(out.statusSummary, /^1 step done \(T2\); T1 rolled back: /);
});

test("three blocked steps in a row stop the run and it does not pass", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2") + T("T3") + T("T4"), { fail: ["T1", "T2", "T3", "T4"] });
  const out = await runTestSteps(cfg({ maxPassesPerRun: 10 }), deps, opts);
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /3 steps in a row were blocked; stopped/);
  assert.equal(nextTodo(TEST_RECIPE, st.plan).id, "T4");
});

test("a step its run passed but did not mark is written off as skipped, and the run goes on", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2"), { leave: ["T1"] });
  const out = await runTestSteps(cfg(), deps, opts);
  assert.equal(out.passed, true);
  assert.equal(out.statusSummary, "1 step done (T2); T1 skipped");
  assert.match(st.plan, /### T1 a\/T1\.py \(status: skipped\)\n- Skipped: its run passed but did not mark the step/);
});

test("a loop with Test Write turned off runs as one plain loop", async () => {
  const { st, deps, opts } = fake(T("T1"));
  const off = S.map((s) => (s.id === "write" ? { ...s, enabled: false } : s));
  await runTestSteps(cfg({ stages: off }), deps, opts);
  assert.equal(st.n, 0, "no checkpoint was taken");
});

test("a suite that was already red leaves the failing step todo and ends the run, instead of blocking it", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2"), { fail: ["T1"] });
  const run = deps.runStage;
  // The check after planning runs Test before any step: red here means the suite, not the new test.
  deps.runStage = async (s) => (s.id === "test" && st.current === null ? { ok: false, output: "red before" } : run(s));
  opts.restore = async (t) => { st.restores.push(t); }; // like the real state folder: the plan is not reverted
  const out = await runTestSteps(cfg(), deps, opts);
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /T1 rolled back and left todo/);
  assert.match(st.plan, /### T1 a\/T1\.py \(status: todo\)/, "the agent's done mark is undone");
  assert.equal(st.ran.filter((i) => i === "write").length, 1, "no further step is tried");
});

test("mid-run nothing moves to the finished file, so the step in flight stays in the live plan", () => {
  const files = Array.from({ length: 70 }, (_, i) => entry(`a/f${String(i).padStart(3, "0")}.py`));
  const first = mergeTestPlan(null, map(files), structure);
  const id = heads(first.plan)[0].split(" ")[0];
  const marked = first.plan.replace(new RegExp(`### ${id} (\\S+) \\(status: todo\\)`), `### ${id} $1 (status: done)`);
  const during = mergeTestPlan(marked, map(files), structure, first.done, false);
  assert.match(during.plan, new RegExp(`### ${id} \\S+ \\(status: done\\)`), "Test Map Check keeps the step where the driver reads it");
  const planning = mergeTestPlan(marked, map(files), structure, first.done);
  assert.ok(!planning.plan.includes(`### ${id} `) && planning.done.includes(`### ${id} `), "the next planning pass moves it out");
});

test("an area that was started keeps its place while its steps are finished", () => {
  const files = [...["a1", "a2", "a3", "a4", "a5"].map((n) => entry(`src/a/${n}.py`)), ...["b1", "b2", "b3", "b4"].map((n) => entry(`src/b/${n}.py`))];
  let plan = mergeTestPlan(null, map(files), structure).plan;
  for (let i = 0; i < 3; i++) {
    const [id, path] = heads(plan).find((h) => h.endsWith(" todo")).split(" ");
    assert.match(path, /^src\/a\//, "area a is finished before area b starts");
    plan = mergeTestPlan(plan.replace(`### ${id} ${path} (status: todo)`, `### ${id} ${path} (status: done)`), map(files), structure).plan;
  }
});

const withFiles = (n) => `# Test plan\n\n| counter | value |\n|---|---|\n| testFiles | ${n} |\n\n${T("T1")}${T("T2")}`;
const redBefore = (fx) => { const run = fx.deps.runStage; fx.deps.runStage = async (s) => (s.id === "test" && fx.st.current === null ? { ok: false, output: "red before" } : run(s)); };

test("a red suite with test files already present stops before any step, with no agent call", async () => {
  const fx = fake(withFiles(4)); redBefore(fx);
  const out = await runTestSteps(cfg(), fx.deps, fx.opts);
  assert.equal(out.passed, false);
  assert.equal(out.failedStage.id, "test");
  assert.equal(out.statusSummary, "the tests were already failing before any step, so none was run: test failed — fix the failing tests first");
  assert.ok(!fx.st.ran.includes("write"));
});

test("a red suite with no test file yet still runs the first step, and the run goes on when it passes", async () => {
  const fx = fake(withFiles(0)); redBefore(fx);
  const out = await runTestSteps(cfg(), fx.deps, fx.opts);
  assert.equal(out.passed, true);
  assert.equal(fx.st.ran.filter((i) => i === "write").length, 2);
  assert.match(out.statusSummary, /2 steps done/);
});

test("the testFiles counter round-trips through the plan, also when the plan is trimmed; an older map writes none", () => {
  assert.match(mergeTestPlan(null, { ...map([entry("a/1.py")]), testFiles: 7 }, structure).plan, /\| testFiles \| 7 \|/);
  const many = Array.from({ length: 70 }, (_, i) => entry(`a/f${String(i).padStart(3, "0")}.py`));
  assert.match(mergeTestPlan(null, { ...map(many), testFiles: 3 }, structure).plan, /\| testFiles \| 3 \|/);
  assert.doesNotMatch(mergeTestPlan(null, map([entry("a/1.py")]), structure).plan, /testFiles/);
  assert.equal(testSuiteExists(withFiles(0)), false);
  assert.equal(testSuiteExists(withFiles(2)), true);
  assert.equal(testSuiteExists(T("T1", "done")), true, "no counter: a done step means tests exist");
  assert.equal(testSuiteExists(T("T1")), false);
});

test("a halted step ends the run: later steps are not blocked without having run", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2") + T("T3"));
  let halted = null;
  const run = deps.runStage;
  deps.runStage = async (s) => { const r = await run(s); if (s.id === "write") halted = "agent touched protected path(s)"; return r; };
  deps.halt = () => halted;
  opts.restore = async (t) => { st.restores.push(t); };
  const out = await runTestSteps(cfg(), deps, opts);
  assert.equal(out.passed, false);
  assert.equal(st.ran.filter((i) => i === "write").length, 1);
  assert.match(st.plan, /### T2 a\/T2\.py \(status: todo\)/, "T2 never ran, so it is still todo");
  assert.match(st.plan, /### T1 a\/T1\.py \(status: blocked\)/);
});

test("a folder with many source files is split into its sub-folders as areas, and that does not change as steps finish", () => {
  const big = [];
  for (const sub of ["chat", "loop", "graph"]) for (let i = 0; i < 15; i++) big.push(entry(`ui/screens/${sub}/f${String(i).padStart(2, "0")}.ts`));
  const small = [entry("web/src/a.ts"), entry("web/src/b.ts")];
  let plan = mergeTestPlan(null, map([...big, ...small]), structure).plan;
  const areas = () => [...new Set([...plan.matchAll(/^- Area: (.+)$/gm)].map((m) => m[1]))];
  assert.deepEqual(areas().sort(), ["ui/screens/chat", "ui/screens/graph", "ui/screens/loop", "web/src"]);
  // Tested files still count toward the folder's size, so the split holds while the work goes on.
  const tested = big.map((e, i) => (i < 30 ? { ...e, testedBy: ["t"] } : e));
  plan = mergeTestPlan(plan, map([...tested, ...small]), structure).plan;
  assert.ok(areas().every((a) => a.startsWith("ui/screens/") || a === "web/src"), areas().join(", "));
});

test("a step skipped without a file change does not run the suite; one that wrote a file does", async () => {
  const a = fake(T("T1") + T("T2"), { skip: ["T1"] });
  a.opts.checkpoint = async () => "same-tree"; // nothing outside the plan changed
  const out = await runTestSteps(cfg({ maxPassesPerRun: 1 }), a.deps, a.opts);
  assert.equal(out.statusSummary, "0 steps done; T1 skipped; step limit (1) reached");
  // The suite ran once for the check after planning, and not again for the skipped step.
  assert.deepEqual(a.st.ran, ["map", "test", "write"]);
  const b = fake(T("T1") + T("T2"), { skip: ["T1"] }); // the default fake returns a new tree id each time: something changed
  await runTestSteps(cfg({ maxPassesPerRun: 1 }), b.deps, b.opts);
  assert.deepEqual(b.st.ran, ["map", "test", "write", "test", "custom"], "a skipped step that changed files is still checked");
  const c = fake(T("T1"));
  c.opts.checkpoint = async () => "same-tree";
  await runTestSteps(cfg({ maxPassesPerRun: 1 }), c.deps, c.opts);
  assert.deepEqual(c.st.ran, ["map", "test", "write", "test", "custom"], "a done step is always checked");
});

test("a failing new test is never repaired: the step is rolled back and blocked, and no repair agent runs", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2"), { fail: ["T1"] });
  let repairs = 0;
  deps.repair = async () => { repairs += 1; return { ok: true, output: "edited the source until it passed" }; };
  const out = await runTestSteps(cfg({ maxRepairsPerStage: 3 }), deps, opts);
  assert.equal(repairs, 0, "a repair could change source or build config to make the test pass");
  assert.match(out.statusSummary, /1 step done \(T2\); T1 rolled back: /);
  assert.match(st.plan, /### T1 a\/T1\.py \(status: blocked\)\n- Blocked: test — /);
});

test("a failing new test gets no second round and no repair, whatever the loop's settings: rolled back, blocked, next step", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2"), { fail: ["T1"] });
  let repairs = 0;
  deps.repair = async () => { repairs += 1; return { ok: true, output: "" }; };
  const out = await runTestSteps(cfg({ maxIterations: 3, maxRepairsPerStage: 3 }), deps, opts);
  assert.equal(repairs, 0, "the repair agent is not bound by the test writer's rules");
  // A second round would re-run Test Write, which would take T2 (T1 is already marked) and leave T1 looking done.
  assert.equal(st.ran.filter((i) => i === "write").length, 2, "one Test Write per step, none repeated");
  assert.match(st.plan, /### T1 a\/T1\.py \(status: blocked\)\n- Blocked: test — /);
  assert.match(out.statusSummary, /^1 step done \(T2\); T1 rolled back: /);
});

test("a step may only mark itself: a mark it puts on another step is put back", async () => {
  const { st, deps, opts } = fake(T("T1") + T("T2") + T("T3"));
  const run = deps.runStage;
  deps.runStage = async (s) => {
    const r = await run(s);
    // The agent also "finishes" T3 while working on T1.
    if (s.id === "write" && st.current === "T1") st.plan = st.plan.replace("### T3 a/T3.py (status: todo)", "### T3 a/T3.py (status: done)");
    return r;
  };
  const out = await runTestSteps(cfg({ maxPassesPerRun: 1 }), deps, opts);
  assert.equal(out.statusSummary, "1 step done (T1); step limit (1) reached");
  assert.match(st.plan, /### T3 a\/T3\.py \(status: todo\)/, "T3 is still to do");
  assert.match(st.plan, /### T1 a\/T1\.py \(status: done\)/);
});

test("a blocked step's reason names the first failing test line", async () => {
  const { st, deps, opts } = fake(T("T1"), { fail: ["T1"] });
  await runTestSteps(cfg(), deps, opts);
  assert.match(st.plan, /- Blocked: test — .*\(not ok 2 - totals add the tax\)/);
});
