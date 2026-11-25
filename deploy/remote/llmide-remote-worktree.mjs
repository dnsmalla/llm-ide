#!/opt/llmide-node/bin/node
// Host Loop worktree lifecycle: list runs, commit+merge one into the live branch, or remove a clean worktree.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [action, projectArg, name] = process.argv.slice(2);
const project = path.resolve(projectArg || "");
const base = path.join(project, ".llmide-loop-worktrees");
// Same exclusions as the desktop's loop_worktree.rs EXCLUDES: run bookkeeping must never be committed into the live branch.
const EXCLUDES = [":(exclude,icase).factory", ":(exclude,icase,glob)**/.factory/**", ":(exclude)system/loop", ":(exclude)llm-doc/loop/test", ":(exclude)llm-doc/loop/runs"];
// As the desktop's staged_add_args_for: git refuses the whole `add` when an exclude names a folder the repository
// ignores (`system/`, `.factory/`). An ignored folder is never staged anyway, so its exclude is left out.
const addExcludes = (cwd) => EXCLUDES.filter((a) => { const m = /^:\(exclude(?:,icase)?\)(.+)$/.exec(a); return !(m && spawnSync("git", ["check-ignore", "-q", "--", m[1]], { cwd }).status === 0); });
const run = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
const fail = (msg) => { console.error(msg); process.exit(2); };
if (!fs.existsSync(project) || !fs.existsSync(base)) fail("no loop worktrees");

if (action === "list") {
  const rows = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("run-")).map((e) => {
    const dir = path.join(base, e.name);
    const status = run(["status", "--porcelain", "--", ".", ...EXCLUDES], dir);
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"], dir).stdout.trim();
    return { name: e.name, path: dir, branch, dirty: Boolean(status.stdout.trim()) };
  });
  console.log(JSON.stringify({ project, worktrees: rows }));
  process.exit(0);
}

// NOTE: --force below is safe because every check above already proved nothing outside the excluded run bookkeeping is dirty.
if (action === "prune") {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const removed = []; const skipped = [];
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith("run-")) continue;
    const d = path.join(base, e.name);
    const dirty = run(["status", "--porcelain", "--", ".", ...EXCLUDES], d).stdout.trim();
    const age = fs.statSync(d).mtimeMs;
    if (dirty || age > cutoff) { skipped.push({ name: e.name, reason: dirty ? "dirty" : "young" }); continue; }
    const r = run(["worktree", "remove", "--force", d], project);
    if (r.status === 0) removed.push(e.name); else skipped.push({ name: e.name, reason: "git refused" });
  }
  // meta-<stamp> holds run bookkeeping outside the worktree; once its run-<stamp> worktree is gone it is orphaned.
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith("meta-")) continue;
    if (fs.existsSync(path.join(base, `run-${e.name.slice(5)}`))) continue;
    try { fs.rmSync(path.join(base, e.name), { recursive: true, force: true }); removed.push(e.name); } catch { skipped.push({ name: e.name, reason: "remove failed" }); }
  }
  console.log(JSON.stringify({ pruned: removed.length, removed, skipped }));
  process.exit(0);
}


if (!name || !/^run-[A-Za-z0-9._-]+$/.test(name)) fail("invalid worktree name");
const dir = path.join(base, name);
if (!fs.existsSync(dir)) fail("worktree not found");

if (action === "merge") {
  // Merging moves the live checkout: refuse when it has uncommitted work or an unfinished merge, so a conflict
  // can never land on top of the user's edits.
  const live = run(["status", "--porcelain", "--untracked-files=no"], project).stdout.trim();
  if (live) fail("the live checkout has uncommitted changes; commit or stash them before merging");
  const add = run(["add", "-A", "--", ".", ...addExcludes(dir)], dir);
  if (add.status !== 0) fail(`git add failed: ${add.stderr.trim()}`);
  const dirty = run(["diff", "--cached", "--name-only"], dir).stdout.trim();
  if (dirty) {
    const commit = run(["-c", "user.name=LLM-IDE Loop", "-c", "user.email=loop@llm-ide.local", "commit", "-m", `loop: ${name}`], dir);
    if (commit.status !== 0) fail(`commit failed: ${commit.stderr.trim()}`);
  }
  const branch = `llmide/loop-${name}`;
  // -B: a retry after an aborted conflict finds the branch left behind; reset it to this worktree's HEAD instead of failing.
  const co = run(["checkout", "-B", branch], dir);
  if (co.status !== 0) fail(`checkout failed: ${co.stderr.trim()}`);
  const merge = run(["merge", "--no-ff", branch, "-m", `merge ${branch}`], project);
  if (merge.status !== 0) {
    const conflicts = run(["diff", "--name-only", "--diff-filter=U"], project).stdout.trim().split("\n").filter(Boolean);
    run(["merge", "--abort"], project);
    // No unmerged files means git refused for another reason (e.g. an untracked file would be overwritten); say so.
    if (conflicts.length === 0) fail(`merge failed and was aborted; the live checkout is unchanged. git said: ${(merge.stderr || merge.stdout || "").trim()}`);
    fail(`merge conflicted and was aborted; the live checkout is unchanged. Conflicting files: ${conflicts.join(", ") || "(unknown)"}`);
  }
  console.log(JSON.stringify({ merged: true, branch, project, worktree: dir }));
  process.exit(0);
}

if (action === "diff") {
  const add = run(["add", "-A", "--", ".", ...EXCLUDES], dir);
  if (add.status !== 0) fail(`git add failed: ${add.stderr.trim()}`);
  const d = run(["diff", "--cached", "--stat", "HEAD"], dir);
  const patch = run(["diff", "--cached", "HEAD"], dir);
  console.log(JSON.stringify({ worktree: dir, stat: d.stdout.trim(), patch: String(patch.stdout || "").slice(0, 262144), truncated: String(patch.stdout || "").length > 262144 }));
  process.exit(0);
}

if (action === "remove") {
  const dirty = run(["status", "--porcelain", "--", ".", ...EXCLUDES], dir).stdout.trim();
  if (dirty) fail("worktree has uncommitted changes; merge or discard them first");
  const r = run(["worktree", "remove", "--force", dir], project);
  if (r.status !== 0) fail(`remove failed: ${r.stderr.trim()}`);
  console.log(JSON.stringify({ removed: true, worktree: dir }));
  process.exit(0);
}

fail("usage: llmide-remote-worktree list|diff|merge|remove|prune <project> [name]");
