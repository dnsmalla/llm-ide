import { test } from "node:test";
import assert from "node:assert/strict";
import { faultPathsFromOutput, parseFault, reopenFault, runRegression } from "../native/regression.ts";

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

test("reopenFault changes only the fixed status and preserves notes", async () => {
  const files = { "system/faults/f.md": "---\nprompt: \"P\"\nresponse: \"R\"\nstatus: fixed\n---\nnotes stay\n" };
  const fs = { async read(p) { return { status: "ok", text: files[p] }; }, async write(p, text) { files[p] = text; } };
  assert.equal(await reopenFault(fs, "system/faults/f.md"), true);
  assert.match(files["system/faults/f.md"], /status: open/);
  assert.match(files["system/faults/f.md"], /notes stay/);
  assert.equal(await reopenFault(fs, "system/faults/f.md"), false);
});

test("a failed sweep's fault paths are read from its output, one per fault", () => {
  const output = ["system/faults/a.md: verify failed — boom", "system/faults/a.md: response changed", "system/faults/b.md: could not re-ask (timeout)", "all good"].join("\n");
  assert.deepEqual(faultPathsFromOutput(output), ["system/faults/a.md", "system/faults/b.md"]);
  assert.deepEqual(faultPathsFromOutput(""), []);
});
