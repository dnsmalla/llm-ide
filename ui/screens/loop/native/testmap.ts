// TestMap `structure` operation: detect where a repo's tests live and write the Mac's TEST-STRUCTURE.md/.json.
// This slice covers SwiftPM, Node, pytest, Go and Cargo at package depth 0–2. `map` and `ledger` are separate,
// larger operations and are refused rather than approximated.
import type { FsApi } from "../../explorer/fs";

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
      if (testDir) roots.push({ packageDir: pkg, testDir: `${pkg ? `${pkg}/` : ""}Tests`, runner: "xctest", command: pkg ? `cd ${pkg} && swift test` : "swift test", languages: ["swift"] });
      else notes.push(`${label}: Package.swift has a testTarget but no Tests directory`);
    }
    if (await file(fs, `${join(base, "pytest.ini")}`) !== null || ((await file(fs, `${join(base, "pyproject.toml")}`))?.includes("pytest") ?? false)) {
      if (await firstDir(fs, base, ["tests", "test"])) roots.push({ packageDir: pkg, testDir: `${pkg ? `${pkg}/` : ""}tests`, runner: "pytest", command: pkg ? `cd ${pkg} && pytest` : "pytest", languages: ["py"] });
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
  await fs.write(md, renderMarkdown(s), { expected_hash: null });
  await fs.write(json, JSON.stringify(s, null, 2) + "\n", { expected_hash: null });
  return { md, json };
}
