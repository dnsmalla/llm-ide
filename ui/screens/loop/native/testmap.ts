// TestMap `structure` operation: detect where a repo's tests live and write the Mac's TEST-STRUCTURE.md/.json.
// This slice covers SwiftPM, Node, pytest, Go and Cargo at package depth 0–2. `map` and `ledger` are separate,
// larger operations and are refused rather than approximated.
import type { FsApi } from "../../explorer/fs";
import { isTestFileName } from "./protected.ts";

export interface TestRoot { packageDir: string; testDir: string; runner: string; command: string; languages: string[] }
export interface TestStructure { generatedAt: string; roots: TestRoot[]; status: "ok" | "missing"; notes: string[] }
export type TestMapFs = Pick<FsApi, "read" | "list" | "create" | "write">;

const SKIP = new Set([".git", "node_modules", ".build", ".swiftpm", "DerivedData", "dist", "build", "vendor"]);

async function isDir(fs: TestMapFs, path: string): Promise<boolean> {
  try { return (await fs.list(path)).entries.length >= 0; } catch { return false; }
}
async function file(fs: TestMapFs, path: string): Promise<string | null> {
  try { const r = await fs.read(path, 2_000_000); return r.status === "ok" ? r.text : null; } catch { return null; }
}
const join = (base: string, rest: string): string => base ? `${base}/${rest}` : rest;
async function firstDir(fs: TestMapFs, base: string, names: string[]): Promise<string | null> {
  for (const n of names) if (await isDir(fs, join(base, n))) return n;
  return null;
}

