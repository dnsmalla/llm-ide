// The Test loop's step plan: one `### T<n> <path> (status: …)` step per untested SOURCE FILE, written by code from the test
// map, so a whole-repository run is divided at plan time and executed one step at a time (test-steps.ts). The agent only
// marks its own step done or skipped; statuses, IDs and the agent's reason lines survive every regeneration.
import { SKIP, ensureDir, type TestMap, type TestMapFs, type TestPlanInfo, type TestStructure } from "./testmap.ts";
import { TEST_PLAN_PATH, isTestFileName, isTestPath } from "./protected.ts";

export { TEST_PLAN_PATH };

export type StepStatus = "todo" | "done" | "skipped" | "blocked";
export interface TestPlanText { plan: string; done: string | null; info: TestPlanInfo }
interface Step { id: number; path: string; status: StepStatus; body: string[] }

export const TEST_PLAN_DONE_PATH = "llm-doc/loop/test/TEST-PLAN-DONE.md";
/** A file over this many lines is split by a refactor first, not tested in one step. */
export const BIG_FILE_LOC = 500;
const LIVE_LINE_LIMIT = 250;
const LIVE_TODO_STEPS = 40;
const MAX_FUNCTIONS = 8;
const HEAD = /^###\s+T(\d+)\s+(.*?)\s*\(status:\s*(todo|done|skipped|blocked)\)\s*$/;
const NEXT_ID = /^\|\s*nextId\s*\|\s*(\d+)\s*\|/;

