// Batch A of the Chat parity triage (chat-triage.md): pure UI copy and small states, each pinned to the Mac's wording.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
const noop = () => {};
before(async () => { c = await loadChat("parity-batch-a"); });

test("cap popover explains what the meter counts, as the Mac's \"Counted:\" sentence does", () => {
  assert.equal(c.CAP_COUNTED_NOTE, "Counted: input + output + cache writes. Cached reads are shown, not counted.");
  const out = html(h(c.CapNotes, { used: 1200 }));
  assert.match(out, /Billable tokens used: 1\.2k\./);
  assert.match(out, /Counted: input \+ output \+ cache writes\. Cached reads are shown, not counted\./);
  assert.match(out, /The limit is approximate to one reply\./);
});

test("a saved limit with the cap switch off shows the not-enforced warning; no limit or an enforced cap does not", () => {
  const off = html(h(c.CapNotes, { used: 0, tokenLimit: 200000, capEnforced: false }));
  assert.match(off, /The limit is saved but not enforced: the server runs without the cap switch\./);
  assert.match(off, /role="note"/);
  assert.doesNotMatch(html(h(c.CapNotes, { used: 0, tokenLimit: null, capEnforced: false })), /not enforced/);
  assert.doesNotMatch(html(h(c.CapNotes, { used: 0, tokenLimit: 200000, capEnforced: true })), /not enforced/);
  assert.doesNotMatch(html(h(c.CapNotes, { used: 0, tokenLimit: 200000 })), /not enforced/, "an absent flag is not a warning");
});

test("a switch saved during a turn shows \"Applies to your next message: X\" until it applies", () => {
  assert.match(html(h(c.PendingSwitchNote, { pending: { model: "claude-opus-4" } })), /Applies to your next message: claude-opus-4/);
  assert.equal(html(h(c.PendingSwitchNote, { pending: null })), "");
  assert.equal(html(h(c.PendingSwitchNote, { pending: undefined })), "");
  assert.match(html(h(c.PendingSwitchNote, { pending: { provider: "", model: "" } })), /Applies to your next message: Not pinned/, "a pending unpin");
});

test("choosing \"Default\" in the model picker reports an empty pick (the unpin), and a model reports its pair", () => {
  const calls = [];
  const tree = c.ModelPicker({ groups: [{ id: "anthropic", label: "Claude", catalog: false, models: [{ provider: "anthropic", model: "m1", label: "M1" }] }],
    provider: "anthropic", model: "m1", onChange: (p, m) => calls.push([p, m]) });
  const select = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "select") return node;
    const kids = [].concat(node.props?.children ?? []);
    for (const k of kids) { const f = select(k); if (f) return f; }
    return null;
  };
  const sel = select(tree);
  assert.ok(sel, "the model select is rendered");
  sel.props.onChange({ target: { value: "" } });
  sel.props.onChange({ target: { value: "anthropic|m1" } });
  assert.deepEqual(calls, [["", ""], ["anthropic", "m1"]]);
});

test("delete-chat confirmation uses the Mac's title and sentence in both the dock and the session list", async () => {
  assert.equal(c.DELETE_CHAT_TITLE, "Delete this chat?");
  assert.equal(c.DELETE_CHAT_DETAIL, "The conversation and its memory are removed. This cannot be undone.");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(import.meta.dirname, "..");
  for (const f of ["DockHeader.tsx"]) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.match(src, /DELETE_CHAT_DETAIL/, `${f} shows the detail sentence`);
    assert.match(src, /DELETE_CHAT_TITLE/, `${f} shows the title`);
  }
});

