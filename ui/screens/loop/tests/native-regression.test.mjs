import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFault, runRegression } from "../native/regression.ts";

test("fault frontmatter parses fixed reports and ignores other statuses", () => {
  const f = parseFault('---\nprompt: "Why?"\nresponse: "Because."\nstatus: fixed\nverify: "npm test"\n---\nnotes\n');
  assert.deepEqual(f, { prompt: "Why?", response: "Because.", verify: "npm test" });
  assert.equal(parseFault('---\nprompt: "Why?"\nresponse: "Because."\nstatus: open\n---\n'), null);
});

test("regression prefers verify commands and re-asks legacy faults", async () => {
  const files = {
    "system/faults/a.md": '---\nprompt: "P"\nresponse: "R"\nstatus: fixed\nverify: "npm test"\n---\n',
    "system/faults/b.md": '---\nprompt: "P2"\nresponse: "R2"\nstatus: fixed\n---\n',
  };
  const fs = {
    async list(dir) { const prefix = dir === "." ? "" : `${dir}/`; const names = new Map(); for (const p of Object.keys(files)) { if (!p.startsWith(prefix)) continue; const rest = p.slice(prefix.length); const seg = rest.split("/")[0]; names.set(seg, rest.includes("/") ? "dir" : "file"); } return { entries: [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}` })) }; },
    async read(p) { return { status: "ok", text: files[p] }; },
  };
  const r = await runRegression(fs, "system/faults", { async verify() { return { ok: true, output: "" }; }, async ask() { return "R2"; } });
  assert.equal(r.checked, 2);
  assert.equal(r.passed, true);
  const semantic = await runRegression(fs, "system/faults", { async verify() { return { ok: true, output: "" }; }, async ask() { return "different words"; }, async judge() { return true; } });
  assert.equal(semantic.passed, true);
  const bad = await runRegression(fs, "system/faults", { async verify() { return { ok: false, output: "fail" }; }, async ask() { return "different"; }, async judge() { return false; } });
  assert.equal(bad.passed, false);
  assert.equal(bad.failures.length, 2);
});
