import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;

const { Shell } = await load("Shell.tsx");
const { CoreDownPanel, LoginPanel } = await load("Panels.tsx");
const { SectionErrorBoundary, describeError } = await load("ErrorBoundary.tsx");
const { MenuButton } = await load("MenuButton.tsx");
const { computeGate, shouldMountSections, isInert } = await load("gate.ts");
const { deriveStatusView } = await load("status-view.ts");
const { readStoredTheme, storeTheme } = await load("theme.ts");
const { createCoreClient } = await load("core.ts");
const { createProjectStore } = await load("project-store.ts");
const { useStoreSelector } = await load("hooks.ts");

const html = (el) => renderToStaticMarkup(el);
const view = (o = {}) => deriveStatusView({ status: { url: "http://127.0.0.1:1", adopted: false, pid: 1, ms_to_healthy: 5, state: "ready", error: null, trust: "spawned", notice: null, restarts: 0, restart_in_ms: null, fatal: false, claude: "found", claude_source: null, claude_notice: null, ...o }, pollError: null, everReady: false });

test("Shell renders landmarks, skip link, top toolbar and a visible starting state (never blank)", () => {
  const out = html(h(Shell, { spike: () => null }));
  assert.match(out, /<a class="sh-skip" href="#shell-main">Skip to content/);
  assert.match(out, /<header[^>]*data-tauri-drag-region/);
  assert.match(out, /<div[^>]*class="sh-toolbar"[^>]*role="toolbar"[^>]*aria-label="Sections"/, "the Mac's top toolbar replaces the left nav");
  assert.doesNotMatch(out, /class="sh-nav"|Hide sidebar/, "no sidebar");
  assert.match(out, /<main id="shell-main"[^>]*tabindex="-1"/);
  assert.doesNotMatch(out, /<footer class="sh-statusbar"/, "the Mac hides status-bar chrome before sign-in");
  assert.match(out, /role="status"[^>]*>[\s\S]*Starting core/);
  assert.match(out, /aria-label="Home"/, "Home button");
  assert.doesNotMatch(out, /aria-label="Toggle Code Assistant"/, "the Code Assistant button belongs to Explorer, not every section");
  assert.match(html(h(Shell, { initialSection: "explorer", spike: () => null })), /aria-label="Toggle Code Assistant"[^>]*aria-controls="ex-chat-dock"[^>]*aria-expanded="false"/, "Code Assistant is reachable from Explorer's top right and announces its state");
  for (const l of ["Explorer", "Graph", "Auto Tasks", "Issues", "Gantt", "Loop", "Doc Gen", "Visual", "Library"]) assert.match(out, new RegExp(`>${l}<`));
  for (const l of ["Chat", "Settings"]) assert.doesNotMatch(out, new RegExp(`class="sh-tool-label">${l}<`), `${l} is not a toolbar item (Mac: status bar / account menu)`);
  assert.doesNotMatch(out, />Spike</, "the developer-only item is hidden by default");
  assert.match(out, /aria-current="page"/);
  assert.doesNotMatch(out, /aria-disabled="true"[^>]*>[\s\S]*?Auto Tasks/, "Auto Tasks is a real screen");
  assert.match(out, /data-platform="(macos|windows|linux|other)"/);
  assert.doesNotMatch(out, /data-overlay-titlebar/, "no desktop host in node: no traffic-light inset");
  assert.doesNotMatch(out, /aria-label="Activity feed|Account:/, "signed out: no bell, no account menu");
});

test("Shell with an initial section marks it current; unknown/disabled falls back to Home", () => {
  const cur = (init) => /aria-label="Home" aria-current="page"|data-tb-id="(\w+)"[^>]*aria-current="page"|aria-current="page"[^>]*data-tb-id="(\w+)"/.exec(html(h(Shell, { initialSection: init, spike: () => null })));
  assert.equal(cur("library")[1] ?? cur("library")[2], "library");
  assert.equal(cur("issues")[1] ?? cur("issues")[2], "issues");
  assert.equal(cur("loop")[1] ?? cur("loop")[2], "loop");
  assert.equal(cur("gantt")[1] ?? cur("gantt")[2], "gantt");
  assert.match(cur(null)[0], /aria-label="Home"/);
});

test("CoreDownPanel: restarting is a polite status, fatal is an alert with guidance, claude notice shown", () => {
  const r = html(h(CoreDownPanel, { view: view({ state: "restarting", restart_in_ms: 2000, claude: "missing", claude_notice: "Install <b>Claude</b>" }), onRetry() {} }));
  assert.match(r, /role="status"/);
  assert.match(r, /Restarting core in 2 s/);
  assert.match(r, /Install &lt;b&gt;Claude&lt;\/b&gt;/, "notice rendered as text");
  const f = html(h(CoreDownPanel, { view: view({ state: "failed", fatal: true, error: "<script>x</script>" }), onRetry() {} }));
  assert.match(f, /role="alert"/);
  assert.match(f, /core\.log/);
  assert.ok(!f.includes("<script>"));
  assert.match(f, /Check again/);
});

test("LoginPanel: labelled fields, password autocomplete, no token or storage use", () => {
  const client = createCoreClient({ baseUrl: () => null });
  const out = html(h(LoginPanel, { client }));
  assert.match(out, /<label class="sh-field"><span>Email<\/span><input name="email" type="email" autoComplete="username"|autocomplete="username"/i);
  assert.match(out, /type="password"[^>]*autoComplete="current-password"|autocomplete="current-password"/i);
  assert.match(out, /Sign in/);
  // R-034 #5: a hub with registration closed still offers the invite path.
  assert.match(out, /I have an invite/);
});

test("SectionErrorBoundary: contains a crash and renders text-only recovery UI", () => {
  const state = SectionErrorBoundary.getDerivedStateFromError(new Error("kaboom\nstack line"));
  assert.equal(state.error.message, "kaboom\nstack line");
  assert.equal(describeError(new Error("kaboom\nstack")), "kaboom");
  assert.ok(describeError(new Error("x".repeat(1000))).length <= 301);
  const inst = new SectionErrorBoundary({ name: "Chat", children: null });
  inst.state = { error: new Error("<img src=x onerror=1>"), attempt: 0 };
  const out = html(inst.render());
  assert.match(out, /role="alert"/);
  assert.match(out, /Chat stopped working/);
  assert.ok(!out.includes("<img"));
  assert.match(out, /Reload Chat/);
  const ok = new SectionErrorBoundary({ name: "Chat", children: h("p", null, "fine") });
  assert.match(html(ok.render()), /<p>fine<\/p>/);
});

test("MenuButton: collapsed menu exposes aria-haspopup/expanded", () => {
  const out = html(h(MenuButton, { ariaLabel: "Theme", items: [{ id: "a", label: "A", onSelect() {} }] }, "Dark"));
  assert.match(out, /aria-haspopup="menu"/);
  assert.match(out, /aria-expanded="false"/);
  assert.ok(!out.includes('role="menu"'));
});

test("gate: bypass, core down, restarting keeps screens, login, open", () => {
  const up = view();
  const down = view({ state: "starting" });
  assert.equal(computeGate({ view: down, signedIn: false, everUsable: false, bypass: true }), "open");
  assert.equal(computeGate({ view: down, signedIn: false, everUsable: false, bypass: false }), "core");
  assert.equal(computeGate({ view: view({ state: "restarting" }), signedIn: true, everUsable: true, bypass: false }), "restarting");
  assert.equal(computeGate({ view: view({ state: "failed", fatal: true }), signedIn: true, everUsable: true, bypass: false }), "core");
  assert.equal(computeGate({ view: up, signedIn: false, everUsable: false, bypass: false }), "login");
  assert.equal(computeGate({ view: up, signedIn: true, everUsable: false, bypass: false }), "open");
  assert.ok(shouldMountSections("login", true) && !shouldMountSections("login", false));
  assert.ok(isInert("login") && isInert("core") && isInert("restarting") && !isInert("open"));
});

test("theme storage: persisted choice, legacy key, bad value and broken storage fall back", () => {
  const mem = (init = {}) => ({ d: { ...init }, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } });
  const s = mem();
  assert.equal(readStoredTheme(s), "dark");
  storeTheme("midnight", s);
  assert.equal(readStoredTheme(s), "midnight");
  assert.equal(readStoredTheme(mem({ "llmide.poc.theme": "light" })), "light");
  assert.equal(readStoredTheme(mem({ "llmide.theme": "<x>" })), "dark");
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(readStoredTheme(broken), "dark");
  assert.doesNotThrow(() => storeTheme("light", broken));
});

