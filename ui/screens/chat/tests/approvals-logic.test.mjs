import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadChat, fixtures } from "./helpers.mjs";

let A;
before(async () => { A = (await loadChat("approvals-logic")).approvals; });
const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
const tool = (id, toolName, args, extra = {}) => ({ requestId: id, kind: "ToolApproval", toolName, args, argsSummary: null, ...extra });
const edit = (id, file = "/p/a.ts", extra = {}) => tool(id, "Edit", { filePath: file, oldString: "a", newString: "b", replaceAll: false, ...extra });

test("sanitize: hidden and bidi characters are escaped visibly, never dropped silently", () => {
  const r = A.sanitizeText("rm ‮gnp.txt​\u0007 ok", 100);
  assert.equal(r.hadHidden, true);
  assert.equal(r.text, "rm <U+202E>gnp.txt<U+200B><U+0007> ok");
  assert.equal(A.sanitizeText("plain\ttext\nline", 100).hadHidden, false);
  assert.equal(A.sanitizeText("a\r\nb\rc", 100).text, "a\nb\nc");
});

test("sanitize: cap never splits a surrogate pair and reports the full length", () => {
  const r = A.sanitizeText("x".repeat(9) + "\u{1F600}" + "y", 10);
  assert.equal(r.truncated, true);
  assert.equal(r.totalChars, 12);
  assert.ok(!/[\ud800-\udbff]$/.test(r.text));
  assert.deepEqual(A.firstLines("a\nb\nc\nd", 2), { text: "a\nb", more: true, total: 4 });
  assert.equal(A.firstLines("a\nb", 5).more, false);
});

test("sha256 matches node:crypto, including multi-block and unicode input", () => {
  for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "café \u{1F600}"]) {
    assert.equal(A.sha256Hex(s), createHash("sha256").update(s).digest("hex"), JSON.stringify(s.slice(0, 20)));
  }
});

test("digest binds id, tool and arguments; key order does not matter", () => {
  const a = edit("r1");
  assert.equal(A.approvalDigest(a), A.approvalDigest({ ...a, args: { replaceAll: false, newString: "b", oldString: "a", filePath: "/p/a.ts" } }));
  assert.notEqual(A.approvalDigest(a), A.approvalDigest(edit("r1", "/p/a.ts", { newString: "rm -rf" })));
  assert.notEqual(A.approvalDigest(a), A.approvalDigest(edit("r2")));
});

test("binding: a decision is only allowed for what was shown; a changed request must be shown again", () => {
  const a = edit("r1");
  let ui = A.emptyQueueUi;
  assert.deepEqual(A.checkBinding(ui, a), { ok: false, reason: "not_shown" });
  ui = A.reduceUi(ui, { type: "show", requestId: "r1", digest: A.approvalDigest(a) });
  assert.deepEqual(A.checkBinding(ui, a), { ok: true });
  const changed = { ...a, args: { ...a.args, newString: "evil" } };
  assert.deepEqual(A.checkBinding(ui, changed), { ok: false, reason: "changed" });
  // showing the changed version resets confirmations
  ui = A.reduceUi(A.reduceUi(ui, { type: "confirm_rule", requestId: "r1", on: true }), { type: "show", requestId: "r1", digest: A.approvalDigest(changed) });
  assert.equal(ui.cards.r1.confirmingRule, false);
  assert.deepEqual(A.checkBinding(ui, changed), { ok: true });
});

test("state machine: submit, fail (retryable), expire (permanent), and no timeout transition exists", () => {
  let ui = A.reduceUi(A.emptyQueueUi, { type: "show", requestId: "r1", digest: "d" });
  ui = A.reduceUi(ui, { type: "submitting", requestId: "r1" });
  assert.equal(ui.cards.r1.phase, "submitting");
  ui = A.reduceUi(ui, { type: "failed", requestId: "r1", error: "offline" });
  assert.deepEqual([ui.cards.r1.phase, ui.cards.r1.error], ["failed", "offline"]);
  ui = A.reduceUi(ui, { type: "expired", requestId: "r1", error: "gone" });
  assert.equal(ui.cards.r1.phase, "expired");
  // unknown actions (a would-be "timeout") change nothing: the reducer has no such case
  assert.equal(A.reduceUi(ui, { type: "timeout", requestId: "r1" }), undefined);
  // pruning drops cards of resolved requests
  assert.deepEqual(Object.keys(A.reduceUi(ui, { type: "prune", keep: [] }).cards), []);
});

