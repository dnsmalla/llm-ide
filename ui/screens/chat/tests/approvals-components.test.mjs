import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, fixtures, CHAT } from "./helpers.mjs";

let A;
before(async () => { A = (await loadChat("approvals-components")).approvals; });
const FX = Object.fromEntries(fixtures().map((f) => [f.name.replace(".json", ""), f.json]));
const noop = () => {};
const count = (s, re) => (s.match(re) ?? []).length;
const tool = (id, toolName, args, extra = {}) => ({ requestId: id, kind: "ToolApproval", toolName, args, argsSummary: null, suggestion: null, ...extra });
const bash = (id, command, extra) => tool(id, "Bash", { command }, extra);

const cardProps = (approval, extra = {}) => ({
  approval, ui: { phase: "idle", error: null, shown: "d", confirmingRule: false }, projectRoot: "/p", position: 1, total: 1, batch: [], turnClosed: false,
  batchProgress: null, onDecide: noop, onConfirmRule: noop, onBatch: noop, dwellMs: 0, ...extra,
});

test("ApprovalCard: named group, the four choices with shortcuts, and a statement that nothing is automatic", () => {
  const out = html(h(A.ApprovalCard, cardProps(bash("r1", "npm test", { suggestion: { scope: "project", toolName: "Bash", pattern: "npm test" } }))));
  assert.match(out, /role="group"[^>]*aria-label="Approval needed: Run a command"/);
  assert.match(out, />Allow once</);
  assert.match(out, /aria-keyshortcuts="Alt\+Y"/);
  assert.match(out, /Always allow &quot;npm test&quot; here/);
  assert.match(out, />Deny</);
  assert.match(out, /aria-label="Optional note to the assistant, sent with Deny"/);
  assert.match(out, /never allowed automatically, and a timeout only denies/);
  assert.match(out, /data-destructive="false"/);
  assert.ok(!/dangerouslySetInnerHTML/.test(out));
});

test("ApprovalCard: tool arguments are escaped text; hidden characters and secrets are handled", () => {
  const out = html(h(A.ApprovalCard, cardProps(bash("r1", "echo '<img src=x onerror=alert(1)>' ‮ ghp_" + "a".repeat(36)))));
  assert.ok(!out.includes("<img"));
  assert.match(out, /&lt;img src=x/);
  assert.match(out, /&lt;U\+202E&gt;/);
  assert.match(out, /hidden or control characters/);
  assert.ok(!out.includes("ghp_aaaa"));
  assert.match(out, /\[REDACTED\]/);
});

test("ApprovalCard: destructive calls say why, show no saved-rule button, and are not batchable", () => {
  const out = html(h(A.ApprovalCard, cardProps(bash("r1", "rm -rf build", { suggestion: { scope: "project", toolName: "Bash", pattern: "rm -rf" } }))));
  assert.match(out, /data-destructive="true"/);
  assert.match(out, /deletes files recursively or by force/);
  assert.ok(!/Always allow/.test(out));
  assert.match(out, /approved one at a time/);
});

test("ApprovalCard: edit shows the file, the diff blocks and the replace-all warning; outside-project is flagged", () => {
  const e = tool("r2", "Edit", { filePath: "/etc/hosts", oldString: "a", newString: "b", replaceAll: true });
  const out = html(h(A.ApprovalCard, cardProps(e)));
  assert.match(out, /\/etc\/hosts \(outside the open project\)/);
  assert.match(out, /Removed/);
  assert.match(out, /Replacement/);
  assert.match(out, /Replaces ALL occurrences/);
  assert.match(out, /data-destructive="true"/);
});

test("ApprovalCard: long arguments are collapsed with a count, not rendered whole", () => {
  const out = html(h(A.ApprovalCard, cardProps(bash("r3", Array.from({ length: 5000 }, (_, i) => `echo line ${i}`).join("\n")))));
  assert.ok(out.length < 12_000, `card markup ${out.length}`);
  assert.match(out, /Show all \(\d+ lines, \d+ characters\)/);
  assert.match(out, /aria-expanded="false"/);
});

