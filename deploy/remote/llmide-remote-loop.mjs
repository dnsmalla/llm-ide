#!/opt/llmide-node/bin/node
// Host Loop runner for the VPS core. Shell and skill stages run here; desktop-only stages are reported as skipped and a
// skipped BLOCKING stage makes the run fail, never a false pass.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.argv[2] || "");
if (!fs.existsSync(root)) { console.error("project not found"); process.exit(2); }
const store = JSON.parse(fs.readFileSync(path.join(root, "system/loop.json"), "utf8"));
const wanted = process.argv[3];
const loops = Array.isArray(store.loops) ? store.loops : [];
const loop = wanted ? loops.find((l) => l.name === wanted || l.defaultKey === wanted) : loops.find((l) => l.isPrimary) ?? loops[0];
if (!loop) { console.error("loop not found"); process.exit(2); }
const stages = Array.isArray(loop.config?.stages) ? loop.config.stages.filter((s) => s.enabled).sort((a, b) => a.order - b.order) : [];

// Isolate the run from the live project. The engine accepts linked worktrees under this exact directory name.
// ms + random suffix: two runs started in the same second must not share a worktree or metadata folder.
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
// Run metadata (run.json, graph output, temp inputs) lives OUTSIDE the worktree so the worktree stays clean for
// Prune/Remove and a merge never commits it. `meta-*` deliberately does not match the `run-*` worktree prefix.
const metaDir = path.join(root, ".llmide-loop-worktrees", `meta-${stamp}`);
fs.mkdirSync(metaDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmide-loop-"));
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
const worktreeRoot = path.join(root, ".llmide-loop-worktrees", `run-${stamp}`);
let runRoot = root;
if (fs.existsSync(path.join(root, ".git"))) {
  const wt = spawnSync("git", ["worktree", "add", "--detach", worktreeRoot, "HEAD"], { cwd: root, encoding: "utf8" });
  if (wt.status !== 0) { console.error(`worktree failed: ${String(wt.stderr).trim()}`); process.exit(4); }
  runRoot = worktreeRoot;
}

const op = JSON.parse(fs.readFileSync("/etc/llmide-remote/operator.json", "utf8"));
const key = fs.readFileSync("/etc/systemd/system/llmide-remote.service", "utf8").match(/LLMIDE_HOST_APPROVAL_KEY=([0-9a-f]{64})/)?.[1];
const proof = crypto.createHmac("sha256", Buffer.from(key, "hex")).update("bus-host-proof/v1").digest("hex");
const base = "http://127.0.0.1:3457";
const login = await fetch(base + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: op.email, password: op.password }) }).then((r) => r.json());
if (!login.accessToken) { console.error("login failed"); process.exit(3); }