function parse(text: string | null): { steps: Step[]; nextId: number } {
  const steps: Step[] = [];
  let nextId = 1;
  let cur: Step | null = null;
  for (const line of (text ?? "").split("\n")) {
    const h = HEAD.exec(line);
    if (h) { cur = { id: Number(h[1]), path: h[2], status: h[3] as StepStatus, body: [] }; steps.push(cur); continue; }
    const n = NEXT_ID.exec(line);
    if (n) nextId = Math.max(nextId, Number(n[1]));
    // A step's body ends at the next heading of any level (the "## Refactor first" list is not a step line).
    if (/^#{1,3}\s/.test(line)) cur = null;
    else if (cur && line.trim() !== "") cur.body.push(line);
  }
  return { steps, nextId };
}

const FAMILY: Record<string, string> = { py: "pytest", swift: "xctest", go: "go", rs: "cargo", ts: "npm", tsx: "npm", js: "npm", mjs: "npm", cjs: "npm" };

/** Where the new test goes, from the structure's test roots; null when no root of the file's language owns its package. */
function testFileFor(path: string, structure: TestStructure): string | null {
  const ext = path.split(".").pop() ?? "";
  const family = FAMILY[ext];
  const root = structure.roots
    .filter((r) => (r.runner === family || (r.runner === "jest" && family === "npm")) && (r.packageDir === "" || r.packageDir === "." || path.startsWith(`${r.packageDir}/`)))
    .sort((a, b) => b.packageDir.length - a.packageDir.length)[0];
  if (!root || family === "cargo") return null;
  const base = path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const dir = path.split("/").slice(0, -1).join("/");
  if (family === "pytest") return `${root.testDir}/test_${base}.py`;
  if (family === "xctest") return `${root.testDir}/${base.charAt(0).toUpperCase()}${base.slice(1)}Tests.swift`;
  if (family === "go") return `${dir ? `${dir}/` : ""}${base}_test.go`;
  return `${root.testDir}/${base}.test.${ext === "ts" || ext === "tsx" ? "ts" : "mjs"}`;
}

const vendored = (path: string) => path.split("/").some((seg) => SKIP.has(seg));
/** A folder with more source files than this is split into its sub-folders as areas of their own. */
export const AREA_SPLIT = 40;

/**
 * The area of each path. Two folder levels to start with (most repositories keep everything under one `src/`, which as
 * a single area would divide nothing), then one level deeper for as long as the folder holds more than AREA_SPLIT
 * source files, so `ui/screens` with hundreds of files becomes `ui/screens/chat`, `ui/screens/loop`, … The count is
 * of all source files in the map, tested or not, so finishing steps never changes which area a file is in.
 */
function areaIndex(paths: Iterable<string>): (path: string) => string {
  const dirsOf = (path: string) => path.split("/").slice(0, -1);
  const count = new Map<string, number>();
  for (const p of paths) {
    const dirs = dirsOf(p);
    for (let d = 1; d <= dirs.length; d++) { const k = dirs.slice(0, d).join("/"); count.set(k, (count.get(k) ?? 0) + 1); }
  }
  return (path) => {
    const dirs = dirsOf(path);
    if (dirs.length === 0) return "(root)";
    let d = Math.min(2, dirs.length);
    while (d < dirs.length && (count.get(dirs.slice(0, d).join("/")) ?? 0) > AREA_SPLIT) d++;
    return dirs.slice(0, d).join("/");
  };
}

/** Merges the map into the previous plan (and finished-steps file); see the module header for the rules. */
export function mergeTestPlan(previousText: string | null, map: TestMap, structure: TestStructure, doneText: string | null = null, moveFinished = true): TestPlanText {
  const prev = parse(previousText);
  const finished = parse(doneText);
  const known = new Map<string, Step>();
  for (const s of [...prev.steps, ...finished.steps]) if (!known.has(s.path)) known.set(s.path, s);
  let nextId = Math.max(prev.nextId, finished.nextId, ...[...known.values()].map((s) => s.id + 1));

  const files = new Map<string, { fanIn: number; loc: number; tested: boolean; fns: string[] }>();
  for (const e of map.entries) {
    const f = files.get(e.path) ?? { fanIn: 0, loc: 0, tested: false, fns: [] };
    f.fanIn = Math.max(f.fanIn, e.fanIn); f.loc = Math.max(f.loc, e.loc);
    if (e.testedBy.length > 0) f.tested = true;
    else if (e.function !== "*" && !f.fns.includes(e.function)) f.fns.push(e.function);
    files.set(e.path, f);
  }
  const areaOf = areaIndex(files.keys());
  const untested = (path: string) => { const f = files.get(path); return f !== undefined && !f.tested ? f : null; };
  const eligible = (path: string) => !isTestPath(path) && !isTestFileName(path) && !vendored(path);

  const bodyOf = (path: string): string[] => {
    const f = files.get(path)!;
    const lines = [`- Area: ${areaOf(path)}`];
    if (f.fns.length) lines.push(`- Functions: ${f.fns.slice(0, MAX_FUNCTIONS).join(", ")}${f.fns.length > MAX_FUNCTIONS ? `, +${f.fns.length - MAX_FUNCTIONS} more` : ""}`);
    const t = testFileFor(path, structure);
    if (t) lines.push(`- Test file: ${t}`);
    return lines;
  };

  const keep: Step[] = [];
  for (const s of prev.steps) {
    if (s.status !== "todo") { keep.push(s); continue; }
    const f = files.get(s.path);
    if (!f) continue; // the file is gone (or left the map's scope): a todo step is dropped, never a finished one
    keep.push(f.tested ? { ...s, status: "done" } : { ...s, body: bodyOf(s.path) });
  }
  const refactorFirst: { path: string; loc: number }[] = [];
  const fresh: Step[] = [];
  for (const [path, f] of files) {
    if (f.tested || known.has(path) || !eligible(path)) continue;
    if (f.loc > BIG_FILE_LOC) { refactorFirst.push({ path, loc: f.loc }); continue; }
    fresh.push({ id: 0, path, status: "todo", body: bodyOf(path) });
  }
  const todoAll = [...keep.filter((s) => s.status === "todo"), ...fresh];
  const score = new Map<string, number>();
  for (const s of todoAll) score.set(areaOf(s.path), (score.get(areaOf(s.path)) ?? 0) + 1 + (untested(s.path)?.fanIn ?? 0));
  // An area that already has numbered steps keeps its place (its lowest ID), so finishing steps never lets another
  // area overtake it; areas not started yet follow, ranked by score.
  const started = new Map<string, number>();
  for (const s of known.values()) started.set(areaOf(s.path), Math.min(started.get(areaOf(s.path)) ?? Infinity, s.id));
  const rank = (path: string) => started.get(areaOf(path)) ?? Infinity;
  const idOf = (s: Step) => (s.id === 0 ? Infinity : s.id);
  todoAll.sort((a, b) => (rank(a.path) - rank(b.path) || 0) || (score.get(areaOf(b.path))! - score.get(areaOf(a.path))!) || areaOf(a.path).localeCompare(areaOf(b.path))
    || (idOf(a) - idOf(b) || 0) || (untested(b.path)?.fanIn ?? 0) - (untested(a.path)?.fanIn ?? 0) || a.path.localeCompare(b.path));
  refactorFirst.sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path));

  const ended = keep.filter((s) => s.status !== "todo").sort((a, b) => a.id - b.id);
  const render = (s: Step) => [`### T${s.id} ${s.path} (status: ${s.status})`, ...s.body, ""];
  const count = (st: StepStatus) => [...ended, ...finished.steps].filter((s) => s.status === st).length;
  const areas = new Set(todoAll.map((s) => areaOf(s.path))).size;
  const tail = refactorFirst.length ? ["## Refactor first", "", `Over ${BIG_FILE_LOC} lines: split before testing.`, ...refactorFirst.slice(0, 40).map((r) => `- ${r.path} (${r.loc} lines)`), ""] : [];
  const build = (listed: Step[], finishedHere: Step[]) => [
    "# Test plan", "", "| counter | value |", "|---|---|", `| todo | ${todoAll.length} |`, `| done | ${count("done")} |`, `| skipped | ${count("skipped")} |`,
    `| blocked | ${count("blocked")} |`, `| areas | ${areas} |`, ...(map.testFiles === undefined ? [] : [`| testFiles | ${map.testFiles} |`]), `| nextId | ${nextId} |`, "",
    "One step per untested source file, area by area. Take the first `(status: todo)` step; mark it `done` or `skipped` (with a `- Skipped: <reason>` line).",
    ...(listed.length < todoAll.length ? [`${todoAll.length - listed.length} more todo steps are not listed yet; they are added as these are finished.`] : []), "",
    ...[...listed, ...finishedHere].flatMap(render), ...tail,
  ];
  // Too long: list only the existing todo steps plus enough new ones for 40, and move finished steps to the done file.
  // Numbers are given only to listed steps, so an unlisted file takes the next free number when it is listed.
  const over = build(todoAll, ended).length > LIVE_LINE_LIMIT;
  let room = LIVE_TODO_STEPS - todoAll.filter((s) => s.id !== 0).length;
  const listed = over ? todoAll.filter((s) => s.id !== 0 || room-- > 0) : todoAll;
  for (const s of listed) if (s.id === 0) s.id = nextId++;
  // Finished steps move out only at planning time: mid-run the driver must still find the step in flight in the live plan.
  const moved = over && moveFinished ? ended : [];
  const out = build(listed, moved.length ? [] : ended);
  const allDone = [...finished.steps, ...moved];
  const done = allDone.length ? ["# Test plan — finished steps", "", ...allDone.flatMap(render)] : null;
  return {
    plan: out.join("\n").replace(/\n+$/, "\n"),
    done: done ? done.join("\n").replace(/\n+$/, "\n") : null,
    info: { todo: todoAll.map((s) => ({ path: s.path, functions: untested(s.path)?.fns.length ?? 0 })), refactorFirst },
  };
}