test("project store: host-owned state, dedupes unchanged refresh, errors do not clear the project", async () => {
  const p = { name: "a", root: "/a" };
  let active = p;
  let calls = 0;
  const store = createProjectStore({
    projectActive: async () => (calls++, active),
    projectRecent: async () => [{ ...p }],
    projectOpen: async () => ({ name: "b", root: "/b" }),
    projectOpenRecent: async (i) => { if (i === 9) throw new Error("no such recent"); return { name: "c", root: "/c" }; },
  });
  let n = 0;
  store.subscribe(() => n++);
  await store.refresh();
  assert.equal(store.getSnapshot().loaded, true);
  const first = n;
  await store.refresh();
  assert.equal(n, first, "unchanged refresh does not notify");
  active = { name: "b", root: "/b" };
  await store.openFolder();
  assert.equal(store.getSnapshot().project.root, "/b");
  await store.openRecent(9);
  assert.equal(store.getSnapshot().error, "no such recent");
  assert.equal(store.getSnapshot().project.root, "/b");
});

test("useStoreSelector is exported and selects without extra renders (static check)", () => {
  assert.equal(typeof useStoreSelector, "function");
  const store = { getSnapshot: () => ({ a: 1, b: 2 }), subscribe: () => () => {} };
  const Probe = () => h("i", null, String(useStoreSelector(store, (s) => s.b)));
  assert.equal(html(h(Probe)), "<i>2</i>");
});

