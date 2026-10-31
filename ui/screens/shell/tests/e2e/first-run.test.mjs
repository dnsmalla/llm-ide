// Clean-data-dir first run against the REAL core (extension/server.mjs, fake engine, empty temp DB, no user):
// Welcome is the landing, sign-in/create-account works, New project creates the scaffold through a FAKE host,
// the core registration and skills-install calls are made, the shell lands on Explorer, and Chat sends a message.
// The Rust host side (project_create) is covered by cargo tests; the fake mirrors its contract.
// Skip with LLMIDE_E2E=0 (the suite needs local port binding).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDir } from "../../../../../desktop/scripts/test-outdir.mjs";
import { startCore } from "./core-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const require = createRequire(join(REPO, "desktop/package.json"));
const skip = process.env.LLMIDE_E2E === "0" ? "LLMIDE_E2E=0" : false;

let m;
let core;
let parent;
before(async () => {
  if (skip) return;
  const { build } = require("esbuild");
  const outfile = join(bundleDir("shell-first-run"), "entry.mjs");
  await build({
    entryPoints: [join(HERE, "first-run-entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent",
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") },
  });
  m = await import(`${outfile}?t=${Date.now()}`);
  core = await startCore({ register: false });
  parent = mkdtempSync(join(tmpdir(), "llmide-firstrun-"));
});
after(async () => {
  await core?.stop();
  if (parent) rmSync(parent, { recursive: true, force: true });
});

const until = async (fn, ms = 15_000, info = () => "") => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out ${info()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const RESULT = () => readFileSync(join(REPO, "schema/agent-v2/fixtures/result.json"), "utf8").trim();
const withResult = (t) => ({ ...t, async *stream(path, body, signal) { yield* t.stream(path, body, signal); yield RESULT(); } });

/** The host's project commands, in memory: project_create writes the marker the core's skills installer needs. */
function fakeProjectHost() {
  const st = { active: null, recent: [], dialogs: 0 };
  return {
    st,
    h: {
      projectActive: async () => st.active,
      projectRecent: async () => st.recent,
      projectOpen: async () => null,
      projectOpenRecent: async (i) => (st.active = st.recent[i]),
      projectRecentAll: async () => ({ entries: st.recent.map((p, i) => ({ name: p.name, root: p.root, status: "ok", reason: null, openIndex: i, storedIndex: i })), reset: false }),
      projectCreate: async (name) => {
        st.dialogs++;
        const check = m.validateProjectName(name);
        if (!check.ok) throw new Error(check.error);
        const root = join(parent, check.name);
        if (existsSync(root)) throw new Error(`"${check.name}" already exists in that location`);
        mkdirSync(join(root, "system"), { recursive: true });
        mkdirSync(join(root, "llm-doc"));
        writeFileSync(join(root, "system/project.json"), JSON.stringify({ schemaVersion: 1, id: "t1", displayName: check.name, createdAt: "2026-10-31T00:00:00Z", settings: { language: "en" } }));
        const p = { name: check.name, root };
        st.active = p;
        st.recent = [p, ...st.recent];
        return p;
      },
      projectClose: async () => { st.active = null; },
      projectForgetRecent: async (i, root) => { st.recent = st.recent.filter((p) => p.root !== root); return true; },
    },
  };
}

test("first run: Welcome, sign-in/register, New project scaffold + core registration + skills, Explorer landing, Chat reply", { skip }, async () => {
  // 1. Nothing is known: the view-model lands on Welcome (never the dead Chat), whatever the stored preference.
  assert.equal(m.initialNav(null).active, "welcome");
  assert.equal(m.landingFor({ prev: undefined, now: null, home: m.readHome(), overridden: false }), "welcome");

  // 2. The core is up but nobody is signed in: the gate shows the sign-in panel, not a blank screen.
  const client = m.createCoreClient({ baseUrl: () => core.base });
  const view = m.deriveStatusView({ status: m.normalizeCoreStatus({ url: core.base, state: "ready", trust: "spawned" }), pollError: null, everReady: false });
  assert.equal(m.computeGate({ view, signedIn: client.getSnapshot().signedIn, everUsable: false, bypass: false }), "login");
  assert.equal(await client.registrationOpen(), true, "a clean data directory allows creating the first account");
  const email = "first-run@example.com";
  const password = "first-run-password-123";
  await client.register(email, password, "First Run");
  const snap = await client.login(email, password);
  assert.equal(snap.signedIn, true);
  assert.equal(m.computeGate({ view, signedIn: true, everUsable: false, bypass: false }), "open");

  // 3. New project through the (fake) host: a bad name never reaches the dialog; a good one creates the scaffold,
  //    then the core is told (register + install skills) BEFORE the shell switches.
  const { h, st } = fakeProjectHost();
  const store = m.createProjectStore(h);
  await store.refresh();
  assert.equal(store.getSnapshot().project, null);
  assert.equal(store.getSnapshot().loaded, true);
  const bad = m.validateProjectName("../escape");
  assert.equal(bad.ok, false);

  const calls = [];
  const spy = { request: async (path, opts) => { calls.push({ path, method: opts?.method, body: opts?.body }); return client.request(path, opts); } };
  let projectSeenByHook = "unset";
  const created = await store.createProject("First Project", async (p) => {
    projectSeenByHook = store.getSnapshot().project;
    return m.registerNewProject(p, { core: spy });
  });
  assert.equal(projectSeenByHook, null, "the shell is not switched before registration finished");
  assert.equal(created.name, "First Project");
  assert.equal(store.getSnapshot().project.root, created.root);
  assert.equal(st.dialogs, 1);

  const id = await m.projectIdFor(created.root);
  const reg = calls.find((c) => c.path === "/kb/projects/register");
  assert.deepEqual(reg.body, { id, root: created.root });
  assert.equal(reg.method, "POST");
  const skills = calls.find((c) => c.path === "/kb/project/install-skills");
  assert.deepEqual(skills.body, { path: created.root, language: "en" });
  // The core accepted the registration (it is the same id Doc Gen derives): no warning mentions it.
  const notice = store.getSnapshot().notice ?? "";
  assert.doesNotMatch(notice, /could not be registered/, notice);
  // Skills may be missing in a source checkout without the kit: then the user gets a warning, never an error.
  assert.equal(store.getSnapshot().error, null);
  if (notice) assert.match(notice, /skills were not installed/);

  // 4. The shell lands on Explorer (the home preference defaults to Explorer).
  assert.equal(m.landingFor({ prev: null, now: created.root, home: m.readHome(), overridden: false }), "explorer");
  assert.equal(m.navReducer(m.initialNav(null), { type: "select", id: "explorer" }).active, "explorer");

  // 5. Chat sends a message with the stub engine, inside the new project.
  const transport = m.coreTransportFrom(client);
  const chatStore = new m.HttpChatStore(transport);
  const ctl = new m.ChatController({ core: withResult(transport), store: chatStore, workspaceRoot: () => created.root });
  const s = await chatStore.createSession({ title: "first chat" });
  ctl.send(s.id, "hello", { mode: "ask", model: "bench-fake" });
  await until(() => ctl.getState(s.id).messages.at(-1)?.status === "done", 15_000, () => JSON.stringify({ phase: ctl.getState(s.id).phase, error: ctl.getState(s.id).error, tail: core.tail(400) }));
  assert.equal(ctl.getState(s.id).messages.length, 2, "the user message and the stub engine's reply");

  // 6. Closing returns to Welcome; the recent list keeps the project; nothing was deleted.
  await store.closeProject();
  assert.equal(store.getSnapshot().project, null);
  assert.equal(m.landingFor({ prev: created.root, now: null, home: "explorer", overridden: false }), "welcome");
  assert.equal(store.getSnapshot().recentAll.entries.length, 1);
  assert.ok(existsSync(join(created.root, "system/project.json")));
  await client.logout();
});

test("an existing name is refused by the host and shown as an error; the first project is untouched", { skip }, async () => {
  const { h } = fakeProjectHost();
  const store = m.createProjectStore(h);
  const first = await store.createProject("Twice");
  assert.ok(first);
  const second = await store.createProject("Twice");
  assert.equal(second, null);
  assert.match(store.getSnapshot().error, /already exists/);
  assert.ok(existsSync(join(first.root, "system/project.json")));
});
