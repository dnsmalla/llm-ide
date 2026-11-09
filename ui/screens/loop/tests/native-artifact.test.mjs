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

test("projectRootFallback checks the project root when the repo path misses", async () => {
  const fs = mem({ "llm-doc/plan.md": "x" });
  const r = await evaluateArtifact(fs, { requiredPaths: ["llm-doc/plan.md"], projectRootFallback: true }, [], { repoPrefix: "code/repo", projectPrefix: "" });
  assert.equal(r.passed, true);
  const noFallback = await evaluateArtifact(fs, { requiredPaths: ["llm-doc/plan.md"] }, [], { repoPrefix: "code/repo", projectPrefix: "" });
  assert.equal(noFallback.passed, false);
});

const VERDICT = { verdict: { path: ".factory/READINESS.md", line: "Verdict: ready" } };
const ROOTS = { repoPrefix: "", projectPrefix: "" };

test("verdict passes when the exact line is present", async () => {
  const r = await evaluateArtifact(mem({ ".factory/READINESS.md": "## Result\nVerdict: ready\n" }), VERDICT, [], ROOTS);
  assert.deepEqual(r, { passed: true, failures: [] });
});

test("verdict fails when the line differs", async () => {
  const r = await evaluateArtifact(mem({ ".factory/READINESS.md": "## Result\nVerdict: needs-decision\n" }), VERDICT, [], ROOTS);
  assert.equal(r.passed, false);
  assert.deepEqual(r.failures, ['verdict line missing: "Verdict: ready" in .factory/READINESS.md']);
});

test("verdict fails when the file is missing", async () => {
  const r = await evaluateArtifact(mem({}), VERDICT, [], ROOTS);
  assert.equal(r.passed, false);
  assert.deepEqual(r.failures, ["verdict file missing: .factory/READINESS.md"]);
});

test("verdict reads a dot-folder path under the run root prefix", async () => {
  const fs = mem({ "system/loop-worktrees/r1/.factory/READINESS.md": "Verdict: ready\n" });
  const r = await evaluateArtifact(fs, VERDICT, [], { repoPrefix: "system/loop-worktrees/r1", projectPrefix: "" });
  assert.equal(r.passed, true, r.failures.join("\n"));
});

test("verdict needs the line on its own, not decorated", async () => {
  const r = await evaluateArtifact(mem({ ".factory/READINESS.md": "**Verdict: ready**\n- Verdict: ready\n" }), VERDICT, [], ROOTS);
  assert.equal(r.passed, false);
});

test("a malformed or escaping verdict check fails instead of passing", async () => {
  const fs = mem({ ".factory/READINESS.md": "Verdict: ready\n", "secret.md": "Verdict: ready\n" });
  const noLine = await evaluateArtifact(fs, { verdict: { path: ".factory/READINESS.md" } }, [], ROOTS);
  assert.deepEqual(noLine.failures, ["verdict check needs a path and a line"]);
  const escape = await evaluateArtifact(fs, { verdict: { path: "../secret.md", line: "Verdict: ready" } }, [], { repoPrefix: "code/app", projectPrefix: "" });
  assert.deepEqual(escape.failures, ["verdict path must stay inside the run root: ../secret.md"]);
});

test("verdict must be the LAST non-empty line, not a quoted earlier one", async () => {
  const text = "Reviewer notes quote the rule:\nVerdict: ready\nbut the real result is below\nVerdict: changes\n\n";
  const r = await evaluateArtifact(mem({ ".factory/READINESS.md": text }), VERDICT, [], ROOTS);
  assert.equal(r.passed, false);
  assert.ok(r.failures.length > 0);
  const quoted = await evaluateArtifact(mem({ ".factory/READINESS.md": "Verdict: ready\nnotes after\n" }), VERDICT, [], ROOTS);
  assert.deepEqual(quoted.failures, ['verdict line missing: "Verdict: ready" in .factory/READINESS.md']);
});

test("verdict fails when the file has more than one Verdict: line", async () => {
  const r = await evaluateArtifact(mem({ ".factory/READINESS.md": "Verdict: changes\nVerdict: ready\n" }), VERDICT, [], ROOTS);
  assert.deepEqual(r.failures, ["verdict line repeated in .factory/READINESS.md"]);
});

test("verdict passes with one Verdict line last and trailing blank lines", async () => {
  const r = await evaluateArtifact(mem({ ".factory/READINESS.md": "## Result\n\nVerdict: ready\n\n  \n" }), VERDICT, [], ROOTS);
  assert.deepEqual(r.failures, []);
});

test("a verdict path that trims to nothing fails", async () => {
  const fs = mem({ ".factory/READINESS.md": "Verdict: ready\n" });
  for (const p of ["./", ".", "./."]) {
    const r = await evaluateArtifact(fs, { verdict: { path: p, line: "Verdict: ready" } }, [], ROOTS);
    assert.equal(r.passed, false, p);
  }
});