test("ApprovalCard: confirming a saved rule shows the exact rule, scope and where to revoke it", () => {
  const a = bash("r1", "npm test", { suggestion: { scope: "project", toolName: "Bash", pattern: "npm test" } });
  const out = html(h(A.ApprovalCard, cardProps(a, { ui: { phase: "idle", error: null, shown: "d", confirmingRule: true } })));
  assert.match(out, /This will save a rule/);
  assert.match(out, /Bash: commands starting with &quot;npm test&quot;/);
  assert.match(out, /Only in \/p\. Other projects still ask/);
  assert.match(out, /Revoke it in Settings/);
  assert.match(out, /Save rule and allow/);
  assert.ok(!/>Allow once</.test(out), "the single-click choices are replaced by the confirmation");
});

test("ApprovalCard: session grant for edits is worded as this chat only", () => {
  const e = tool("r1", "Edit", { filePath: "/p/a.ts", oldString: "a", newString: "b" }, { suggestion: { scope: "session", toolName: "Edit" } });
  assert.match(html(h(A.ApprovalCard, cardProps(e))), />Allow all edits in this chat</);
});

test("ApprovalCard: closed turn, expired and failed states fail closed", () => {
  const a = bash("r1", "ls");
  const closed = html(h(A.ApprovalCard, cardProps(a, { turnClosed: true })));
  assert.ok(count(closed, /disabled=""/g) >= 3);
  assert.match(closed, /no longer be answered/);
  const expired = html(h(A.ApprovalCard, cardProps(a, { ui: { phase: "expired", error: "This request timed out on the core and can no longer be answered.", shown: "d", confirmingRule: false } })));
  assert.match(expired, /role="alert"/);
  assert.match(expired, /Expired/);
  const failed = html(h(A.ApprovalCard, cardProps(a, { ui: { phase: "failed", error: "Cannot confirm: offline. Nothing was allowed.", shown: "d", confirmingRule: false } })));
  assert.match(failed, /Nothing was allowed\. Choose again to retry/);
  assert.ok(!/disabled=""[^>]*>Allow once/.test(failed), "a failed submit stays retryable");
});

test("ApprovalCard: batch offer lists every file and names the count", () => {
  const edits = Array.from({ length: 4 }, (_, i) => tool(`e${i}`, "Edit", { filePath: `/p/f${i}.ts`, oldString: "a", newString: "b" }));
  const out = html(h(A.ApprovalCard, cardProps(edits[0], { batch: edits, total: 4 })));
  assert.match(out, /Review 4 similar edits together/);
});

test("QuestionCard: fieldsets, single vs multi inputs, secret note, escaped option text", () => {
  const q = { requestId: "q1", kind: "AskUserQuestion", questions: [...FX.approval_request_question.questions, { question: "Pick <b>many</b>", multiSelect: true, options: [{ label: "<script>x</script>" }] }] };
  const out = html(h(A.QuestionCard, { approval: q, ui: undefined, position: 1, total: 1, turnClosed: false, onAnswer: noop, onDecline: noop }));
  assert.match(out, /aria-label="The assistant has a question"/);
  assert.equal(count(out, /<fieldset/g), 2);
  assert.match(out, /type="radio"/);
  assert.match(out, /type="checkbox"/);
  assert.match(out, /sent to the model/);
  assert.ok(!out.includes("<script>") && !out.includes("<b>many"));
  assert.match(out, /Decline to answer/);
  assert.match(out, /Send answer/);
});

test("ApprovalsPanel: 500 queued approvals render one card, a bounded next list and a counter", () => {
  const pending = Array.from({ length: 500 }, (_, i) => tool(`e${i}`, "Edit", { filePath: `/p/f${i}.ts`, oldString: "x".repeat(3000), newString: "y".repeat(3000) }));
  const out = html(h(A.ApprovalsPanel, { state: { pendingApprovals: pending, phase: "streaming" }, projectRoot: "/p", decide: async () => ({ ok: true }) }));
  assert.equal(count(out, /class="appr-card"/g), 1);
  assert.ok(count(out, /<li class="chat-muted"/g) <= 6);
  assert.match(out, /500 waiting/);
  assert.match(out, /and 494 more/);
  assert.match(out, /role="region"[^>]*aria-label="Requests waiting for you"/);
  assert.match(out, /aria-live="polite"/);
  assert.ok(out.length < 40_000, `panel markup ${out.length}`);
});

