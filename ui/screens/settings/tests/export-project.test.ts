import { test } from "node:test";
import assert from "node:assert/strict";
import { addReadmeBadge, decodeExportBundle, meetingMarkdown, planMarkdown, planPath, runProjectExport, slugify, type ExportBundle } from "../export-project.ts";
import type { FsApi } from "../../explorer/fs.ts";

const NOW = "2026-01-05T12:00:00.000Z";
const bundle: ExportBundle = {
  exportedAt: "2026-01-05T11:00:00.000Z",
  meetings: [{
    id: "abcdefgh12345678", title: "Plan / sync", date: "2026-01-05", durationSec: 125, language: "en",
    participants: ["Ada", "Grace"], transcript: "line ``` inside\nsecond",
    entities: [
      { id: "e1", kind: "action", text: "Ship *it*", quote: "yes" },
      { id: "e2", kind: "decision", text: "Use C++", quote: null },
    ],
  }],
  plans: [{
    id: "plan-00004321", meetingId: "abcdefgh12345678", title: "Release plan", goal: "Ship safely", language: "en",
    createdAt: "2026-01-05", updatedAt: null,
    tasks: [
      { id: "t2", position: 2, milestone: "M1", title: "Test", description: "Run tests", owner: "Ada", due: "2026-01-08", estimateDays: 2, dependsOn: ["t1"], status: "done", risk: null, riskReason: null },
      { id: "t1", position: 1, milestone: null, title: "Build", description: null, owner: null, due: null, estimateDays: null, dependsOn: [], status: "in_progress", risk: "low", riskReason: "stable" },
    ],
  }],
};

test("decode drops malformed rows and caps", () => {
  const b = decodeExportBundle({ exportedAt: "x", meetings: [null, { id: "m", title: "T", transcript: "s" }, { title: "no id" }], plans: [{ id: "p", title: "P", tasks: [{ title: "T" }] }] });
  assert.equal(b?.meetings.length, 1);
  assert.equal(b?.plans[0]?.tasks.length, 1);
  assert.equal(decodeExportBundle(null), null);
  assert.equal(decodeExportBundle({ status: 200, body: { meetings: [], plans: [] } }), null, "the HTTP envelope is not a bundle");
  assert.equal(decodeExportBundle({ meetings: [] }), null, "both arrays are required");
});

test("slug keeps Unicode and strips unsafe characters", () => {
  assert.equal(slugify("日本語 / Plan", "id12345678"), "日本語-plan-12345678");
  assert.equal(slugify("  ", "id12345678"), "untitled-12345678");
});

test("meeting Markdown fences the transcript and escapes summary text", () => {
  const md = meetingMarkdown(bundle.meetings[0]!, "p123");
  assert.match(md, /projectId: "p123"/);
  assert.match(md, /## Action Items/);
  assert.match(md, /Ship \\\*it\\\*/);
  assert.match(md, /````text/);
  assert.match(md, /## Transcript/);
});

test("plan Markdown sorts tasks and writes canonical path/suffix", () => {
  const md = planMarkdown(bundle.plans[0]!, NOW);
  assert.ok(md.indexOf("Build") < md.indexOf("Test"));
  assert.match(md, /Status: done/);
  assert.match(md, /Depends on: t1/);
  assert.equal(planPath(bundle.plans[0]!), "llm-doc/plans/2026-01-05-release-plan-00004321.md");
});

test("README badge only touches an LLM-IDE managed README", () => {
  assert.equal(addReadmeBadge("# user readme\n", NOW, 1), null);
  assert.match(addReadmeBadge("<!-- llmide:auto -->\n# X", NOW, 2)!, /2 meeting\(s\)/);
});

class FakeFs {
  files = new Map<string, string>();
  dirs = new Set<string>([""]);
  writes: string[] = [];
  async create(path: string, kind: string) {
    if (kind !== "dir") return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!this.dirs.has(parent)) throw { code: "not_found", message: "parent missing" };
    if (this.dirs.has(path)) throw { code: "exists", message: "exists" };
    this.dirs.add(path);
  }
  async write(path: string, text: string) { this.files.set(path, text); this.writes.push(path); }
  async read(path: string) { return { status: this.files.has(path) ? "ok" : "not_found", text: this.files.get(path) ?? null }; }
  async list(path: string) {
    const prefix = path + "/";
    return { entries: [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map((p) => ({ name: p.slice(prefix.length), kind: "file" })) };
  }
  async remove(path: string) { this.files.delete(path); }
}

test("the writer produces meetings, plans, index, badge and sync last", async () => {
  const fs = new FakeFs();
  fs.files.set("README.md", "<!-- llmide:auto -->\n# Project\n");
  const r = await runProjectExport({ bundle, projectId: "p123", fs: fs as unknown as FsApi, nowIso: NOW });
  assert.deepEqual(r, { meetings: 1, plans: 1, plansWriteFailed: false });
  assert.ok(fs.files.has("source/meetings/2026/01/2026-01-05-plan-sync-12345678.md"));
  assert.ok(fs.files.has("llm-doc/plans/2026-01-05-release-plan-00004321.md"));
  assert.match(fs.files.get("source/_index.json")!, /"count": 1/);
  assert.match(fs.files.get("README.md")!, /Last exported/);
  assert.equal(fs.writes.at(-1), "system/sync.json");
  assert.match(fs.files.get("system/sync.json")!, /"plansExported": 1/);
});

test("a full export with no meetings still writes a complete empty index and sync", async () => {
  const fs = new FakeFs();
  const r = await runProjectExport({ bundle: { exportedAt: "", meetings: [], plans: [] }, projectId: "p", fs: fs as unknown as FsApi, nowIso: NOW });
  assert.equal(r.meetings, 0);
  assert.match(fs.files.get("source/_index.json")!, /"count": 0/);
  assert.equal(fs.writes.at(-1), "system/sync.json");
});

test("bad dates fall back to the 0000 folder instead of rolling over", async () => {
  const fs = new FakeFs();
  const bad = { ...bundle, meetings: [{ ...bundle.meetings[0]!, date: "2026-02-30" }] };
  await runProjectExport({ bundle: bad, projectId: "p", fs: fs as unknown as FsApi, nowIso: NOW });
  assert.ok([...fs.files.keys()].some((p) => p.startsWith("source/meetings/0000/00/0000-00-00-")));
});

test("plans-only writes no meetings or sync and removes a superseded id file", async () => {
  const fs = new FakeFs();
  fs.dirs.add("llm-doc");
  fs.dirs.add("llm-doc/plans");
  fs.files.set("llm-doc/plans/2020-01-01-old-title-00004321.md", "old");
  const r = await runProjectExport({ bundle, projectId: "p123", fs: fs as unknown as FsApi, nowIso: NOW, plansOnly: true });
  assert.equal(r.plans, 1);
  assert.equal(fs.files.has("llm-doc/plans/2020-01-01-old-title-00004321.md"), false);
  assert.equal([...fs.files.keys()].some((p) => p.startsWith("source/") || p === "system/sync.json"), false);
});
