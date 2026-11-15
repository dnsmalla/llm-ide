#!/opt/llmide-node/bin/node
// Host adapter for the desktop's Regression sweep. Verify commands run in the run worktree; legacy faults re-ask the host model.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runRegression } from "./regression.ts";

const root = path.resolve(process.argv[2] || "");
const abs = (p) => {
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`outside root: ${p}`);
  return full;
};
const api = {
  async read(p) { try { const text = fs.readFileSync(abs(p), "utf8"); return { status: "ok", text, truncated: false, size: Buffer.byteLength(text) }; } catch { return { status: "missing", text: null, truncated: false, size: 0 }; } },
  async list(p) { const rows = fs.readdirSync(abs(p), { withFileTypes: true }); return { entries: rows.map((e) => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file", path: path.join(p, e.name) })) }; },
};
const ask = async (prompt) => {
  const token = process.env.LLMIDE_TOKEN;
  if (!token) throw new Error("no host token");
  const r = await fetch("http://127.0.0.1:3457/kb/complete", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ prompt, maxTokens: 500 }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.error?.message || `model ${r.status}`);
  return String(b.reply ?? "");
};
const r = await runRegression(api, "system/faults", {
  ask,
  verify: async (f) => {
    const v = spawnSync("/bin/sh", ["-lc", f.verify], { cwd: root, encoding: "utf8", timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: v.status === 0, output: [v.stdout, v.stderr].filter(Boolean).join("\n") };
  },
});
console.log(JSON.stringify(r));
process.exit(r.passed ? 0 : 1);
