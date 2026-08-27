import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSkills, scanAgents, mergeCapabilities } from "../src/skills/skillScanner.js";
import { generateFromDir } from "../src/text/memoryGenerator.js";

test("scanSkills reads SKILL.md frontmatter into skill nodes", () => {
  const root = mkdtempSync(join(tmpdir(), "gk-sk-"));
  try {
    mkdirSync(join(root, "configure-auth"), { recursive: true });
    writeFileSync(
      join(root, "configure-auth", "SKILL.md"),
      "---\nname: configure-auth\ndescription: Set up authentication\n---\n# Configure Auth\n",
    );
    const skills = scanSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.id, "skill:configure-auth");
    assert.equal(skills[0]!.kind, "skill");
    assert.equal(skills[0]!.metadata["description"], "Set up authentication");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanAgents reads agent .md files into agent nodes", () => {
  const root = mkdtempSync(join(tmpdir(), "gk-ag-"));
  try {
    writeFileSync(join(root, "planner.md"), "---\nname: planner\ndescription: Plans work\n---\nbody\n");
    const agents = scanAgents(root);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.id, "agent:planner");
    assert.equal(agents[0]!.kind, "agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mergeCapabilities links a skill to a memory doc that mentions it", () => {
  const vault = mkdtempSync(join(tmpdir(), "gk-cap-"));
  const skillsRoot = mkdtempSync(join(tmpdir(), "gk-caps-"));
  try {
    // mergeCapabilities matches on node titles/headings (bodies aren't in the
    // assembled graph), so the skill name appears as a heading here.
    writeFileSync(join(vault, "auth.md"), "# Auth design\nintro\n\n## configure-auth\nsetup details\n");
    mkdirSync(join(skillsRoot, "configure-auth"), { recursive: true });
    writeFileSync(join(skillsRoot, "configure-auth", "SKILL.md"), "---\nname: configure-auth\n---\nx\n");

    const { graph } = generateFromDir(vault);
    const merged = mergeCapabilities(graph, scanSkills(skillsRoot));

    const skill = merged.nodes.find((n) => n.id === "skill:configure-auth");
    assert.ok(skill, "skill node added");
    assert.ok(
      merged.edges.some((e) => e.fromId === "skill:configure-auth" && e.kind === "relatedTo"),
      "skill linked to the doc that mentions it",
    );
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(skillsRoot, { recursive: true, force: true });
  }
});