test("ApprovalsPanel: nothing pending renders nothing; the S-L plan hook renders inside the region", () => {
  assert.equal(html(h(A.ApprovalsPanel, { state: { pendingApprovals: [], phase: "idle" }, projectRoot: "/p", decide: async () => ({ ok: true }) })), "");
  const withExtra = html(h(A.ApprovalsPanel, { state: { pendingApprovals: [], phase: "idle" }, projectRoot: "/p", decide: async () => ({ ok: true }), extra: h("p", null, "PLAN CARD") }));
  assert.match(withExtra, /PLAN CARD/);
});

test("ApprovalsPanel: a question at the head renders the question card", () => {
  const out = html(h(A.ApprovalsPanel, { state: { pendingApprovals: [{ requestId: "q", kind: "AskUserQuestion", questions: FX.approval_request_question.questions }], phase: "streaming" }, projectRoot: "/p", decide: async () => ({ ok: true }) }));
  assert.match(out, /The assistant has a question/);
});

const trust = (skipped) => ({ path: "/Users/me/proj", text: "n", skipped });
const sk = (kind, name) => ({ kind, name, file: ".mcp.json", withheld: true });

test("TrustBanner: wording per kind, the folder named, a button that only opens a confirmation", () => {
  const core = { json: async () => ({}) };
  assert.equal(html(h(A.TrustBanner, { trust: null, core, onTrusted: noop })), "");
  const out = html(h(A.TrustBanner, { trust: trust([sk("mcp-stdio", "fs"), sk("mcp-remote", "docs"), sk("mcp-uninspected", "x")]), core, onTrusted: noop }));
  assert.match(out, /proj is not a trusted folder/);
  assert.match(out, /runs a program on this computer: fs/);
  assert.match(out, /connects to a remote endpoint: docs/);
  assert.match(out, /could not be read, so what it starts is unknown/);
  assert.match(out, /aria-haspopup="dialog"[^>]*>Trust this folder/);
  assert.ok(!/alertdialog/.test(out), "closed by default: nothing is trusted by rendering");
  assert.match(html(h(A.TrustBanner, { trust: trust([{ kind: "mcp-stdio", name: "<img onerror=1>", file: "f", withheld: true }]), core, onTrusted: noop })), /&lt;img onerror=1&gt;/);
});

test("ModeBanner: Bypass is a persistent red header, Accept Edits is explained, Ask shows nothing", () => {
  assert.equal(html(h(A.ModeBanner, { mode: "ask" })), "");
  const b = html(h(A.ModeBanner, { mode: "bypass" }));
  assert.match(b, /data-mode="bypass"/);
  assert.match(b, /BYPASS ON/);
  assert.match(b, /without asking/);
  const e = html(h(A.ModeBanner, { mode: "accept-edits" }));
  assert.match(e, /file edits inside the project are applied without asking/);
  assert.match(e, /Commands, network access and extension tools still ask/);
});

test("approvals sources never use dangerouslySetInnerHTML or timers that could resolve a request", () => {
  const dir = join(CHAT, "approvals");
  for (const f of readdirSync(dir).filter((x) => /\.tsx?$/.test(x))) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(src), `${f} uses raw HTML`);
    // The one allowed timer only ARMS a card after its dwell (H1); it never allows, denies or expires a request.
    const stripped = f === "ApprovalCard.tsx" ? src.replace("setTimeout(() => setArmed(true), dwellMs)", "") : src;
    assert.ok(!/setTimeout|setInterval/.test(stripped), `${f} has a timer`);
  }
});
