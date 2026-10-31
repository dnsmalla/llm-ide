import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html, fixtures } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("plan"); });
const ev = (type, o = {}) => c.decodeEvent({ type, ...o }).event;

const PLAN = `# Add dark mode toggle

**Goal:** Let users switch the theme from Settings. Persist the choice.

## Steps

1. Add a \`theme\` field to the settings store and migrate old files.
2. Build the toggle component with an accessible switch role.
3. Wire the toggle to the theme provider and persist it.
4. Add tests for the store migration and the toggle.

## Risks

- Existing users have no stored value, so the default must stay light.
- The provider re-renders the whole tree when the theme changes.

\`\`\`bash
# 1. not a step: a comment in a fence
npm test
\`\`\`
`;

test("looksLikePlan: long, sectioned, enumerating work; not a question, not the triage answer, not code", () => {
  assert.equal(c.looksLikePlan(PLAN), true);
  assert.equal(c.looksLikePlan("Short answer.\n1. a\n2. b"), false, "too short");
  assert.equal(c.looksLikePlan(`**Nothing to execute.** ${"The change is already in place. ".repeat(20)}\n\n## Findings\n1. a\n2. b\n3. c`), false);
  assert.equal(c.looksLikePlan(`${PLAN}\nDoes this approach make sense?`), false, "ends by asking: a proposal, not a plan");
  const fenceOnly = `Explanation of the build.\n\n${"Some prose to pass the length gate. ".repeat(15)}\n\n\`\`\`bash\n# Heading-looking comment\n1. step-looking line\n2. another\n3. third\n\`\`\``;
  assert.equal(c.looksLikePlan(fenceOnly), false, "fenced code is quoted text, not structure");
  const unsectioned = `${"Intro that is long enough to pass the byte gate for a plan reply. ".repeat(8)}\n\n1. First thing\n2. Second thing\n3. Third thing`;
  assert.equal(c.looksLikePlan(unsectioned), true, "3+ steps need no heading");
  assert.equal(c.looksLikePlan(`${"Intro long enough to pass the byte gate for a plan reply. ".repeat(8)}\n\n1. First thing\n2. Second thing`), false, "2 steps without a heading are not enough");
  const jp = `# 計画\n\n${"概要の説明です。".repeat(60)}\n\n## 手順\n\n### 第1段階 準備\n### 第2段階 実装\n`;
  assert.equal(c.looksLikePlan(jp), true, "Japanese step words");
  assert.equal(c.looksLikePlan("1.5x faster is nice\n".repeat(40)), false, "1.5x is not a step");
});

test("'Nothing to execute.' marker: tolerant of markdown decoration, only at the start", () => {
  for (const t of ["**Nothing to execute.** x", "Nothing to execute. x", "## _Nothing to execute_\nrest", "> **nothing to execute.**"]) assert.equal(c.opensWithNothingToExecute(t), true, t);
  assert.equal(c.opensWithNothingToExecute("Here is the plan. Nothing to execute."), false);
  assert.equal(c.NOTHING_TO_EXECUTE, "Nothing to execute.");
});

test("planTitle: H1, then Goal line, then a non-generic heading, then the first line; 60 chars", () => {
  assert.equal(c.planTitle(PLAN), "Add dark mode toggle");
  assert.equal(c.planTitle("**Goal:** Use knip to find dead code. Then more.\n\n## Context\nx"), "Use knip to find dead code");
  assert.equal(c.planTitle("Here's the plan:\n\n## Context\nx\n\n## Migrate the billing service\ny"), "Migrate the billing service");
  assert.equal(c.planTitle("Just a sentence"), "Just a sentence");
  assert.equal(c.planTitle("```md\n# in a fence\n```\n# Real title"), "Real title");
  assert.ok(c.planTitle(`# ${"x".repeat(100)}`).length <= 60);
  assert.equal(c.planTitle("**Goal:** Upgrade to Node.js 22 now"), "Upgrade to Node.js 22 now", "a dot inside a version does not end the sentence");
});

