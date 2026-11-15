#!/opt/llmide-node/bin/node
// Host Loop worktree lifecycle: list runs, commit+merge one into the live branch, or remove a clean worktree.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [action, projectArg, name] = process.argv.slice(2);
const project = path.resolve(projectArg || "");
const base = path.join(project, ".llmide-loop-worktrees");
const run = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
const fail = (msg) => { console.error(msg); process.exit(2); };
if (!fs.existsSync(project) || !fs.existsSync(base)) fail("no loop worktrees");

if (action === "list") {
  const rows = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("run-")).map((e) => {
    const dir = path.join(base, e.name);
    const status = run(["status", "--porcelain"], dir);
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim();
    return { name: e.name, path: dir, branch, dirty: Boolean(status.stdout.trim()) };
  });
  console.log(JSON.stringify({ project, worktrees: rows }));
  process.exit(0);
}

if (!name || !/^run-[A-Za-z0-9._-]+$/.test(name)) fail("invalid worktree name");
const dir = path.join(base, name);
if (!fs.existsSync(dir)) fail("worktree not found");

if (action === "merge") {
  const add = run(["add", "-A"], dir);
  if (add.status !== 0) fail(`git add failed: ${add.stderr.trim()}`);
  const dirty = run(["status", "--porcelain"], dir).stdout.trim();
  if (dirty) {
    const commit = run(["-c", "user.name=LLM-IDE Loop", "-c", "user.email=loop@llm-ide.local", "commit", "-m", `loop: ${name}`], dir);
    if (commit.status !== 0) fail(`commit failed: ${commit.stderr.trim()}`);
  }
  const branch = `llmide/loop-${name}`;
  if (run(["rev-parse", "--verify", branch], project).status === 0) fail(`branch already exists: ${branch}`);
  const co = run(["checkout", "-b", branch], dir);
  if (co.status !== 0) fail(`checkout failed: ${co.stderr.trim()}`);
  const merge = run(["merge", "--no-ff", branch, "-m", `merge ${branch}`], project);
  if (merge.status !== 0) fail(`merge failed (resolve manually): ${merge.stderr.trim() || merge.stdout.trim()}`);
  console.log(JSON.stringify({ merged: true, branch, project, worktree: dir }));
  process.exit(0);
}

if (action === "diff") {
  const add = run(["add", "-A"], dir);
  if (add.status !== 0) fail(`git add failed: ${add.stderr.trim()}`);
  const d = run(["diff", "--cached", "--stat", "HEAD"], dir);
  const patch = run(["diff", "--cached", "HEAD"], dir);
  console.log(JSON.stringify({ worktree: dir, stat: d.stdout.trim(), patch: String(patch.stdout || "").slice(0, 262144), truncated: String(patch.stdout || "").length > 262144 }));
  process.exit(0);
}

if (action === "remove") {
  const dirty = run(["status", "--porcelain"], dir).stdout.trim();
  if (dirty) fail("worktree has uncommitted changes; merge or discard them first");
  const r = run(["worktree", "remove", dir], project);
  if (r.status !== 0) fail(`remove failed: ${r.stderr.trim()}`);
  console.log(JSON.stringify({ removed: true, worktree: dir }));
  process.exit(0);
}

fail("usage: llmide-remote-worktree list|diff|merge|remove <project> [name]");
