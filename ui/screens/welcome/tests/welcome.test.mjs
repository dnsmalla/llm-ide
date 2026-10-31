import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const h = React.createElement;
const model = await load("../welcome/model.ts");
const { WelcomeScreen, GuideDialog } = await load("../welcome/WelcomeScreen.tsx");
const { NoProjectCard } = await load("NoProjectCard.tsx");
const html = (el) => renderToStaticMarkup(el);

const noop = async () => undefined;
const actions = (over = {}) => ({ createProject: async () => null, openFolder: noop, openRecent: noop, forgetRecent: noop, closeProject: noop, goHome() {}, ...over });
const entry = (o = {}) => ({ name: "alpha", root: "/Users/me/alpha", status: "ok", reason: null, openIndex: 0, storedIndex: 0, ...o });
const welcome = (o = {}) => html(h(WelcomeScreen, { project: null, recent: { entries: [], reset: false }, error: null, actions: actions(), ...o }));

test("name rules: one safe segment, the reason is plain text", () => {
  for (const [bad, re] of [["", /Enter a project name/], ["   ", /Enter/], ["a/b", /cannot contain/], ["a\\b", /cannot contain/], ["..", /dot/], [".hid", /dot/], ["x.", /dot/], ["a:b", /cannot contain/], ["a\nb", /cannot contain/], ["evil‮exe", /cannot contain/], ["CON", /reserved/], ["nul.txt", /reserved/], ["a".repeat(81), /at most 80/]]) {
    const r = model.validateProjectName(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, re, JSON.stringify(bad));
  }
  assert.deepEqual(model.validateProjectName("  My App 2 "), { ok: true, name: "My App 2" });
  assert.equal(model.validateProjectName("プロジェクト").ok, true);
  assert.equal(model.validateProjectName("a".repeat(80)).ok, true);
  assert.equal(model.validateProjectName("\u{1F600}".repeat(80)).ok, true, "length is counted in characters (the host also caps bytes)");
});

test("registerNewProject: registers with the Doc Gen id, installs skills, failures are warnings", async () => {
  const calls = [];
  const core = { request: async (path, opts) => { calls.push([path, opts.method, opts.body]); return path.includes("install") ? { ok: true } : { ok: true, id: "x" }; } };
  const warnings = await model.registerNewProject({ name: "p", root: "/r/p" }, { core, idFor: async (r) => `id-of-${r}` });
  assert.deepEqual(warnings, []);
  assert.deepEqual(calls, [
    ["/kb/projects/register", "POST", { id: "id-of-/r/p", root: "/r/p" }],
    ["/kb/project/install-skills", "POST", { path: "/r/p", language: "en" }],
  ]);
  // the real derivation is the Doc Gen one: the same root gives the same id in both places
  const { projectIdFor } = await load("../docgen/docs-api.ts");
  const real = [];
  await model.registerNewProject({ name: "p", root: "/r/p" }, { core: { request: async (_p, o) => (real.push(o.body), { ok: true }) } });
  assert.equal(real[0].id, await projectIdFor("/r/p"));
  assert.match(real[0].id, /^p[0-9a-f]{32}$/);

  const down = { request: async () => { throw Object.assign(new Error("Core is not reachable ‮"), { code: "NETWORK" }); } };
  const w = await model.registerNewProject({ name: "p", root: "/r/p" }, { core: down, idFor: async () => "i" });
  assert.equal(w.length, 2);
  assert.match(w[0], /could not be registered.*not reachable/);
  assert.match(w[1], /skills were not installed/);
  assert.ok(!w.join("").includes("‮"), "reasons are stripped of bidi characters");
  const declined = await model.registerNewProject({ name: "p", root: "/r" }, { core: { request: async (p) => (p.includes("install") ? { ok: false } : {}) }, idFor: async () => "i" });
  assert.equal(declined.length, 1);
  assert.match(declined[0], /declined/);
});

