// Review fixes with no coverage before: the memory viewer entry, the model picker's Default and restore, the trust
// banner's dismiss, the route re-read at turn end, the "asks for a plan" phrases and the composer key hint.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadChat, h, renderToStaticMarkup as html, fakeCore } from "./helpers.mjs";
import { loadMemory } from "../../explorer/memory/memory-model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(HERE, "..", ...p), "utf8");
const noop = () => {};

let c;
before(async () => { c = await loadChat("review-fixes"); });

// --- 1. the memory viewer entry point ---------------------------------------------------------------------

test("the chat's memory viewer goes through the core transport, and a body resolves as a 200", async () => {
  const core = fakeCore({ json: { "GET /kb/agent/session-memory": { facts: ["Decided on pnpm"] } } });
  const client = c.memoryClient(core);
  const reply = await client.request("GET", "/kb/agent/session-memory?sessionId=s1", undefined, undefined);
  assert.deepEqual(reply, { status: 200, body: { facts: ["Decided on pnpm"] } });
  assert.deepEqual(core.calls.map((x) => `${x.method} ${x.path}`), ["GET /kb/agent/session-memory?sessionId=s1"]);
});

test("a refused core call keeps rejecting, so the viewer shows its own load error", async () => {
  const core = fakeCore({});
  await assert.rejects(c.memoryClient(core).request("GET", "/kb/agent/project-memory?workspaceRoot=%2Fw", undefined, undefined));
});

test("the viewer loads project and session memory through the chat adapter (open folder, no repo candidates)", async () => {
  const core = fakeCore({ json: {
    "GET /kb/agent/project-memory": { facts: ["Uses pnpm (t:2026-10-01)"], repo: "/work/app" },
    "GET /kb/agent/session-memory": { facts: ["Decided on the importer"] },
  } });
  const out = await loadMemory(c.memoryClient(core), { repos: [], workspaceRoot: "/work/app", sessionId: "s1" });
  assert.deepEqual(out.project, { facts: ["Uses pnpm (t:2026-10-01)"], repo: "/work/app" });
  assert.deepEqual(out.session, ["Decided on the importer"]);
  assert.equal(out.projectFailed, false);
  assert.match(core.calls[0].path, /^\/kb\/agent\/project-memory\?workspaceRoot=%2Fwork%2Fapp$/);
});