const results = [];
let passed = true;
let partial = false;
for (const s of stages) {
  const at = new Date().toISOString();
  if (s.kind === "shellCommand") {
    const r = spawnSync("/bin/sh", ["-lc", s.command], { cwd: runRoot, encoding: "utf8", timeout: (s.timeoutSeconds || 900) * 1000, maxBuffer: 4 * 1024 * 1024 });
    const ok = r.status === 0;
    results.push({ name: s.name, kind: s.kind, ok, exitCode: r.status, stdout: String(r.stdout ?? "").slice(0, 2000), stderr: String(r.stderr ?? "").slice(0, 1000), at });
    if (!ok && s.severity === "blocking") { passed = false; break; }
  } else if (s.kind === "skill") {
    const r = await fetch(base + "/kb/loop/agent-run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.accessToken}`, "x-llmide-host-nonce": proof },
      body: JSON.stringify({ message: s.prompt || s.name, skills: s.skillId ? [s.skillId] : [], repoRoot: runRoot, role: "loop", timeoutMs: Math.min(1800000, (s.timeoutSeconds || 1800) * 1000) }),
    });
    const body = await r.json().catch(() => ({}));
    const ok = r.status === 200 && !body.error;
    results.push({ name: s.name, kind: s.kind, ok, status: r.status, reply: String(body.reply ?? "").slice(0, 1000), error: body.error ?? null, at });
    if (!ok && s.severity === "blocking") { passed = false; break; }
  } else if (s.kind === "regressionSweep") {
    const r = spawnSync("/opt/llmide-node/bin/node", ["--experimental-strip-types", "/opt/llmide-remote/loop-native/host-regression.mjs", runRoot], { encoding: "utf8", timeout: (s.timeoutSeconds || 900) * 1000, env: { ...process.env, LLMIDE_TOKEN: login.accessToken } });
    const ok = r.status === 0;
    results.push({ name: s.name, kind: s.kind, ok, exitCode: r.status, stdout: String(r.stdout ?? "").slice(0, 2000), stderr: String(r.stderr ?? "").slice(0, 1000), at });
    if (!ok && s.severity === "blocking") { passed = false; break; }
  } else if (s.kind === "testPrune") {
    const r = spawnSync("/opt/llmide-node/bin/node", ["--experimental-strip-types", "/opt/llmide-remote/loop-native/host-testmap.mjs", runRoot, "prune"], { encoding: "utf8", timeout: (s.timeoutSeconds || 900) * 1000 });
    const ok = r.status === 0;
    results.push({ name: s.name, kind: s.kind, ok, exitCode: r.status, stdout: String(r.stdout ?? "").slice(0, 2000), stderr: String(r.stderr ?? "").slice(0, 1000), at });
    if (!ok && s.severity === "blocking") { passed = false; break; }
  } else if (s.kind === "artifactCheck") {
    if (!s.check) { results.push({ name: s.name, kind: s.kind, ok: false, output: "no check configuration", at }); passed = false; break; }
    const tmp = path.join(tmpDir, "artifact.json");
    fs.writeFileSync(tmp, JSON.stringify({ check: s.check, stages }));
    const r = spawnSync("/opt/llmide-node/bin/node", ["--experimental-strip-types", "/opt/llmide-remote/loop-native/host-artifact.mjs", runRoot, tmp], { encoding: "utf8", timeout: (s.timeoutSeconds || 300) * 1000 });
    const ok = r.status === 0;
    results.push({ name: s.name, kind: s.kind, ok, exitCode: r.status, stdout: String(r.stdout ?? "").slice(0, 2000), stderr: String(r.stderr ?? "").slice(0, 1000), at });
    if (!ok && s.severity === "blocking") { passed = false; break; }
  } else if (s.kind === "codeGraph") {
    const outDir = path.join(metaDir, "graph");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "graph-code.json");
    const r = spawnSync("/opt/llmide-node/bin/node", ["/opt/llmide-remote/graph-kit.js", "code", runRoot, "--out", outFile, "--no-calls"], { encoding: "utf8", timeout: (s.timeoutSeconds || 900) * 1000 });
    const ok = r.status === 0 && fs.existsSync(outFile);
    results.push({ name: s.name, kind: s.kind, ok, exitCode: r.status, stdout: String(r.stdout ?? "").slice(0, 2000), stderr: String(r.stderr ?? "").slice(0, 1000), at });
    if (!ok && s.severity === "blocking") { passed = false; break; }
  } else if (s.kind === "testMap" && s.testOp === "ledger") {
    const last = [...results].reverse().find((r) => r.kind === "shellCommand" && /test/i.test(r.name) && !/baseline|pre-check/i.test(r.name));
    if (!last) { results.push({ name: s.name, kind: s.kind, ok: true, output: "no Test stage ran before the ledger", at }); }
    else {
      const tmp = path.join(tmpDir, "ledger.log");
      fs.writeFileSync(tmp, last.stdout || "");
      const r = spawnSync("/opt/llmide-node/bin/node", ["--experimental-strip-types", "/opt/llmide-remote/loop-native/host-testmap.mjs", runRoot, "ledger", tmp], { encoding: "utf8", timeout: (s.timeoutSeconds || 900) * 1000 });
      const ok = r.status === 0;
      results.push({ name: s.name, kind: s.kind, ok, exitCode: r.status, stdout: String(r.stdout ?? "").slice(0, 2000), stderr: String(r.stderr ?? "").slice(0, 1000), at });
      if (!ok && s.severity === "blocking") { passed = false; break; }
    }
  } else if (s.kind === "testMap" && (s.testOp === "structure" || s.testOp === "map")) {
    const r = spawnSync("/opt/llmide-node/bin/node", ["--experimental-strip-types", "/opt/llmide-remote/loop-native/host-testmap.mjs", runRoot, s.testOp, loop.inputPath || ""], { encoding: "utf8", timeout: (s.timeoutSeconds || 900) * 1000 });
    const ok = r.status === 0;
    results.push({ name: s.name, kind: s.kind, ok, exitCode: r.status, stdout: String(r.stdout ?? "").slice(0, 2000), stderr: String(r.stderr ?? "").slice(0, 1000), at });
    if (!ok && s.severity === "blocking") { passed = false; break; }
  } else {
    const skipped = { name: s.name, kind: s.kind, ok: false, skipped: true, blocking: s.severity === "blocking", at };
    results.push(skipped);
    partial = true;
    if (skipped.blocking) { passed = false; break; }
  }
}
const dir = metaDir;
fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ loop: loop.name, root, worktree: runRoot, passed, partial, stages: results }, null, 2) + "\n");
console.log(JSON.stringify({ loop: loop.name, root, worktree: runRoot, passed, partial, stages: results.length, run: path.join(dir, "run.json") }));
if (!passed) process.exit(1);