test("parsePlanSteps: steps section, Task headings, numbered, bullets; capped; fences ignored", () => {
  assert.deepEqual(c.parsePlanSteps(PLAN).map((s) => s.slice(0, 22)), ["Add a `theme` field to", "Build the toggle compo", "Wire the toggle to the", "Add tests for the stor"]);
  assert.deepEqual(c.parsePlanSteps("### Task 1: Install knip\nFiles: a\n- bullet\n### Task 2: Run it\n"), ["Install knip", "Run it"]);
  assert.deepEqual(c.parsePlanSteps("- [ ] Add tests\n- [x] Fix bug\n  - sub detail"), ["Add tests", "Fix bug"]);
  assert.deepEqual(c.parsePlanSteps("no steps here"), []);
  assert.equal(c.parsePlanSteps(Array.from({ length: 50 }, (_, i) => `${i + 1}. do thing ${i}`).join("\n")).length, 30);
});

test("executePlanMessage and the Execute turn: planExecute, execute mode, plan attached, cut reported", () => {
  const msg = c.executePlanMessage(PLAN, "Add dark mode toggle");
  assert.match(msg, /^Execute the attached approved plan\./);
  assert.match(msg, /Plan title: "Add dark mode toggle"\./);
  assert.match(msg, /Follow the execution skill in your instructions, starting at step 1\./);
  assert.match(msg, /\n1\. Add a `theme` field/);
  assert.match(msg, /\n4\. Add tests/);
  assert.equal(c.executePlanMessage("no steps", null), c.GENERIC_EXECUTE_MESSAGE);
  const t = c.buildExecuteTurn({ title: "Add dark mode toggle", content: PLAN, savedPath: "llm-doc/plans/2026-10-31-add-dark-mode-toggle.md" });
  assert.equal(t.options.mode, "execute");
  assert.equal(t.options.planExecute, true);
  assert.deepEqual(t.options.attachments, [{ path: "llm-doc/plans/2026-10-31-add-dark-mode-toggle.md", content: PLAN }]);
  assert.equal(t.truncated, false);
  const t2 = c.buildExecuteTurn({ title: "Big", content: "x".repeat(100_000), savedPath: null });
  assert.equal(t2.options.attachments[0].path, "plan: Big");
  assert.equal(t2.options.attachments[0].content.length, c.MAX_TEXT_CHARS_PER_FILE);
  assert.equal(t2.truncated, true);
});

test("plan file names: dated slug under llm-doc/plans, reuse of the chat's own plan, unsafe characters dropped", () => {
  const d = new Date(2026, 9, 31);
  assert.equal(c.planFilePath("Add Dark Mode: v2/final?", d), "llm-doc/plans/2026-10-31-add-dark-mode-v2final.md");
  assert.equal(c.planFilePath("", d), "llm-doc/plans/2026-10-31-untitled-plan.md");
  assert.equal(c.planFilePath("../../etc/passwd", d), "llm-doc/plans/2026-10-31-....etcpasswd.md", "path characters are dropped from the slug");
  assert.ok(!c.planFilePath("../../x", d).slice("llm-doc/plans/".length).includes("/"));
  assert.equal(c.planFilePath("New title", d, "llm-doc/plans/2026-10-30-old.md"), "llm-doc/plans/2026-10-30-old.md");
  assert.equal(c.reusablePlanPath("llm-doc/plans/sub/x.md"), null);
  assert.equal(c.reusablePlanPath("elsewhere/x.md"), null);
  assert.equal(c.reusablePlanPath("llm-doc/plans/x.txt"), null);
  assert.equal(c.slugify("  A   B  "), "a-b");
  assert.ok(c.slugify("x".repeat(200)).length <= 60);
});

// --- plan reducer from agent/v2 events -------------------------------------------------------------------

function planTurn(text, { mode = "plan", status = "result" } = {}) {
  let s = c.reduce(c.initialState("c1"), { type: "send", id: "t1", text: "plan the dark mode work" });
  const events = [ev("init", { sessionId: "sdk1", model: "claude-sonnet-5" }), ev("mode_set", { mode }), ev("delta", { text })];
  if (status === "result") events.push(ev("result", { subtype: "success" }));
  return c.reduce(s, { type: "events", events });
}