/** Whether the repository already has test files, from the plan's counters; no counter (older plan) = it has, once a step is done. */
export function testSuiteExists(planText: string): boolean {
  const n = /^\|\s*testFiles\s*\|\s*(\d+)\s*\|/m.exec(planText);
  if (n) return Number(n[1]) > 0;
  return /^\|\s*done\s*\|\s*[1-9]\d*\s*\|/m.test(planText) || /\(status:\s*done\)\s*$/m.test(planText);
}

async function readText(fs: TestMapFs, path: string): Promise<string | null> {
  try { const r = await fs.read(path, 8_000_000); return r.status === "ok" ? r.text : null; } catch { return null; }
}

/** Reads the previous plan, merges the map into it and writes TEST-PLAN.md (and TEST-PLAN-DONE.md when it holds steps). */
export async function writeTestPlan(fs: TestMapFs, repoPrefix: string, map: TestMap, structure: TestStructure, moveFinished = true): Promise<TestPlanInfo> {
  const at = (p: string) => (repoPrefix ? `${repoPrefix}/${p}` : p);
  const merged = mergeTestPlan(await readText(fs, at(TEST_PLAN_PATH)), map, structure, await readText(fs, at(TEST_PLAN_DONE_PATH)), moveFinished);
  await ensureDir(fs, at(TEST_PLAN_PATH).split("/").slice(0, -1).join("/"));
  await fs.write(at(TEST_PLAN_PATH), merged.plan, { expected_hash: null, force: true });
  if (merged.done !== null) await fs.write(at(TEST_PLAN_DONE_PATH), merged.done, { expected_hash: null, force: true });
  return merged.info;
}