test("the Memory popover offers the project memory viewer, and Chat adds no second prune control", () => {
  const screen = src("ChatScreen.tsx");
  assert.match(screen, /import \{ ProjectMemoryView \} from "\.\.\/explorer\/memory\/ProjectMemoryView"/);
  assert.match(screen, />Project memory<\/button>/, "the popover's button, worded as the Mac's Project memory");
  assert.match(screen, /<ProjectMemoryView client=\{memoryCore\} repos=\{\[\]\} workspaceRoot=\{host\.projectRoot\?\.\(\) \?\? null\} sessionId=\{activeId\}/);
  assert.ok(!/>\s*(Forget|Clear)|aria-label="(Forget|Clear)/.test(screen), "no Forget or Clear control in the chat");
});

// --- 2. the model picker: Default only unpins, and a refused save restores the previous choice ------------

test("Default on a pinned route only unpins it: the composer's model is left alone", () => {
  assert.deepEqual(c.modelPickPlan({ enabled: true, pinned: true }, "", ""), { composer: null, route: "unpin" });
  assert.deepEqual(c.modelPickPlan({ enabled: true, pinned: false }, "", ""), { composer: null, route: null }, "nothing pinned: nothing to unpin");
  assert.deepEqual(c.modelPickPlan({ enabled: false, pinned: true }, "", ""), { composer: { provider: "", model: "" }, route: null }, "router off: Default is the core's default for the composer, never a dead option");
  assert.deepEqual(c.modelPickPlan(null, "", ""), { composer: { provider: "", model: "" }, route: null }, "no route loaded");
});

test("a model pick sets the composer's model, and pins the route only when the router is on", () => {
  assert.deepEqual(c.modelPickPlan({ enabled: true, pinned: false }, "anthropic", "claude-x"), { composer: { provider: "anthropic", model: "claude-x" }, route: "pin" });
  assert.deepEqual(c.modelPickPlan({ enabled: false, pinned: false }, "anthropic", "claude-x"), { composer: { provider: "anthropic", model: "claude-x" }, route: null });
});

test("Default leaves the chat's remembered composer choice as it was", () => {
  const prefs = { c1: { mode: "execute", provider: "anthropic", model: "claude-x" } };
  const plan = c.modelPickPlan({ enabled: true, pinned: true }, "", "");
  const after = plan.composer ? c.patchChatPrefs(prefs, "c1", plan.composer) : prefs;
  assert.deepEqual(after.c1, { mode: "execute", provider: "anthropic", model: "claude-x" });
});

test("a refused pin puts the picker back to the previous choice, and keeps the chat's mode", () => {
  const prefs = { c1: { mode: "ask", provider: "anthropic", model: "claude-a" } };
  const prev = { provider: "anthropic", model: "claude-a" };
  const plan = c.modelPickPlan({ enabled: true, pinned: false }, "anthropic", "claude-b");
  const applied = c.patchChatPrefs(prefs, "c1", plan.composer);
  assert.equal(applied.c1.model, "claude-b", "the pick shows while the save is in flight");
  const restored = c.patchChatPrefs(applied, "c1", prev);
  assert.deepEqual(restored.c1, { mode: "ask", provider: "anthropic", model: "claude-a" });
});

test("a restore for a chat with no remembered choice changes nothing", () => {
  const prefs = {};
  assert.equal(c.patchChatPrefs(prefs, "c9", { provider: "a", model: "b" }), prefs);
});

test("ChatScreen restores the previous choice on a failed pin and leaves Default's composer state alone", () => {
  const screen = src("ChatScreen.tsx");
  assert.match(screen, /const restore = \(\) => setPrefs\(\(p\) => restoreFailedPick\(p, chat, \{ provider, model \}, prev\)\);/);
  assert.match(screen, /if \(plan\.route === "pin"\) putRoute\(core, chat, \{ provider, model \}\)\.then\(setRoute\)\.catch\(restore\);/);
  assert.match(screen, /if \(plan\.composer\) setCurrent\(/);
});

// --- 3. the trust banner's dismiss and the route re-read ----------------------------------------------------

const notice = (path, extra = {}) => ({ path, skipped: [], withheld: true, state: "untrusted", ...extra });

test("dismissing the trust notice hides that notice only: a new notice of the same folder shows again", () => {
  const first = notice("/work/app");
  const again = notice("/work/app");
  assert.equal(c.approvals.trust.shownTrustNotice(first, null), first, "shown before a dismiss");
  assert.equal(c.approvals.trust.shownTrustNotice(first, first), null, "the dismissed notice is hidden");
  assert.equal(c.approvals.trust.shownTrustNotice(again, first), again, "a later turn's notice is a new object and shows");
});

test("a dismissal does not hide another folder's notice, and no notice shows nothing", () => {
  const app = notice("/work/app");
  const other = notice("/work/other");
  assert.equal(c.approvals.trust.shownTrustNotice(other, app), other);
  assert.equal(c.approvals.trust.shownTrustNotice(null, app), null);
  assert.equal(c.approvals.trust.shownTrustNotice(null, null), null);
});

test("the trust banner's dismiss stores only the notice it shows, and renders through the helper", () => {
  const banner = src("approvals", "TrustBanner.tsx");
  assert.match(banner, /if \(!trust \|\| shownTrustNotice\(trust, dismissed\) === null\) return null;/);
  assert.match(banner, /setDismissed\(trust\)/);
});

test("the route is re-read only when a turn ends on a chat with the router on", () => {
  assert.equal(c.routeRereadDue(true, false, "c1", true), true, "a turn ended");
  assert.equal(c.routeRereadDue(false, false, "c1", true), false, "idle before and after");
  assert.equal(c.routeRereadDue(false, true, "c1", true), false, "a turn started");
  assert.equal(c.routeRereadDue(true, true, "c1", true), false, "still running");
  assert.equal(c.routeRereadDue(true, false, null, true), false, "no chat open");
  assert.equal(c.routeRereadDue(true, false, "c1", false), false, "router off");
  assert.equal(c.routeRereadDue(true, false, "c1", undefined), false, "route not loaded");
});

test("ChatScreen re-reads the route through routeRereadDue at the end of a turn", () => {
  assert.match(src("ChatScreen.tsx"), /const due = routeRereadDue\(wasBusy\.current, busy, activeId, route\?\.enabled\);/);
});

// --- 4. deliberate breaks: a missing "asks for a plan" phrase and the composer key hint ---------------------

// Every phrase of the Mac's PlanRequestPolicy as the desktop carries it: each must be recognised on its own.
const ASK_PHRASES = [
  "want a plan", "need a plan", "give me a plan",
  "make a plan", "make me a plan", "create a plan", "write a plan",
  "write me a plan", "draft a plan", "prepare a plan", "build a plan",
  "come up with a plan", "put together a plan", "propose a plan",
  "plan this out", "let's plan", "lets plan",
  "プランを作", "プラン作", "計画を作", "計画作",
  "計画を立て", "計画立て", "プランを立て", "プラン立て",
  "プランが欲し", "プランがほし", "計画が欲し", "計画がほし",
  "プランを書", "計画を書", "プランをお願い", "計画をお願い",
];

test("each 'asks for a plan' phrase on its own marks the draft as asking for a plan", () => {
  for (const p of ASK_PHRASES) assert.equal(c.asksForPlan(`please ${p} soon`), true, `missing phrase: ${p}`);
});

test("the composer renders the key hint (Return sends, Shift+Return is a new line) in its bar", () => {
  const out = html(h(c.Composer, { draft: "hi", onDraft: noop, busy: false, aborting: false, queue: [], history: [], onSend: noop, onStop: noop, onDropQueued: noop }));
  assert.match(out, /aria-label="↵ sends · ⇧↵ for a new line"/, "the hint is in the rendered composer");
  assert.match(out, /title="↵ sends · ⇧↵ for a new line"/);
  assert.match(src("Composer.tsx"), /<KeyHint \/>/);
});

// --- 5. reviewer fixes: the picker shows an unpinned chat, a late failure never overwrites a newer pick, the memory
// entry is reachable before the first turn and hands focus back on close ------------------------------------------

const GROUPS = [{ id: "anthropic", label: "Claude", catalog: false, models: [{ provider: "anthropic", model: "claude-a", label: "Claude A" }, { provider: "anthropic", model: "claude-b", label: "Claude B" }] }];
const picker = (props) => html(h(c.ModelPicker, { groups: GROUPS, provider: "anthropic", model: "claude-a", onChange: noop, ...props }));
const selected = (out) => /<option value="([^"]*)" selected="">([^<]*)</.exec(out)?.slice(1, 3) ?? null;