test("planCardFor: plan card after a finished plan-mode reply, 'nothing' marker, nothing in other modes or mid-stream", () => {
  const done = planTurn(PLAN);
  const card = c.planCardFor(done, { mode: "plan" });
  assert.equal(card.kind, "plan");
  assert.equal(card.title, "Add dark mode toggle");
  assert.equal(card.steps.length, 4);
  assert.equal(c.planCardFor(done, { mode: "execute" }).kind, "none", "a plan-shaped reply outside a plan mode gets no plan actions");
  assert.equal(c.planCardFor(done, { mode: "execute", sessionPlanning: true }).kind, "plan", "...unless the chat already ran a plan turn");
  assert.equal(c.planCardFor(planTurn(PLAN, { status: "streaming" }), { mode: "plan" }).kind, "none", "not while streaming");
  const nothing = planTurn("**Nothing to execute.** The setting already exists.\n\n## Findings\n1. a\n2. b\n3. c", {});
  assert.equal(c.planCardFor(nothing, { mode: "plan" }).kind, "nothing");
  assert.equal(c.planCardFor(planTurn("Sure, here is a short answer."), { mode: "plan" }).kind, "none");
  assert.equal(c.planCardFor(c.initialState("x"), { mode: "plan" }).kind, "none");
  assert.deepEqual([c.sessionIsPlanning(["execute", null]), c.sessionIsPlanning(["execute", "assist_plan"])], [false, true]);
  const edited = c.effectivePlan(card, { title: "Mine", content: "# Mine\n\n1. only step" });
  assert.deepEqual([edited.title, edited.steps], ["Mine", ["only step"]]);
});

test("planCardFor works on every agent/v2 fixture turn without throwing", () => {
  for (const f of fixtures()) {
    const d = c.decodeEvent(f.json);
    if (!d.ok) continue;
    const s = c.reduce(c.reduce(c.initialState("f"), { type: "send", id: "t", text: "x" }), { type: "events", events: [d.event] });
    assert.ok(["none", "plan", "nothing"].includes(c.planCardFor(s, { mode: "plan" }).kind), f.name);
  }
});

// --- plan controller (save) -----------------------------------------------------------------------------

function fakePlanFs({ fail } = {}) {
  const files = new Map(); const dirs = new Set(); const log = []; const hashes = new Map(); let n = 0;
  return { files, dirs, log, hashes,
    async list() { return { entries: [], nextOffset: null }; }, async readHead() { return { text: "", truncated: false, binary: false }; },
    async ensureDir(p) { log.push(["dir", p]); if (fail === "dir") throw Object.assign(new Error("x"), { code: "no_project" }); dirs.add(p); },
    // Same contract as the host: no hash = create only; a hash = replace only while the content still has it.
    async writeText(p, t, expected = null) {
      log.push(["write", p, expected]);
      if (fail === "write") throw Object.assign(new Error("x"), { code: "conflict" });
      if (files.has(p)) {
        if (expected === null) throw Object.assign(new Error("exists"), { code: "exists" });
        if (hashes.get(p) !== expected) throw Object.assign(new Error("conflict"), { code: "conflict" });
      } else if (expected !== null) throw Object.assign(new Error("conflict"), { code: "conflict" });
      files.set(p, t); const h = `h${++n}`; hashes.set(p, h); return { hash: h };
    },
    /** Simulates the user editing a file on disk. */
    userEdit(p, t) { files.set(p, t); hashes.set(p, `user${++n}`); } };
}