export async function detectTestStructure(fs: TestMapFs, repoPrefix: string, now = new Date()): Promise<TestStructure> {
  const prefix = repoPrefix ? `${repoPrefix}/` : "";
  const roots: TestRoot[] = [];
  const notes: string[] = [];
  const dirs = [""];
  try {
    const top = (await fs.list(prefix.replace(/\/$/, "") || ".")).entries.filter((e) => e.kind === "dir" && !e.name.startsWith(".") && !SKIP.has(e.name));
    for (const d of top) {
      dirs.push(d.name);
      try {
        const second = (await fs.list(d.path)).entries.filter((e) => e.kind === "dir" && !e.name.startsWith(".") && !SKIP.has(e.name));
        for (const s of second) dirs.push(`${d.name}/${s.name}`);
      } catch { /* depth-1 unreadable */ }
    }
  } catch { /* no root listing */ }
  for (const pkg of dirs) {
    const base = `${prefix}${pkg}`.replace(/\/+$/, "");
    const label = pkg || ".";
    const pkgJson = await file(fs, `${join(base, "package.json")}`);
    if (pkgJson) {
      try {
        const script = (JSON.parse(pkgJson) as { scripts?: Record<string, unknown> }).scripts?.test;
        if (typeof script === "string" && script.trim() && !/^echo\b/.test(script.trim())) {
          const testDir = await firstDir(fs, base, ["tests", "test", "__tests__", "src/__tests__"]);
          if (testDir) roots.push({ packageDir: pkg, testDir: `${pkg ? `${pkg}/` : ""}${testDir}`, runner: script.includes("jest") ? "jest" : "npm", command: pkg ? `cd ${pkg} && npm test` : "npm test", languages: ["mjs", "js"] });
          else notes.push(`${label}: package.json has a test script but no test directory`);
        }
      } catch { notes.push(`${label}: package.json is not valid JSON`); }
    }
    const pkgSwift = await file(fs, `${join(base, "Package.swift")}`);
    if (pkgSwift?.includes(".testTarget(")) {
      const names = [...pkgSwift.matchAll(/\.testTarget\(\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
      const testDir = await firstDir(fs, base, names.map((n) => `Tests/${n}`));
      if (testDir) roots.push({ packageDir: pkg, testDir: `${pkg ? `${pkg}/` : ""}${testDir}`, runner: "xctest", command: pkg ? `cd ${pkg} && swift test` : "swift test", languages: ["swift"] });
      else notes.push(`${label}: Package.swift has a testTarget but no Tests directory`);
    }
    if (await file(fs, `${join(base, "pytest.ini")}`) !== null || ((await file(fs, `${join(base, "pyproject.toml")}`))?.includes("pytest") ?? false)) {
      const pyDir = await firstDir(fs, base, ["tests", "test"]);
      if (pyDir) roots.push({ packageDir: pkg, testDir: `${pkg ? `${pkg}/` : ""}${pyDir}`, runner: "pytest", command: pkg ? `cd ${pkg} && pytest` : "pytest", languages: ["py"] });
      else notes.push(`${label}: pytest configured but no tests directory`);
    }
    if (await file(fs, `${join(base, "go.mod")}`) !== null) roots.push({ packageDir: pkg, testDir: pkg || ".", runner: "go", command: pkg ? `cd ${pkg} && go test ./...` : "go test ./...", languages: ["go"] });
    if (await file(fs, `${join(base, "Cargo.toml")}`) !== null) roots.push({ packageDir: pkg, testDir: pkg || ".", runner: "cargo", command: pkg ? `cd ${pkg} && cargo test` : "cargo test", languages: ["rs"] });
  }
  return { generatedAt: now.toISOString(), roots, status: roots.length ? "ok" : "missing", notes };
}

function renderMarkdown(s: TestStructure): string {
  const lines = ["# Test structure", "", `Status: **${s.status}**`, ""];
  if (!s.roots.length) lines.push("No test roots detected.");
  for (const r of s.roots) lines.push(`## ${r.packageDir || "."}`, "", `- Test directory: \`${r.testDir}\``, `- Runner: ${r.runner}`, `- Command: \`${r.command}\``, `- Languages: ${r.languages.join(", ")}`, "");
  if (s.notes.length) lines.push("## Notes", "", ...s.notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}

async function ensureDir(fs: TestMapFs, dir: string): Promise<void> {
  let at = "";
  for (const seg of dir.split("/")) { at = at ? `${at}/${seg}` : seg; try { await fs.create(at, "dir"); } catch (e) { if (typeof e === "object" && e !== null && (e as { code?: unknown }).code !== "exists") throw e; } }
}

export async function writeTestStructure(fs: TestMapFs, repoPrefix: string, s: TestStructure): Promise<{ md: string; json: string }> {
  const prefix = repoPrefix ? `${repoPrefix}/` : "";
  const md = `${prefix}llm-doc/loop/test/TEST-STRUCTURE.md`;
  const json = `${prefix}system/loop/test/TEST-STRUCTURE.json`;
  await ensureDir(fs, md.split("/").slice(0, -1).join("/"));
  await ensureDir(fs, json.split("/").slice(0, -1).join("/"));
  await fs.write(md, renderMarkdown(s), { expected_hash: null, force: true });
  await fs.write(json, JSON.stringify(s, null, 2) + "\n", { expected_hash: null, force: true });
  return { md, json };
}

export interface TestMapEntry { path: string; function: string; line: number; fanIn: number; loc: number; testedBy: string[] }
export interface TestMap { generatedAt: string; source: "graph" | "files"; entries: TestMapEntry[]; untestedFunctions: number; testedFunctions: number; untestedFiles: number }

export async function walkFiles(fs: TestMapFs, dir: string, out: string[] = [], limit = 5000): Promise<string[]> {
  if (out.length >= limit) return out;
  let entries;
  try { entries = (await fs.list(dir)).entries; } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) return out;
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    // Other runs' worktrees are not this repo's files (a main-tree walk from the project root would reach them).
    if (e.kind === "dir" && /(^|\/)system\/loop-worktrees$/.test(e.path)) continue;
    if (e.kind === "dir") await walkFiles(fs, e.path, out, limit);
    else if (e.kind === "file") out.push(e.path);
  }
  return out;
}

function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) out.add(m[0]);
  for (const m of text.matchAll(/"([^"\n]*)"/g)) out.add(m[1]);
  return out;
}

const TEST_MARKER = /(describe|it|test|specify|@Test|def test_|func test[A-Z])/;

const CODE_FILE = /\.(py|ts|tsx|js|mjs|cjs|swift|kt|go|rs)$/;

