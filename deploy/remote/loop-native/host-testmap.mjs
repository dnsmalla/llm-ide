#!/opt/llmide-node/bin/node
// Host adapter for the desktop's pure TestMap logic. Paths are repo-relative, like FsApi in the desktop.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { detectTestStructure, writeTestStructure, buildTestMap, writeTestMap, parseTestResults, ledgerDiff, readLedger, writeLedger } from "./testmap.ts";

const root = path.resolve(process.argv[2] || "");
const op = process.argv[3];
const scope = process.argv[4] || "";
const abs = (p) => {
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`outside root: ${p}`);
  return full;
};
const api = {
  async read(p) { try { const text = fs.readFileSync(abs(p), "utf8"); return { status: "ok", text, truncated: false, size: Buffer.byteLength(text) }; } catch { return { status: "missing", text: null, truncated: false, size: 0 }; } },
  async list(p) { const rows = fs.readdirSync(abs(p), { withFileTypes: true }); return { entries: rows.map((e) => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file" })) }; },
  async create(p, kind) { const full = abs(p); if (kind === "dir") fs.mkdirSync(full, { recursive: true }); else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, ""); } return p; },
  async write(p, text) { const full = abs(p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); return { ok: true }; },
};
const structure = await detectTestStructure(api, "", new Date());
if (op === "structure") {
  const w = await writeTestStructure(api, "", structure);
  console.log(JSON.stringify({ op, status: structure.status, roots: structure.roots.length, md: w.md, json: w.json }));
  process.exit(structure.status === "ok" ? 0 : 1);
}
if (op === "map") {
  const map = await buildTestMap(api, "", structure, "system/loop/refactor/graph/graph-code.json", new Date(), scope);
  const w = await writeTestMap(api, "", map);
  console.log(JSON.stringify({ op, entries: map.entries.length, untested: map.untestedFunctions, tested: map.testedFunctions, md: w.md, json: w.json }));
  process.exit(0);
}
if (op === "ledger") {
  const output = fs.readFileSync(process.argv[4], "utf8");
  const parsed = parseTestResults(output);
  if (parsed.failing.length === 0 && parsed.passing.length === 0) { console.log(JSON.stringify({ op, recorded: false })); process.exit(0); }
  const p = "system/loop/test/ledger.json";
  const previous = await readLedger(api, p);
  const diff = ledgerDiff(previous, parsed, parsed.failing.length === 0);
  await writeLedger(api, p, { runId: crypto.randomUUID(), recordedAt: new Date().toISOString(), failing: parsed.failing, passing: parsed.passing });
  console.log(JSON.stringify({ op, recorded: true, failing: parsed.failing.length, passing: parsed.passing.length, newFailures: diff.newFailures, stillFailing: diff.stillFailing, fixed: diff.fixed, path: p }));
  process.exit(0);
}
console.error(`unsupported testMap op: ${op}`); process.exit(2);