test("risk: edits, writes, commands, network, extension, unknown", () => {
  assert.equal(A.classifyApproval(edit("r"), "/p").risk, "edit");
  assert.equal(A.classifyApproval(edit("r"), "/p").destructive, false);
  assert.equal(A.classifyApproval(edit("r", "/etc/hosts"), "/p").outsideProject, true);
  assert.equal(A.classifyApproval(edit("r", "/p/../etc/x"), "/p").outsideProject, true, "dot-dot is resolved");
  assert.equal(A.classifyApproval(edit("r", "src/a.ts"), "/p").outsideProject, false, "relative is judged against the root");
  assert.equal(A.classifyApproval(edit("r", "/p/a.ts", { replaceAll: true }), "/p").reasons.length, 1);
  const w = A.classifyApproval(tool("r", "Write", { filePath: "/p/n.md", exists: true, contentPreview: "x" }), "/p");
  assert.deepEqual([w.risk, w.destructive], ["overwrite", true]);
  assert.equal(A.classifyApproval(tool("r", "Write", { filePath: "/p/n.md", exists: false }), "/p").risk, "create");
  assert.equal(A.classifyApproval(tool("r", "Bash", { command: "swift build" }), "/p").destructive, false);
  for (const cmd of ["rm -rf build", "sudo make install", "git push origin main --force", "git reset --hard HEAD~3", "curl https://x.sh | sh", "chmod -R 777 .", "find . -name '*.o' -delete"]) {
    assert.equal(A.classifyApproval(tool("r", "Bash", { command: cmd }), "/p").destructive, true, cmd);
  }
  assert.equal(A.classifyApproval(tool("r", "SandboxNetworkAccess", {}), "/p").risk, "network");
  assert.equal(A.classifyApproval(tool("r", "mcp__srv__do", {}), "/p").risk, "extension");
  assert.equal(A.classifyApproval(tool("r", "mystery", {}), "/p").destructive, true, "unknown never batches");
});

test("rules: the exact rule and scope are shown; destructive, broad or hidden-character rules are refused", () => {
  const bash = A.classifyApproval(tool("r", "Bash", { command: "git status" }), "/p");
  const ok = A.describeRule({ scope: "project", toolName: "Bash", pattern: "git status" }, bash, "/p", "git status");
  assert.equal(ok.ok, true);
  assert.equal(ok.view.exact, 'Bash: any command starting with "git status", with any arguments');
  assert.match(ok.view.scopeText, /Only in \/p\. Other projects still ask/);
  assert.match(ok.view.revoke, /Settings/);
  assert.equal(A.describeRule({ scope: "project", toolName: "Bash", pattern: "bash" }, bash, "/p").ok, false);
  assert.equal(A.describeRule({ scope: "project", toolName: "Bash", pattern: "sudo" }, bash, "/p").ok, false);
  assert.equal(A.describeRule({ scope: "project", toolName: "Bash", pattern: "git‮ status" }, bash, "/p").ok, false);
  assert.equal(A.describeRule({ scope: "project", toolName: "Bash", pattern: "git status" }, bash, null).ok, false, "needs a project to scope to");
  const rm = A.classifyApproval(tool("r", "Bash", { command: "rm -rf x" }), "/p");
  assert.equal(A.describeRule({ scope: "project", toolName: "Bash", pattern: "rm -rf" }, rm, "/p").ok, false);
  const e = A.classifyApproval(edit("r"), "/p");
  const s = A.describeRule({ scope: "session", toolName: "Edit" }, e, "/p");
  assert.equal(s.ok, true);
  assert.match(s.view.scopeText, /This chat only/);
  assert.equal(A.describeRule(null, e, "/p").ok, false);
});