test("after an unpin the picker shows the Mac's 'Not pinned (the composer's model)', naming the composer's model", () => {
  const out = picker({ route: { enabled: true, pinned: false } });
  assert.deepEqual(selected(out), ["", "Not pinned (the composer&#x27;s model: Claude A)"]);
});

test("a pinned chat shows its pinned model, a pending switch shows what runs next, and the router off keeps 'Default'", () => {
  assert.deepEqual(selected(picker({ route: { enabled: true, pinned: true, provider: "anthropic", model: "claude-b" } })), ["anthropic|claude-b", "Claude B"]);
  assert.deepEqual(selected(picker({ route: { enabled: true, pinned: true, provider: "anthropic", model: "claude-b", pending: { provider: "", model: "" } } }))?.[0], "", "a pending unpin shows Not pinned");
  assert.deepEqual(selected(picker({ route: { enabled: false, pinned: false } })), ["anthropic|claude-a", "Claude A"]);
  assert.match(picker({ route: null, provider: null, model: null }), /<option value="" selected="">Default<\/option>/);
});

test("a pinned model missing from the lists still shows as chosen, under Current", () => {
  const out = picker({ route: { enabled: true, pinned: true, provider: "anthropic", model: "claude-retired" } });
  assert.match(out, /<optgroup label="Current \(not in the provider list\)"><option value="anthropic\|claude-retired" selected="">Claude · claude-retired<\/option>/);
  assert.match(out, /not in the provider’s current model list/);
});

test("a late refusal does not overwrite a pick made while the save was in flight", () => {
  const prefs = { c1: { mode: "ask", provider: "anthropic", model: "claude-c" } };
  assert.equal(c.restoreFailedPick(prefs, "c1", { provider: "anthropic", model: "claude-b" }, { provider: "anthropic", model: "claude-a" }), prefs);
  const restored = c.restoreFailedPick(prefs, "c1", { provider: "anthropic", model: "claude-c" }, { provider: "anthropic", model: "claude-b" });
  assert.deepEqual(restored.c1, { mode: "ask", provider: "anthropic", model: "claude-b" });
  assert.equal(c.restoreFailedPick({}, "c1", { provider: "a", model: "b" }, { provider: null, model: null }).c1, undefined);
});

test("the Memory chip is always rendered (not only after a turn), and closing the viewer focuses it again", () => {
  const screen = src("ChatScreen.tsx");
  assert.ok(!/\{state\.memory \? \(\s*<div className="chat-context">/.test(screen), "the chip is not gated on a turn's memory report");
  assert.match(screen, /<button ref=\{memoryChip\}/);
  assert.match(screen, /const closeProjectMemory = useCallback\(\(\) => \{ setProjectMemoryOpen\(false\); memoryChip\.current\?\.focus\(\); \}, \[\]\);/);
  assert.match(screen, /onClose=\{closeProjectMemory\}/);
  assert.match(screen, /if \(e\.key === "Escape"\) \{ e\.stopPropagation\(\); closeProjectMemory\(\); \}/);
  assert.match(screen, /<ModelPicker [^>]*route=\{route\}/);
});


test("the plain-chat notice offers the Mac's one-click Allow tools, with Settings as the fallback", async () => {
  const notices = src("model-notices.tsx");
  assert.match(notices, /label: "Allow tools"/);
  assert.match(notices, /onAllowTools \? onAllowTools\(\) : openModelRouting\(\)/);
  const screen = src("ChatScreen.tsx");
  assert.match(screen, /enableProviderTools\(core\)/);
  assert.match(screen, /<ModelNotices [^>]*onAllowTools=/);
});