test("the composer shows the Mac's send-key glyph with its tooltip: Return sends, Shift+Return is a new line", () => {
  assert.equal(c.KEY_HINT, "↵ sends · ⇧↵ for a new line");
  const out = html(h(c.KeyHint));
  assert.match(out, /title="↵ sends/);
  assert.match(out, />↵</);
});

test("the provider-blocked notice shows only for a provider no loaded group can chat with", () => {
  const groups = [
    { id: "anthropic", label: "Claude", catalog: false, models: [{ provider: "anthropic", model: "m1", label: "M1" }] },
    { id: "c1", label: "Catalog", catalog: true, models: [{ provider: "custom:cat-1", model: "x", label: "x" }] },
    { id: "c2", label: "Broken", catalog: true, models: [], note: "Could not list models." },
  ];
  assert.equal(c.providerCannotChat(null, groups), false, "no pick");
  assert.equal(c.providerCannotChat("", groups), false, "unpinned");
  assert.equal(c.providerCannotChat("anthropic", groups), false, "Claude always runs");
  assert.equal(c.providerCannotChat("custom:cat-1", groups), false, "a listed catalog provider runs");
  assert.equal(c.providerCannotChat("openai", groups), false, "a group that failed to list its models counts as offered, so an outage is not reported as blocked");
  assert.equal(c.providerCannotChat("openai", groups.slice(0, 2)), true, "a provider no loaded group offers is blocked");
  assert.match(c.PROVIDER_BLOCKED_NOTE, /This provider cannot run a chat any more: pick another model, or connect it in Settings, Providers\.$/);
});

test("a planning request sent outside a plan mode offers the switch; Auto, the plan modes and a bare mention do not", () => {
  assert.equal(c.offersPlanSwitch("write me a plan for the importer", "execute"), true);
  assert.equal(c.offersPlanSwitch("Give me a plan", "ask"), true, "matched case-insensitively");
  assert.equal(c.offersPlanSwitch("write me a plan", "auto"), false, "Auto re-classifies by itself");
  assert.equal(c.offersPlanSwitch("write me a plan", "plan"), false, "already planning");
  assert.equal(c.offersPlanSwitch("write me a plan", "assist_plan"), false, "already planning");
  assert.equal(c.offersPlanSwitch("execute the plan", "execute"), false, "no explicit ask");
  assert.equal(c.offersPlanSwitch("I plan to refactor this", "execute"), false, "no explicit ask");
  assert.equal(c.offersPlanSwitch("プランを作って", "execute"), true, "Japanese ask");
  assert.equal(c.offersPlanSwitch("", "execute"), false, "empty draft");
  assert.equal(c.offersPlanSwitch("write me a plan", ""), false, "an unset mode is Auto");
});

test("the plan-mode notice names the mode, offers Switch to Plan and a Keep button, and stays hidden when it does not apply", () => {
  const out = html(h(c.PlanSwitchNotice, { draft: "write me a plan", mode: "execute", onSwitch: noop }));
  assert.match(out, /This reads as a planning request, but the mode is Execute\./);
  assert.match(out, />Switch to Plan</);
  assert.match(out, />Keep Execute</);
  assert.equal(html(h(c.PlanSwitchNotice, { draft: "hello", mode: "execute", onSwitch: noop })), "");
  assert.equal(html(h(c.PlanSwitchNotice, { draft: "write me a plan", mode: "plan", onSwitch: noop })), "");
});

test("an older reply folds to a one-line preview with Show full reply; the expanded one offers Collapse", () => {
  const long = "## Plan\n\nSee [the **notes**](https://example.test) and `run` the job. " + "x".repeat(200);
  const m = { role: "assistant", id: "a1", status: "done", notices: [], parts: [c.appendText(c.emptyText(), long)] };
  const calls = [];
  const onToggle = (id, on) => calls.push([id, on]);
  const folded = html(h(c.MessageView, { m, host: {}, collapsed: true, collapsible: true, onToggle }));
  assert.match(folded, /aria-label="Show full reply"/);
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /Plan See the notes and run the job/, "links become text and marks are dropped");
  assert.match(folded, /…/, "cut at the preview limit");
  assert.ok(!folded.includes("<h2"), "no full render while folded");
  assert.ok(!folded.includes(">Collapse<"));
  const open = html(h(c.MessageView, { m, host: {}, collapsible: true, onToggle }));
  assert.match(open, />Collapse</);
  assert.match(open, /aria-expanded="true"/);
  assert.ok(!open.includes("Show full reply"));
  assert.ok(!html(h(c.MessageView, { m, host: {}, onToggle })).includes(">Collapse<"), "the latest reply has no Collapse");
});

test("folding keeps tool steps, notices and the stopped status visible, and never folds a reply with no text", () => {
  const tool = { kind: "tool", index: 0, id: "t1", name: "Read", args: "{}", argsTruncated: false, result: { text: "ok", isError: false } };
  const m = { role: "assistant", id: "a1", status: "aborted", parts: [tool, c.appendText(c.emptyText(), "some reply text")],
    notices: [{ kind: "x", level: "warning", text: "Heads up", count: 1, visible: true }] };
  const folded = html(h(c.MessageView, { m, host: {}, collapsed: true, collapsible: true, onToggle: noop }));
  assert.match(folded, /Show full reply/);
  assert.match(folded, />Read</, "the tool card stays");
  assert.match(folded, /Heads up/, "the notice stays");
  assert.match(folded, /Stopped\./, "the status stays");
  const toolOnly = { ...m, status: "done", notices: [], parts: [tool] };
  const out = html(h(c.MessageView, { m: toolOnly, host: {}, collapsed: true, collapsible: true, onToggle: noop }));
  assert.ok(!out.includes("Show full reply"), "nothing to preview: shown as is");
  assert.match(out, />Read</);
});

test("Copy copies the whole reply, including the unfinished last line", () => {
  const copied = [];
  const m = { role: "assistant", id: "a1", status: "done", notices: [], parts: [c.appendText(c.emptyText(), "first line\nlast line no newline")] };
  const tree = c.MessageView.type({ m, host: { onCopy: (t) => copied.push(t) } });
  const find = (node) => {
    if (!node || typeof node !== "object") return null;
    if (typeof node.type === "function" && !node.props?.["aria-label"]) { const r = find(node.type(node.props)); if (r) return r; }
    if (node.props?.["aria-label"] === "Copy the reply") return node;
    for (const k of [].concat(node.props?.children ?? [])) { const f = find(k); if (f) return f; }
    return null;
  };
  find(tree).props.onClick();
  assert.deepEqual(copied, ["first line\nlast line no newline"]);
});