test("PlanController: saves under llm-doc/plans once, silent on a double click, revisions go into the same file", async () => {
  const fs = fakePlanFs();
  const pc = new c.PlanController(fs, () => new Date(2026, 9, 31));
  const seen = [];
  pc.subscribe(() => seen.push(pc.get("c1", "m1").save.status));
  const [a, b] = await Promise.all([pc.save("c1", "m1", "Add dark mode", PLAN), pc.save("c1", "m1", "Add dark mode", PLAN)]);
  assert.equal(a, "llm-doc/plans/2026-10-31-add-dark-mode.md");
  assert.equal(b, null, "a second save while saving is refused quietly");
  assert.deepEqual(fs.log.filter((x) => x[0] === "dir").map((x) => x[1]), ["llm-doc", "llm-doc/plans"]);
  assert.equal(fs.files.get(a), `${PLAN}`.endsWith("\n") ? PLAN : `${PLAN}\n`);
  assert.deepEqual(seen, ["saving", "saved"]);
  assert.equal(await pc.save("c1", "m1", "Add dark mode", PLAN), a, "already saved: returns the path, writes nothing");
  assert.equal(fs.log.filter((x) => x[0] === "write").length, 1);
  // Edit sheet: replace content in the same file, remember the edit for Execute.
  const again = await pc.save("c1", "m1", "Edited", "# Edited\n\n1. one", true);
  assert.equal(again, a);
  assert.equal(fs.files.get(a), "# Edited\n\n1. one\n");
  assert.deepEqual(pc.get("c1", "m1").edited, { title: "Edited", content: "# Edited\n\n1. one" });
  // A later plan reply of the same chat goes into the chat's plan file.
  assert.equal(await pc.save("c1", "m2", "Totally different", PLAN), a);
  assert.equal(pc.savedPath("c1", "m1"), a);
  pc.markExecuted("c1", "m1");
  assert.equal(pc.get("c1", "m1").executed, true);
  pc.forget("c1");
  assert.equal(pc.get("c1", "m1").save.status, "idle");
});

test("PlanController: errors are readable, no project means no save, empty plans are refused", async () => {
  assert.equal(await new c.PlanController(null).save("c", "m", "t", PLAN), null);
  const pc0 = new c.PlanController(null);
  await pc0.save("c", "m", "t", PLAN);
  assert.match(pc0.get("c", "m").save.message, /Open a project/);
  assert.equal(pc0.canSave, false);
  const pc1 = new c.PlanController(fakePlanFs({ fail: "write" }));
  assert.equal(await pc1.save("c", "m", "t", PLAN), null);
  assert.match(pc1.get("c", "m").save.message, /changed on disk/);
  const pc2 = new c.PlanController(fakePlanFs({ fail: "dir" }));
  await pc2.save("c", "m", "t", PLAN);
  assert.match(pc2.get("c", "m").save.message, /Open a project/);
  const pc3 = new c.PlanController(fakePlanFs());
  await pc3.save("c", "m", "t", "   \n ");
  assert.match(pc3.get("c", "m").save.message, /no content/);
  // a failed save can be retried
  const flaky = fakePlanFs({ fail: "write" });
  const pc4 = new c.PlanController(flaky);
  await pc4.save("c", "m", "t", PLAN);
  flaky.writeText = async (p, t) => { flaky.files.set(p, t); return { hash: null }; };
  assert.ok(await pc4.save("c", "m", "t", PLAN));
});

test("PlanController: two plans with the same title and day never replace each other or a user file", async () => {
  const fs = fakePlanFs();
  fs.files.set("llm-doc/plans/2026-10-31-add-dark-mode.md", "USER AUTHORED"); fs.hashes.set("llm-doc/plans/2026-10-31-add-dark-mode.md", "u0");
  const pc = new c.PlanController(fs, () => new Date(2026, 9, 31));
  const a = await pc.save("c1", "m1", "Add dark mode", PLAN);
  assert.equal(a, "llm-doc/plans/2026-10-31-add-dark-mode-2.md");
  assert.equal(fs.files.get("llm-doc/plans/2026-10-31-add-dark-mode.md"), "USER AUTHORED");
  // Another chat, same title: its own file again, nothing replaced.
  const b = await pc.save("c2", "m1", "Add dark mode", "# Other\n\n1. x");
  assert.equal(b, "llm-doc/plans/2026-10-31-add-dark-mode-3.md");
  assert.equal(fs.files.get(a), `${PLAN}\n`.replace(/\n\n$/, "\n"));
  // untitled plans from two chats
  const u1 = await pc.save("c3", "m1", "", PLAN); const u2 = await pc.save("c4", "m1", "", PLAN);
  assert.notEqual(u1, u2);
  assert.equal(fs.files.size, 5);
});