test("Welcome (no project): hero, both paths, explainer, empty recents, guide link", () => {
  const out = welcome();
  assert.match(out, /data-testid="welcome"/);
  assert.match(out, /<h1[^>]*>LLM-IDE<\/h1>/);
  assert.match(out, />New project<\/h2>/);
  assert.match(out, />Open existing project<\/h2>/);
  assert.match(out, /Choose location/);
  assert.match(out, /Open folder/);
  assert.match(out, /system\/ holds the data LLM-IDE manages and llm-doc\/ holds the notes/);
  assert.match(out, /No recent projects yet/);
  assert.match(out, /New here\? Open the guide/);
  assert.doesNotMatch(out, /data-testid="guide"/, "the guide is closed until asked for");
  assert.doesNotMatch(out, /Current project/);
  assert.doesNotMatch(out, /Delete|Remove project/i, "Welcome offers no destructive action");
});

test("Welcome recents: ok rows open, missing/refused rows are disabled with a reason, forget says it keeps files", () => {
  const out = welcome({
    recent: { reset: false, entries: [entry(), entry({ name: "gone", root: "/Volumes/x/gone", status: "missing", reason: "The volume is not mounted, or the folder was moved or deleted.", openIndex: null, storedIndex: 1 }), entry({ name: "broad", root: "/", status: "refused", reason: "This folder is too broad to open as a project.", openIndex: null, storedIndex: 2 })] },
  });
  assert.match(out, /data-status="ok"/);
  assert.equal((out.match(/class="wc-recent-open" disabled=""/g) ?? []).length, 2, "two rows cannot be opened");
  assert.match(out, /volume is not mounted/);
  assert.match(out, /too broad to open/);
  assert.equal((out.match(/Your files are not deleted/g) ?? []).length >= 3, true);
  assert.match(out, /aria-label="Remove alpha from the recent list\. Your files are not deleted\."/);
});

test("Welcome: untrusted names, paths and errors are text: tags escaped, bidi and control stripped, lengths capped", () => {
  const evil = '<img src=x onerror=alert(1)>‮\u0000' + "n".repeat(300);
  const out = welcome({
    project: { name: evil, root: "/p/" + evil },
    recent: { reset: false, entries: [entry({ name: evil, root: "/r/" + evil })] },
    error: '<script>alert(1)</script>‮',
  });
  assert.doesNotMatch(out, /<img|<script|‮|\u0000/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(out, /n{301}/, "long text is capped");
});

test("Welcome: reset notice (corrupt recents) with reassurance; current project block; error banner", () => {
  const out = welcome({ recent: { reset: true, entries: [] }, project: { name: "mine", root: "/p/mine" }, error: "Cannot open it" });
  assert.match(out, /data-kind="reset"/);
  assert.match(out, /recent-projects list was reset/);
  assert.match(out, /project folders are untouched/);
  assert.match(out, /Current project/);
  assert.match(out, /Continue/);
  assert.match(out, /Close project/);
  assert.match(out, /Nothing is deleted/);
  assert.match(out, /role="alert"[^>]*data-kind="error"|data-kind="error"[^>]*>.*Cannot open it/s);
  assert.doesNotMatch(welcome(), /was reset/);
});

test("Guide dialog: condensed Mac guide as plain text (capture, notes, projects), modal semantics", () => {
  const out = welcome({ guideOpen: true });
  assert.match(out, /role="dialog" aria-modal="true" aria-labelledby="wc-guide-title"/);
  for (const t of ["What LLM-IDE does", "Capture", "Notes and the Library", "Projects", "First steps"]) assert.match(out, new RegExp(t));
  assert.match(out, /system\/ holds the data LLM-IDE manages for itself/);
  assert.match(out, /never deletes anything on disk/);
  assert.equal(html(h(GuideDialog, { onClose() {} })).includes("Close"), true);
  for (const g of model.GUIDE) assert.ok(!/[<>]/.test(JSON.stringify(g)), "guide text has no markup");
});

test("NoProjectCard: one title, two buttons, text only", () => {
  const out = html(h(NoProjectCard, { what: "chat", actions: { newProject() {}, openProject() {} } }));
  assert.match(out, /data-testid="no-project"/);
  assert.match(out, /Open or create a project to chat/);
  assert.match(out, /New project…/);
  assert.match(out, /Open existing project…/);
  const evil = html(h(NoProjectCard, { what: "<b>x</b>‮", hint: "<i>h</i>", actions: { newProject() {}, openProject() {} } }));
  assert.doesNotMatch(evil, /<b>|<i>|‮/);
});
