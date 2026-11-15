#!/opt/llmide-node/bin/node
// Host adapter for the desktop's deterministic artifact checks.
import fs from "node:fs";
import path from "node:path";
import { evaluateArtifact } from "./artifact.ts";

const root = path.resolve(process.argv[2] || "");
const input = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const abs = (p) => {
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`outside root: ${p}`);
  return full;
};
const api = {
  async read(p) { try { const text = fs.readFileSync(abs(p), "utf8"); return { status: "ok", text, truncated: false, size: Buffer.byteLength(text) }; } catch { return { status: "missing", text: null, truncated: false, size: 0 }; } },
  async list(p) { const rows = fs.readdirSync(abs(p), { withFileTypes: true }); return { entries: rows.map((e) => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file" })) }; },
};
const r = await evaluateArtifact(api, { ...input.check, projectRootFallback: false }, input.stages || [], { repoPrefix: "", projectPrefix: "" });
console.log(JSON.stringify(r));
process.exit(r.passed ? 0 : 1);