test("PlanController: a revision replaces only the file this chat wrote, and only while unchanged", async () => {
  const fs = fakePlanFs();
  const pc = new c.PlanController(fs, () => new Date(2026, 9, 31));
  const a = await pc.save("c1", "m1", "Plan", PLAN);
  assert.equal(await pc.save("c1", "m2", "Other title", "# Rev\n\n1. y"), a, "a later plan of the chat revises its file");
  assert.equal(fs.files.get(a), "# Rev\n\n1. y\n");
  assert.deepEqual(fs.log.filter((x) => x[0] === "write").map((x) => x[2] === null), [true, false], "the revision wrote against the hash");
  // The user edits the file: the next plan of this chat goes to a NEW file, the edit survives.
  fs.userEdit(a, "MY EDITS");
  const b = await pc.save("c1", "m3", "Plan", "# Third\n\n1. z");
  assert.notEqual(b, a);
  assert.equal(fs.files.get(a), "MY EDITS");
  // Edit sheet on a saved plan whose file changed on disk: a visible conflict, never a blind write.
  fs.userEdit(b, "ALSO EDITED");
  assert.equal(await pc.save("c1", "m3", "Plan", "# Third v2\n\n1. z", true), null);
  assert.match(pc.get("c1", "m3").save.message, /changed on disk/);
  assert.equal(fs.files.get(b), "ALSO EDITED");
});

// --- diff / edit previews ------------------------------------------------------------------------------

test("diffStats: +N -M like the Mac, CRLF counted once, preview of the first 3 changes", () => {
  const s = c.diffStats("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual([s.added, s.removed], [2, 1]);
  assert.deepEqual(s.previewLines, ["- b", "+ B", "+ e"]);
  const crlf = c.diffStats("one\r\ntwo\r\nthree", "one\r\ntwo\r\nthree\r\nfour");
  assert.deepEqual([crlf.added, crlf.removed], [1, 0], "CRLF must not double-count lines");
  assert.deepEqual([c.diffStats("", "x\ny").added, c.diffStats("x\ny", "").removed], [2, 2]);
  assert.deepEqual([c.diffStats("same", "same").added, c.diffStats("same", "same").removed], [0, 0]);
});

test("diff: a huge replacement degrades to a replaced block instead of freezing", () => {
  const a = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join("\n");
  const b = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join("\n");
  const t0 = performance.now();
  const s = c.diffStats(a, b);
  assert.ok(performance.now() - t0 < 500, "bounded work");
  assert.equal(s.approximate, true);
  assert.deepEqual([s.added, s.removed], [5000, 5000]);
  const rows = c.diffRows(a, b).rows;
  const v = c.hunkView(rows, 3, 400);
  assert.ok(v.rows.length <= 401);
  assert.ok(v.hiddenChanges > 0);
  // exact when small, with context and skip markers
  const small = c.hunkView(c.diffRows(Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 50 }, (_, i) => (i === 25 ? "CHANGED" : `l${i}`)).join("\n")).rows, 3);
  assert.ok(small.rows.some((r) => r.op === "skip"));
  assert.equal(small.rows.filter((r) => r.op === "+").length, 1);
});