test("replyPreview is plain text capped at 160 characters, the Mac's limit", () => {
  assert.equal(c.replyPreview("a".repeat(160)).length, 160);
  assert.equal(c.replyPreview("a".repeat(161)), "a".repeat(160) + "…");
  assert.equal(c.replyPreview("<b>hi</b>"), "<b>hi</b>".replace(/[`#*_>~]/g, ""), "markup stays text, only the structural marks go");
});

test("the list folds every assistant reply except the latest by default", () => {
  const reply = (id, text) => ({ role: "assistant", id, status: "done", notices: [], parts: [c.appendText(c.emptyText(), text)] });
  const messages = [reply("a1", "first reply body"), { role: "user", id: "u2", text: "again" }, reply("a3", "second reply body")];
  const out = html(h(c.MessageList, { messages, hasMoreOlder: false, onLoadOlder: async () => 0, initialScrollTop: null, onScrollState: noop }));
  assert.equal(out.split('aria-label="Show full reply"').length - 1, 1, "only the older reply is folded");
  assert.match(out, /second reply body/, "the latest reply is shown in full");
});

test("the plan editor opens on Preview, as the Mac's sheet does: rendered plan, no textarea, Markdown is the other choice", () => {
  const out = html(h(c.PlanEditBody, { body: "## Steps\n\n1. one", onBody: noop }));
  assert.match(out, /aria-label="Plan preview"/);
  assert.match(out, /<h2/);
  assert.ok(!out.includes("<textarea"), "the editable text is behind the Markdown choice");
  assert.match(out, /aria-pressed="true"[^>]*>Preview</);
  assert.match(out, /aria-pressed="false"[^>]*>Markdown</);
});

test("plan progress counts completed and skipped steps and names the current step, as the Mac's card does", () => {
  assert.deepEqual(c.planProgress([]), { total: 0, done: 0, current: 0, percent: 0 });
  assert.deepEqual(c.planProgress([{ status: "completed" }, { status: "in_progress" }, { status: "pending" }, { status: "pending" }]),
    { total: 4, done: 1, current: 2, percent: 25 });
  assert.deepEqual(c.planProgress([{ status: "completed" }, { status: "skipped" }, { status: "completed" }]),
    { total: 3, done: 3, current: 3, percent: 100 });
  assert.equal(c.planProgress([{ status: "pending" }, { status: "pending" }, { status: "pending" }]).percent, 0);
});

test("plan progress shows only during a plan run of this chat, never for an ordinary task list (the Mac's tracker)", () => {
  const tasks = [{ status: "in_progress" }];
  assert.equal(c.showsPlanProgress(null, "c1", tasks), false, "no plan run: an ordinary task list");
  assert.equal(c.showsPlanProgress("c2", "c1", tasks), false, "another chat's plan run");
  assert.equal(c.showsPlanProgress("c1", "c1", []), false, "no tasks yet");
  assert.equal(c.showsPlanProgress("c1", "c1", tasks), true);
});

test("a saved plan offers an Open control that opens its project file, hidden while the plan executes (the Mac's PlanSavedCard)", () => {
  const card = { kind: "plan", title: "Dark mode", content: "## Steps\n\n1. one\n2. two", steps: ["one", "two"] };
  const base = { card, state: { save: { status: "saved", path: "llm-doc/plans/dark.md" }, executed: false, edited: null }, canSave: true, onSave: noop, onExecute: noop, onRefine: noop, onOpenFile: noop };
  const out = html(h(c.PlanCardView, base));
  assert.match(out, /aria-label="Open the saved plan file"/);
  assert.match(out, /Saved to llm-doc\/plans\/dark\.md/);
  assert.ok(!html(h(c.PlanCardView, { ...base, onOpenFile: undefined })).includes("Open the saved plan file"), "no control without a host");
  assert.ok(!html(h(c.PlanCardView, { ...base, state: { ...base.state, executed: true } })).includes("Open the saved plan file"), "hidden while executing");
  assert.ok(!html(h(c.PlanCardView, { ...base, state: { ...base.state, save: { status: "idle" } } })).includes("Open the saved plan file"), "nothing saved yet");
});

test("the folder trust notice offers a session dismiss next to the unchanged trust control", () => {
  const trust = { path: "/work/app", skipped: [], withheld: true, state: "untrusted" };
  const out = html(h(c.approvals.TrustBanner, { trust, core: { json: async () => ({}) }, onTrusted: noop }));
  assert.match(out, /aria-label="Dismiss folder trust notice"/);
  assert.match(out, /Trust this folder/);
  assert.equal(html(h(c.approvals.TrustBanner, { trust: null, core: { json: async () => ({}) }, onTrusted: noop })), "");
});