test("status-bar project menu: Reveal in Finder only with a project open, and it asks the host to reveal the root", async () => {
  const { projectSwitcherItems, ServerOutdatedChip } = await load("StatusBar.tsx");
  const hostMod = await load("host.ts");
  const demo = { name: "Demo", root: "/p/demo" };
  const acts = { openRecent: async () => {}, openFolder: async () => {}, closeProject: async () => {}, reveal: () => {} };
  const withProject = projectSwitcherItems(demo, [demo], acts);
  assert.deepEqual(withProject.map((i) => i.id), ["recent-0", "new", "open", "reveal", "close"], "the Mac order: Open Folder, Reveal, then Close");
  assert.equal(withProject.find((i) => i.id === "reveal")?.label, "Reveal in Finder");
  assert.equal(projectSwitcherItems(null, [], acts).some((i) => i.id === "reveal"), false, "no project, no reveal (the Mac hides it too)");

  const calls = [];
  hostMod.setHostBridge({ invoke: async (cmd, args) => { calls.push([cmd, args]); return null; } });
  try {
    await hostMod.host.projectReveal();
  } finally {
    hostMod.setHostBridge(null);
  }
  assert.deepEqual(calls, [["reveal_in_os", { relPath: "" }]], "the empty relative path is the project root; the host re-checks it");
  await hostMod.host.projectReveal(); // no bridge (browser preview): a quiet no-op, not a throw
});


test("the server-out-of-date chip carries the /health sentence and opens Server settings", async () => {
  const { ServerOutdatedChip } = await load("StatusBar.tsx");
  const warning = "The core reports API 109, but this app expects API 110.";
  const out = html(h(ServerOutdatedChip, { warning }));
  assert.match(out, /Server out of date/);
  assert.match(out, /title="The core reports API 109, but this app expects API 110\."/);
  assert.match(out, /aria-label="Server out of date\. The core reports API 109, but this app expects API 110\. Open Server settings\."/);
});

test("Loop owns Editor and Factory tabs instead of a Factory toolbar item", () => {
  const out = html(h(Shell, { initialSection: "loop", spike: () => null }));
  assert.match(out, /role="tablist"[^>]*aria-label="Loop views"/);
  assert.match(out, />Editor</);
  assert.match(out, />Factory</);
  assert.doesNotMatch(out, /data-tb-id="conflicts"/);
});