test("editFromTool: Edit, MultiEdit, Write (also MCP-prefixed); truncated or odd arguments give nothing", () => {
  const edit = c.editFromTool("Edit", JSON.stringify({ file_path: "/p/a.ts", old_string: "a", new_string: "b\nc" }), false);
  assert.deepEqual([edit.kind, edit.path, edit.edits.length], ["edit", "/p/a.ts", 1]);
  assert.equal(c.editFromTool("mcp__llmide__Write", JSON.stringify({ file_path: "x", content: "hi" }), false).kind, "write");
  assert.equal(c.editFromTool("MultiEdit", JSON.stringify({ file_path: "x", edits: [{ old_string: "a", new_string: "b" }, { nope: 1 }] }), false).edits.length, 1);
  assert.equal(c.editFromTool("Edit", "{\"file_path\":\"x\",\"old_str", true), null);
  assert.equal(c.editFromTool("Edit", "not json", false), null);
  assert.equal(c.editFromTool("Bash", JSON.stringify({ command: "ls" }), false), null);
  assert.equal(c.editFromTool(null, "{}", false), null);
  const stats = c.callStats(c.editFromTool("MultiEdit", JSON.stringify({ file_path: "x", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c\nd", new_string: "c" }] }), false));
  assert.deepEqual([stats.added, stats.removed], [1, 2]);
});

test("EditPreview: chip with counts, diff on demand, absolute paths shown as file names", () => {
  const call = c.editFromTool("Edit", JSON.stringify({ file_path: "/Users/me/secret/proj/src/a.ts", old_string: "x", new_string: "y\nz" }), false);
  const out = html(h(c.EditPreview, { call }));
  assert.match(out, /role="group"[^>]*aria-label="Changes to a\.ts"/);
  assert.ok(!out.includes("/Users/me"), "no absolute path");
  assert.match(out, /\+2/);
  assert.match(out, /aria-expanded="false"/);
  assert.ok(!out.includes('class="chat-diff"'), "the diff is built lazily");
  const rel = html(h(c.EditPreview, { call, resolvePath: () => "src/a.ts" }));
  assert.match(rel, /aria-label="Changes to src\/a\.ts"/);
  assert.equal(c.editPreviewFor({ name: "Bash", args: "{}", argsTruncated: false }), null);
  assert.ok(c.editPreviewFor({ name: "Edit", args: JSON.stringify({ file_path: "a", old_string: "a", new_string: "b" }), argsTruncated: false }));
});

// --- components --------------------------------------------------------------------------------------

test("PlanCardView: named region, preview collapsed, Save / Edit / Refine / Execute, states", () => {
  const card = c.planCardFor(planTurn(PLAN), { mode: "plan" });
  const base = { card, state: { save: { status: "idle" }, executed: false, edited: null }, canSave: true, onSave() {}, onExecute() {}, onRefine() {} };
  const out = html(h(c.PlanCardView, base));
  assert.match(out, /<section[^>]*aria-label="Plan: Add dark mode toggle"/);
  assert.match(out, /4 steps/);
  assert.match(out, /Save plan/);
  assert.match(out, /Edit<\/button>/);
  assert.match(out, /Refine in chat/);
  assert.match(out, /Execute plan/);
  assert.match(out, /Show all \d+ lines/);
  const saved = html(h(c.PlanCardView, { ...base, state: { ...base.state, save: { status: "saved", path: "llm-doc/plans/x.md" } } }));
  assert.match(saved, /Saved to llm-doc\/plans\/x\.md/);
  assert.match(saved, /disabled=""[^>]*>Saved</);
  const err = html(h(c.PlanCardView, { ...base, state: { ...base.state, save: { status: "error", message: "The plan could not be saved." } } }));
  assert.match(err, /role="alert"[^>]*>The plan could not be saved\./);
  const noproj = html(h(c.PlanCardView, { ...base, canSave: false }));
  assert.match(noproj, /Open a project to save this plan/);
  const exec = html(h(c.PlanCardView, { ...base, state: { ...base.state, executed: true } }));
  assert.match(exec, /Executing/);
  assert.match(html(h(c.NothingToExecuteChip)), /Nothing to execute\./);
  const evil = { ...card, title: "<img src=x onerror=1>", content: "# x\n\n<script>alert(1)</script>\n\n1. a\n2. b" };
  const o2 = html(h(c.PlanCardView, { ...base, card: evil }));
  assert.ok(!o2.includes("<script") && !o2.includes("<img"));
});

test("PlanArea: renders the card for a finished plan reply, the marker chip, or nothing", () => {
  const plans = new c.PlanController(null);
  const props = (state, mode = "plan") => ({ chatId: "c1", state, mode, plans, onExecute() {}, onRefine() {} });
  assert.match(html(h(c.PlanArea, props(planTurn(PLAN)))), /aria-label="Plan: Add dark mode toggle"/);
  assert.match(html(h(c.PlanArea, props(planTurn("**Nothing to execute.** done", {})))), /Nothing to execute/);
  assert.equal(html(h(c.PlanArea, props(planTurn(PLAN), "execute"))), "");
  assert.equal(html(h(c.PlanArea, props(planTurn(PLAN), "auto"))), html(h(c.PlanArea, props(planTurn(PLAN), "plan"))), "Auto follows the server's resolved mode (plan)");
  assert.equal(c.refineSeed("Add dark mode"), 'Revise the plan "Add dark mode": ');
  assert.equal(c.refineSeed(" "), "Revise the plan: ");
});

// --- badges --------------------------------------------------------------------------------------------

test("subagent summary from ask-subagent tool calls (MCP-prefixed on v2)", () => {
  const tool = (index, args, result) => ({ kind: "tool", index, id: `t${index}`, name: "mcp__llmide__ask-subagent", args, argsTruncated: false, result });
  const m = (status, parts) => ({ role: "assistant", id: "a", parts, notices: [], status });
  const running = c.summarizeSubagents(m("streaming", [tool(0, '{"name":"reviewer"}', null), tool(1, '{"name":"tester"}', { text: "ok", isError: false, truncated: false, totalChars: 2 }), { kind: "tool", index: 2, id: "x", name: "Read", args: "{}", argsTruncated: false, result: null }]));
  assert.deepEqual(running.runs.map((r) => [r.name, r.state]), [["reviewer", "running"], ["tester", "done"]]);
  assert.equal(running.label, "1 of 2 agents running");
  const stopped = c.summarizeSubagents(m("aborted", [tool(0, '{"name":"a\\u202Eb"}', null)]));
  assert.equal(stopped.runs[0].state, "stopped");
  assert.equal(stopped.runs[0].name, "ab");
  assert.equal(stopped.label, "1 agent");
  assert.equal(c.summarizeSubagents(undefined).runs.length, 0);
  assert.equal(c.isSubagentTool("ask-subagent"), true);
  assert.equal(c.isSubagentTool("Read"), false);
  assert.equal(html(h(c.SubagentChip, { summary: c.summarizeSubagents(undefined) })), "");
  assert.match(html(h(c.SubagentChip, { summary: running })), /aria-expanded="false"[^>]*>1 of 2 agents running/);
});

test("mode badge, route history decoding, ended-chat banner", () => {
  assert.match(html(h(c.ModeBadge, { mode: "plan", resolved: null })), /aria-label="Mode: Plan"/);
  assert.match(html(h(c.ModeBadge, { mode: "auto", resolved: "execute" })), /aria-label="Mode: Execute \(chosen automatically\)"/);
  assert.equal(html(h(c.ModeBadge, { mode: "auto", resolved: null })), "");
  const hist = c.decodeRouteHistory({ degraded: true, events: [{ id: 2, at: "2026-10-31T00:00:00Z", kind: "switch", fromProvider: "anthropic", fromModel: "a", toProvider: "custom:x", toModel: "b\u202E", reason: "user" }, { id: "bad" }, { id: 3, kind: "weird\u0007", at: "t" }] });
  assert.equal(hist.degraded, true);
  assert.equal(hist.events.length, 2);
  assert.equal(hist.events[0].kind, "Switched");
  assert.equal(hist.events[0].to, "custom:x / b");
  assert.equal(hist.events[1].kind, "weird");
  assert.deepEqual(c.decodeRouteHistory(null), { events: [], degraded: false });
  assert.match(html(h(c.RouteHistory, { core: { json: async () => ({}) }, chatId: "c1" })), /aria-expanded="false"[^>]*>Route history/);
  assert.equal(c.isEndedChat({ endedAt: 1.7e9 }), true);
  assert.equal(c.isEndedChat({ ended: true }), true);
  assert.equal(c.isEndedChat({ title: "x" }), false);
  assert.equal(c.isEndedChat(undefined), false);
  assert.match(html(h(c.EndedBanner, { onNewChat() {} })), /role="status"[^>]*><span>[^<]*read-only[^<]*<\/span> <button[^>]*>New chat/);
});

test("Composer with extras: blocked while reading, built-ins never reach onSend, attachments ride along", () => {
  const extras = { onKeyDown: () => false, textareaProps: { role: "combobox", "aria-expanded": false }, menu: null, chips: h("div", { id: "chips" }), toolbar: h("button", { "aria-label": "Attach files", type: "button" }, "Attach"), blockedReason: "Reading attachments…", prepareSend: (t) => ({ text: t, extra: {} }) };
  const out = html(h(c.Composer, { draft: "hi", onDraft() {}, busy: false, aborting: false, queue: [], history: [], onSend() {}, onStop() {}, onDropQueued() {}, extras }));
  assert.match(out, /id="chips"/);
  assert.match(out, /role="combobox"[^>]*aria-expanded="false"/);
  assert.match(out, /Reading attachments/);
  assert.match(out, /disabled=""[^>]*>Send</, "the send button is held while an attachment is being read");
  assert.equal((out.match(/Attach files/g) ?? []).length, 1, "the extras' toolbar replaces the plain Attach button");
});