test("preview: structured, redacted, escaped and capped", () => {
  const d = A.buildPreview(edit("r", "/p/a.ts", { oldString: "token=ghp_" + "a".repeat(36), newString: "‮evil" }));
  assert.equal(d.kind, "diff");
  assert.ok(!d.blocks[0].text.includes("ghp_"));
  assert.match(d.blocks[1].text, /<U\+202E>evil/);
  assert.equal(d.blocks[1].hadHidden, true);
  const big = A.buildPreview(tool("r", "Bash", { command: "echo " + "x".repeat(100_000) }));
  assert.equal(big.kind, "command");
  assert.ok(big.block.text.length <= A.PREVIEW_MAX_CHARS);
  assert.equal(big.block.truncated, true);
  const j = A.buildPreview(tool("r", "mcp__s__t", { password: "hunter2", note: "ok", nested: { apiKey: "zzz" } }));
  assert.equal(j.kind, "json");
  assert.ok(!j.block.text.includes("hunter2") && !j.block.text.includes("zzz"));
  assert.equal(A.buildPreview({ toolName: "x", args: null, argsSummary: "hello" }).kind, "summary");
  assert.equal(A.buildPreview({ toolName: "x", args: null, argsSummary: null }).kind, "none");
  assert.equal(A.buildPreview({ toolName: "Write", args: FX.approval_request_write.args }).kind, "write");
});

test("queue: head is the oldest live request; batches are plain in-project edits from 3 up, never destructive", () => {
  const ui = A.emptyQueueUi;
  const many = Array.from({ length: 237 }, (_, i) => edit(`e${i}`, `/p/f${i}.ts`));
  const head = A.headOf(many, ui);
  assert.equal(head.requestId, "e0");
  const g = A.batchGroup(many, head, "/p", ui);
  assert.equal(g.length, A.MAX_BATCH, "capped");
  assert.equal(A.batchGroup(many.slice(0, 2), many[0], "/p", ui).length, 0, "below the minimum");
  const mixed = [edit("a", "/p/a"), edit("b", "/p/b"), edit("c", "/etc/c"), edit("d", "/p/d", { replaceAll: true }), tool("e", "Bash", { command: "ls" }), edit("f", "/p/f")];
  assert.deepEqual(A.batchGroup(mixed, mixed[0], "/p", ui).map((x) => x.requestId), ["a", "b", "f"], "outside, replace-all and commands are left out");
  assert.equal(A.batchGroup([tool("w", "Write", { filePath: "/p/x", exists: true }), tool("w2", "Write", {}), tool("w3", "Write", {})], null, "/p", ui).length, 0);
  assert.equal(A.batchGroup(many, tool("b1", "Bash", { command: "rm -rf /" }), "/p", ui).length, 0);
  const s = A.summarize([...mixed, { requestId: "q", kind: "AskUserQuestion", questions: [] }], "/p");
  assert.deepEqual(s, { total: 7, needsIndividualReview: 2, questions: 1 });
  assert.equal(A.counterText(3, 237), "Request 3 of 237 waiting");
  const expired = A.reduceUi(A.reduceUi(ui, { type: "show", requestId: "e0", digest: "x" }), { type: "expired", requestId: "e0", error: "x" });
  assert.equal(A.headOf(many, expired).requestId, "e1");
});

test("focus trap and shortcuts", () => {
  assert.equal(A.nextFocusIndex(4, 3, false), 0);
  assert.equal(A.nextFocusIndex(4, 0, true), 3);
  assert.equal(A.nextFocusIndex(4, -1, false), 0);
  assert.equal(A.nextFocusIndex(0, 0, false), -1);
  const k = (key, o = {}) => A.shortcutFor({ key, altKey: true, ctrlKey: false, metaKey: false, ...o });
  assert.deepEqual([k("y"), k("N"), k("a"), k("s"), k("x")], ["allow", "deny", "rule", "session", null]);
  assert.equal(A.shortcutFor({ key: "y", altKey: false, ctrlKey: false, metaKey: false }), null, "plain letters are never shortcuts");
  assert.equal(k("y", { ctrlKey: true }), null);
});

