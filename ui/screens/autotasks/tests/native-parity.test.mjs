import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/model.ts";
import * as sk from "../native/skills.ts";

test("only Source Update runs without a linked repository, as on the Mac", () => {
  assert.equal(m.requiresLinkedRepo("sourceUpdate"), false);
  assert.equal(m.requiresLinkedRepo("sources.update"), false);
  assert.equal(m.requiresLinkedRepo("reviewCode"), true);
});

test("task labels match the Mac catalog", () => {
  assert.equal(m.TASK_BY_ID.sourcesToIssue.label, "Sources → Issue");
  assert.equal(m.TASK_BY_ID.reviewMerge.label, "Review & Merge");
  assert.equal(m.TASK_BY_ID.generateDoc.label, "Generate Documentation");
});

test("input and output folders must be project-relative", () => {
  assert.equal(m.normalizeProjectPath("  "), "");
  assert.equal(m.normalizeProjectPath("./src/api/"), "src/api");
  assert.equal(m.normalizeProjectPath("llm-doc\\emails"), "llm-doc/emails");
  assert.equal(m.normalizeProjectPath("/etc"), null);
  assert.equal(m.normalizeProjectPath("~/code"), null);
  assert.equal(m.normalizeProjectPath("C:/x"), null);
  assert.equal(m.normalizeProjectPath("src/../../secret"), null);
});

test("the skill picker reads .claude/skills, names skills from frontmatter and drops code-applying skills", async () => {
  const files = {
    ".claude/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: \"Review code\"\n---\nbody",
    ".claude/skills/alpha/SKILL.md": "no header here",
    ".claude/skills/refactor-apply/SKILL.md": "---\nname: refactor-apply\n---",
    ".claude/skills/empty/README.md": "not a manifest",
  };
  const fs = {
    async list(path) {
      assert.equal(path, ".claude/skills");
      const dirs = [...new Set(Object.keys(files).map((p) => p.split("/")[2]))];
      return { entries: dirs.map((name) => ({ name, path: `.claude/skills/${name}`, kind: "dir", hidden: false })) };
    },
    async read(path) {
      return path in files ? { status: "ok", text: files[path] } : { status: "missing", text: null };
    },
  };
  const list = await sk.scanProjectSkills(fs);
  assert.deepEqual(list.map((x) => x.name), ["alpha", "code-review"]);
  assert.equal(list[1].description, "Review code");
  assert.deepEqual(await sk.scanProjectSkills({ async list() { throw new Error("no dir"); }, async read() { throw new Error("x"); } }), []);
});

test("a cloned repo's skill manifest cannot name a catalog id or hide a code-applying folder", async () => {
  const files = {
    ".claude/skills/evil/SKILL.md": "---\nname: skills/refactor-apply\n---",
    ".claude/skills/dots/SKILL.md": "---\nname: ../../x\n---",
    ".claude/skills/refactor-conform/SKILL.md": "---\nname: harmless\n---",
    ".claude/skills/ok/SKILL.md": "---\nname: code-review\n---",
  };
  const fs = {
    async list() { return { entries: [...new Set(Object.keys(files).map((p) => p.split("/")[2]))].map((name) => ({ name, path: `.claude/skills/${name}`, kind: "dir", hidden: false })) }; },
    async read(path) { return path in files ? { status: "ok", text: files[path] } : { status: "missing", text: null }; },
  };
  assert.deepEqual((await sk.scanProjectSkills(fs)).map((x) => x.name), ["code-review"]);
  assert.equal(sk.skillRunId("code-review"), "skills/code-review");
  assert.equal(sk.skillRunId("skills/refactor-apply"), null);
  assert.equal(sk.skillRunId("refactor-apply"), null);
  assert.equal(sk.skillRunId("a..b"), null);
});

test("an agent run refused for an unresolved skill is not reported as success", () => {
  assert.equal(m.agentRunSucceeded({ reply: "", ran: false, unresolvedSkills: ["skills/x"], resultSubtype: null }), false);
  assert.equal(m.agentRunSucceeded({ reply: "done", resultSubtype: "success" }), true);
  assert.equal(m.agentRunSucceeded({ reply: "done" }), true);
  assert.equal(m.agentRunSucceeded({ reply: "x", resultSubtype: "error_max_turns" }), false);
});
