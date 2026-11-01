import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateArtifact } from "../native/artifact.ts";

function mem(files) {
  return {
    async read(path) { if (!(path in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[path] }; },
    async list(dir) {
      const prefix = dir === "." ? "" : `${dir}/`;
      const names = new Map();
      for (const p of Object.keys(files)) {
        if (p === dir || !p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const seg = rest.split("/")[0];
        names.set(seg, rest.includes("/") ? "dir" : "file");
      }
      return { entries: [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}` })) };
    },
  };
}

test("artifact check enforces required paths and line caps", async () => {
  const fs = mem({ "docs/a.md": "one\ntwo", "docs/b.md": "x" });
  const r = await evaluateArtifact(fs, { requiredPaths: ["docs/a.md"], lineLimits: [{ glob: "**/*.md", maxLines: 2 }] }, [], { repoPrefix: "", projectPrefix: "" });
  assert.equal(r.passed, true);
  const bad = await evaluateArtifact(fs, { requiredPaths: ["docs/missing.md"] }, [], { repoPrefix: "", projectPrefix: "" });
  assert.equal(bad.passed, false);
  assert.match(bad.failures[0], /missing/);
});

test("artifact output rules follow a sibling stage Output and section rules", async () => {
  const fs = mem({ "llm-doc/plan.md": "### R1\n- Files: a\n- Expect: b\n- Tests: c\n- Rules: d\n" });
  const stages = [{ id: "s", name: "Plan", kind: "skill", defaultKey: "plan", outputPath: "llm-doc/plan.md", order: 0, enabled: true }];
  const check = { outputRules: [{ stage: "plan", shape: "file", maxLines: 10 }], sectionRules: [{ headerPrefix: "### R", requiredLinePrefixes: ["- Files:", "- Expect:", "- Tests:", "- Rules:"] }] };
  const r = await evaluateArtifact(fs, check, stages, { repoPrefix: "", projectPrefix: "" });
  assert.equal(r.passed, true);
});

test("citation checks resolve backticked repo paths and report missing ones", async () => {
  const ok = await evaluateArtifact(mem({ "docs/a.md": "see `src/app.ts:12`\n", "src/app.ts": "x" }), { citationGlobs: ["docs/**/*.md"] }, [], { repoPrefix: "", projectPrefix: "" });
  assert.equal(ok.passed, true);
  const bad = await evaluateArtifact(mem({ "docs/a.md": "see `src/missing.ts`\n" }), { citationGlobs: ["docs/**/*.md"] }, [], { repoPrefix: "", projectPrefix: "" });
  assert.equal(bad.passed, false);
  assert.match(bad.failures[0], /citation/);
});