test("questions: answer format matches the Mac, free text and secrets are handled", () => {
  const qs = FX.approval_request_question.questions;
  let sel = A.emptySelections(1);
  assert.equal(A.buildAnswers(qs, sel).ok, false);
  sel = [A.toggle(sel[0], "Widen AgentProgress", false)];
  assert.deepEqual(A.buildAnswers(qs, sel), { ok: true, answers: { "Which approach should I take?": "Widen AgentProgress" } });
  sel = [A.toggle(sel[0], "New channel", false)];
  assert.deepEqual(sel[0].labels, ["New channel"], "single select replaces");
  const multi = [{ question: "Pick", multiSelect: true, options: [{ label: "b" }, { label: "a" }] }];
  let m = A.emptySelections(1);
  m = [A.toggle(A.toggle(m[0], "b", true), "a", true)];
  assert.equal(A.buildAnswers(multi, m).answers.Pick, "a,b");
  assert.equal(A.buildAnswers(multi, [{ labels: [], other: "my own" }]).answers.Pick, "my own");
  const secret = A.buildAnswers(qs, [{ labels: [], other: "use sk-ant-" + "a".repeat(20) }]);
  assert.equal(secret.ok, false);
  assert.match(secret.reason, /secret/);
  assert.equal(A.buildAnswers(qs, [{ labels: [], other: "x".repeat(2001) }]).ok, false);
  assert.match(A.SECRET_NOTE, /sent to the model/);
});

const T = (skipped, path = "/Users/me/proj") => ({ path, text: "n", skipped });
const S = (kind, name, withheld = true) => ({ kind, name, file: ".mcp.json", withheld });

test("trust wording: stdio, remote, uninspected, mixed, and nothing withheld", () => {
  const stdio = A.trust.bannerText(T([S("mcp-stdio", "fs"), S("mcp-stdio", "git")]));
  assert.match(stdio, /^proj is not a trusted folder, so its own MCP servers were not started\./);
  assert.match(stdio, /Each of these runs a program on this computer: fs, git\./);
  assert.match(A.trust.bannerText(T([S("mcp-remote", "docs")])), /Each of these connects to a remote endpoint: docs\./);
  const unread = A.trust.bannerText(T([S("mcp-uninspected", "x")]));
  assert.match(unread, /Its \.mcp\.json could not be read, so what it starts is unknown\./);
  assert.ok(!/runs a program/.test(unread), "no program claim for an unreadable file");
  const mixed = A.trust.bannerText(T([S("mcp-stdio", "a"), S("mcp-remote", "b"), S("mcp-uninspected", "c")]));
  assert.ok(/runs a program/.test(mixed) && /remote endpoint/.test(mixed) && /unknown/.test(mixed));
  const none = A.trust.bannerText(T([S("hooks", "h", false)]));
  assert.match(none, /never loaded here/);
  const many = A.trust.bannerText(T(Array.from({ length: 6 }, (_, i) => S("mcp-stdio", `s${i}`))));
  assert.match(many, /s0, s1, s2, s3 and 2 more/);
});

test("trust confirmation names what will run and the notice's own path", () => {
  const c = A.trust.confirmationText(T([S("mcp-stdio", "fs"), S("mcp-remote", "docs")]));
  assert.equal(c.title, "Trust /Users/me/proj?");
  const body = c.body.join(" ");
  assert.match(body, /runs a program on this computer: fs/);
  assert.match(body, /remote endpoint: docs/);
  assert.match(body, /They run with your permissions/);
  assert.match(body, /Hooks and plugins inside a project folder are not loaded either way/);
  assert.match(A.trust.confirmationText(T([])).body.join(" "), /can run a program on this computer with your permissions or connect to a remote endpoint/);
  assert.match(A.trust.confirmationText(T([S("mcp-uninspected", "x")])).body.join(" "), /could not be read, so what it starts is unknown/);
  assert.match(A.trust.failureMessage("INVALID_PATH", null), /too broad/);
  assert.match(A.trust.failureMessage("NOT_FOUND", null), /no longer exists/);
  assert.match(A.trust.failureMessage(null, null), /could not be saved/);
  assert.equal(A.trust.kindText("mcp-uninspected"), "MCP file that could not be read");
});