/** Repo-relative source files under the prefix: no test files or test roots, and no system/ or llm-doc/ folders. */
async function sourceFiles(fs: TestMapFs, repoPrefix: string, structure: TestStructure): Promise<string[]> {
  const prefix = repoPrefix ? `${repoPrefix}/` : "";
  const testDirs = structure.roots.map((r) => r.testDir).filter((d) => d && d !== ".");
  const out: string[] = [];
  for (const f of await walkFiles(fs, prefix.replace(/\/$/, "") || ".")) {
    const rel = repoPrefix && f.startsWith(`${repoPrefix}/`) ? f.slice(repoPrefix.length + 1) : f;
    if (!CODE_FILE.test(rel) || isTestFileName(rel) || /^(system|llm-doc)\//.test(rel)) continue;
    if (testDirs.some((d) => rel.startsWith(`${d}/`))) continue;
    out.push(rel);
  }
  return out;
}

export async function buildTestMap(fs: TestMapFs, repoPrefix: string, structure: TestStructure, graphPath: string, now = new Date()): Promise<TestMap> {
  const prefix = repoPrefix ? `${repoPrefix}/` : "";
  const tests: { path: string; tokens: Set<string> }[] = [];
  for (const root of structure.roots) {
    const files = await walkFiles(fs, `${prefix}${root.testDir}`.replace(/\/$/, ""));
    for (const f of files) {
      const text = await file(fs, f);
      if (text === null || !TEST_MARKER.test(text)) continue;
      const rel = repoPrefix && f.startsWith(`${repoPrefix}/`) ? f.slice(repoPrefix.length + 1) : f;
      tests.push({ path: rel, tokens: tokensOf(text) });
    }
  }
  const entries: TestMapEntry[] = [];
  let source: "graph" | "files" = "files";
  const graphText = await file(fs, graphPath);
  if (graphText) {
    try {
      const g = JSON.parse(graphText) as {
        nodes?: Array<{ kind?: string; title?: string; id?: string; metadata?: { path?: string; source_file?: string; line?: number } }>;
        files?: Array<{ path?: string; name?: string; loc?: number; usedBy?: string[]; imports?: string[]; functions?: Array<{ name?: string; line?: number }> }>;
      };
      source = "graph";
      for (const f of g.files ?? []) {
        if (!f.path) continue;
        const base = f.name?.replace(/\.[^.]+$/, "") ?? f.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        for (const fn of f.functions ?? []) {
          if (!fn.name || fn.name.startsWith("_") || ["init", "deinit", "body", "main", "description"].includes(fn.name)) continue;
          const testedBy = tests.filter((t) => t.tokens.has(fn.name!) || (base !== "" && t.tokens.has(base))).map((t) => t.path).sort();
          entries.push({ path: f.path, function: fn.name, line: fn.line ?? 1, fanIn: (f.usedBy?.length ?? 0) + (f.imports?.length ?? 0), loc: f.loc ?? 0, testedBy });
        }
      }
      if (entries.length === 0) for (const n of g.nodes ?? []) {
        if (n.kind !== "function" || !n.title) continue;
        const path = n.metadata?.path ?? n.metadata?.source_file;
        if (!path) continue;
        const base = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
        const testedBy = tests.filter((t) => t.tokens.has(n.title!) || (base !== "" && t.tokens.has(base))).map((t) => t.path).sort();
        entries.push({ path, function: n.title, line: n.metadata?.line ?? 1, fanIn: 0, loc: 0, testedBy });
      }
    } catch { source = "files"; }
  }
  if (entries.length === 0) {
    // No usable graph: every source file is an entry, "tested" when a test names its base name (the graph path's rule).
    source = "files";
    for (const rel of await sourceFiles(fs, repoPrefix, structure)) {
      const base = rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      const testedBy = tests.filter((t) => t.tokens.has(base)).map((t) => t.path).sort();
      entries.push({ path: rel, function: "*", line: 1, fanIn: 0, loc: 0, testedBy });
    }
  }
  entries.sort((a, b) => Number(a.testedBy.length > 0) - Number(b.testedBy.length > 0) || b.fanIn - a.fanIn || a.path.localeCompare(b.path) || a.function.localeCompare(b.function));
  const tested = entries.filter((e) => e.testedBy.length > 0).length;
  const files = new Set(entries.map((e) => e.path));
  const testedFiles = new Set(entries.filter((e) => e.testedBy.length > 0).map((e) => e.path));
  return { generatedAt: now.toISOString(), source, entries, untestedFunctions: entries.length - tested, testedFunctions: tested, untestedFiles: [...files].filter((f) => !testedFiles.has(f)).length };
}

function renderTestMap(m: TestMap): string {
  const lines = [`# Test map (${m.source}, ${m.generatedAt})`, "", "| counter | value |", "|---|---|", `| untestedFunctions | ${m.untestedFunctions} |`, `| testedFunctions | ${m.testedFunctions} |`, `| untestedFiles | ${m.untestedFiles} |`, "", "## Untested functions", ""];
  for (const e of m.entries.filter((x) => x.testedBy.length === 0).slice(0, 80)) lines.push(`- ${e.path}:${e.line} ${e.function}`);
  lines.push("", "## Tested functions", "");
  for (const e of m.entries.filter((x) => x.testedBy.length > 0).slice(0, 80)) lines.push(`- ${e.path}:${e.line} ${e.function} — ${e.testedBy.join(", ")}`);
  return lines.join("\n") + "\n";
}

export async function writeTestMap(fs: TestMapFs, repoPrefix: string, m: TestMap): Promise<{ md: string; json: string }> {
  const prefix = repoPrefix ? `${repoPrefix}/` : "";
  const md = `${prefix}llm-doc/loop/test/TEST-MAP.md`;
  const json = `${prefix}system/loop/test/TEST-MAP.json`;
  await ensureDir(fs, md.split("/").slice(0, -1).join("/"));
  await ensureDir(fs, json.split("/").slice(0, -1).join("/"));
  await fs.write(md, renderTestMap(m), { expected_hash: null, force: true });
  await fs.write(json, JSON.stringify(m, null, 2) + "\n", { expected_hash: null, force: true });
  return { md, json };
}

export interface TestLedger { runId: string; recordedAt: string; failing: string[]; passing: string[] }
export interface LedgerDiff { newFailures: string[]; stillFailing: string[]; fixed: string[] }

export function parseTestResults(output: string): { failing: string[]; passing: string[] } {
  const failing = new Set<string>(); const passing = new Set<string>();
  const fileMarks = new Map<string, string>(); // pytest progress lines: file -> concatenated marks
  for (const line of output.split("\n")) {
    let m = /Test Case '-\[([^\]]+)\]'\s+(passed|failed)/.exec(line);
    if (m) { (m[2] === "passed" ? passing : failing).add(m[1]); continue; }
    m = /(?:✔|✓|✕|✗|×)\s+(?:Test\s+)?"([^"]+)"\s+(passed|failed)/i.exec(line);
    if (m) { (m[2].toLowerCase() === "passed" ? passing : failing).add(m[1]); continue; }
    // Jest marks a failed test with ● (its failure header), not ✓ or ✕.
    m = /^\s*(✓|✔|✕|✖|●)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/.exec(line);
    if (m) { (m[1] === "✓" || m[1] === "✔" ? passing : failing).add(m[2].trim()); continue; }
    // pytest -rA/-rE ("PASSED path::name - reason", "ERROR path::name - reason") and -v ("path::name PASSED [ 50%]") forms.
    const t = line.trim();
    m = /^(PASSED|FAILED|ERROR) (\S+::\S+?)(?: - .*| \[\s*\d+%\])?$/.exec(t);
    if (m) { (m[1] === "PASSED" ? passing : failing).add(m[2]); continue; }
    m = /^(\S+::\S+?)\s+(PASSED|FAILED|ERROR)(?:\s+\[\s*\d+%\])?$/.exec(t);
    if (m) (m[2] === "PASSED" ? passing : failing).add(m[1]);
    // pytest default progress line ("tests/test_x.py ..F  [100%]"): one result per file.
    m = /^(\S+\.py) ([.FEsxX]+)\s*(\[\s*\d+%\])?$/.exec(t);
    if (m) fileMarks.set(m[1], (fileMarks.get(m[1]) ?? "") + m[2]);
  }
  // Per-test names win: a file with per-test entries in a list gets no file-level entry there.
  const hasTest = (set: Set<string>, file: string) => [...set].some((n) => n.startsWith(`${file}::`));
  for (const [file, marks] of fileMarks) {
    if (/[FE]/.test(marks)) { if (!hasTest(failing, file)) failing.add(file); }
    else if (marks.includes(".") && !hasTest(passing, file) && !hasTest(failing, file)) passing.add(file);
  }
  return { failing: [...failing].sort(), passing: [...passing].sort() };
}

export function ledgerDiff(previous: TestLedger | null, current: { failing: string[]; passing: string[] }, runPassed: boolean): LedgerDiff {
  const prev = new Set(previous?.failing ?? []);
  const cur = new Set(current.failing); const pass = new Set(current.passing);
  return {
    newFailures: current.failing.filter((x) => !prev.has(x)),
    stillFailing: current.failing.filter((x) => prev.has(x)),
    fixed: [...prev].filter((x) => !cur.has(x) && (runPassed || pass.has(x))),
  };
}

export async function readLedger(fs: TestMapFs, path: string): Promise<TestLedger | null> {
  const text = await file(fs, path);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<TestLedger>;
    return { runId: String(v.runId ?? ""), recordedAt: String(v.recordedAt ?? ""), failing: Array.isArray(v.failing) ? v.failing.map(String) : [], passing: Array.isArray(v.passing) ? v.passing.map(String) : [] };
  } catch { return null; }
}

export async function writeLedger(fs: TestMapFs, path: string, ledger: TestLedger): Promise<void> {
  await ensureDir(fs, path.split("/").slice(0, -1).join("/"));
  await fs.write(path, JSON.stringify(ledger, null, 2) + "\n", { expected_hash: null, force: true });
}
