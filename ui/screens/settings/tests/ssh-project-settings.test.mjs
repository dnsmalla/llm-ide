// Paths and Memory on a server folder (ssh mode): a plain server folder gets the full cards, same as a project and local mode.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = resolve(HERE, "..");
const REPO = resolve(SETTINGS, "../../..");
const req = createRequire(join(REPO, "desktop", "package.json"));
const { build } = req("esbuild");
const { createElement: h } = req("react");
const { renderToStaticMarkup } = req("react-dom/server");
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

let m;
before(async () => {
  const outdir = bundleDir("settings-ssh");
  await build({
    entryPoints: {
      paths: join(SETTINGS, "sections/PathsSection.tsx"),
      memory: join(SETTINGS, "sections/MemorySection.tsx"),
      context: join(SETTINGS, "context.tsx"),
      projectModel: join(SETTINGS, "project-model.ts"),
      shellHost: join(REPO, "ui/screens/shell/host.ts"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
    loader: { ".css": "empty" },
    alias: {
      "@llmide/ui-kit/styles.css": join(REPO, "ui/kit/src/styles/kit.css"),
      "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts"),
      "@llmide/screens/shell": join(REPO, "ui/screens/shell/index.ts"),
    },
  });
  const t = `?t=${Date.now()}`;
  m = {};
  for (const k of ["paths", "memory", "context", "projectModel", "shellHost"]) m[k] = await import(pathToFileURL(join(outdir, `${k}.js`)).href + t);
});

const html = (el) => renderToStaticMarkup(el);
const env = () => ({
  client: {},
  host: {
    projectPaths: async () => ({}),
    projectMemory: async () => ({}),
    rebuildProjectFolders: async () => {},
    revealPath: async () => {},
    notesFolderPath: async () => null,
  },
});
const wrap = (el) => h(m.context.SettingsEnvProvider, { env: env() }, el);
const pathsData = (isProject) => ({ root: "/srv/home/docs", id: "", folders: [{ name: "system", exists: false }], isProject });
const memoryData = { root: "/srv/home/docs", graph: null, files: [] };

const withSsh = (on, fn) => {
  m.shellHost.setSshModeProvider(() => on);
  try { return fn(); } finally { m.shellHost.setSshModeProvider(() => false); }
};

test("paths_plain_server_folder_gets_full_card: ssh folder with isProject false renders the full card with Rebuild", () => {
  const out = withSsh(true, () => html(wrap(h(m.paths.default, { initial: pathsData(false) }))));
  assert.ok(out.includes("Rebuild missing folders"), "Rebuild button");
  assert.ok(out.includes(m.projectModel.PATHS_TEXT.hint), "generic hint");
  assert.ok(out.includes("Project root"), "project root row");
  assert.ok(!out.includes("not an LLM-IDE project"), "no plain-folder notice");
});

test("memory_plain_server_folder_gets_full_card: ssh memory card renders normally", () => {
  const out = withSsh(true, () => html(wrap(h(m.memory.default, { initial: { data: memoryData } }))));
  assert.ok(out.includes("Ask Chat about memory"), "Ask Chat button");
  assert.ok(out.includes(m.projectModel.MEMORY_TEXT.graph), "knowledge graph row");
  assert.ok(!out.includes("not an LLM-IDE project"), "no plain-folder notice");
});

test("paths_rebuild_and_root_in_both_modes: ssh and local both render Rebuild and Project root", () => {
  const ssh = withSsh(true, () => html(wrap(h(m.paths.default, { initial: pathsData(false) }))));
  const local = withSsh(false, () => html(wrap(h(m.paths.default, { initial: pathsData(false) }))));
  assert.ok(local.includes("Rebuild missing folders"));
  assert.ok(ssh.includes("Rebuild missing folders"));
  assert.ok(ssh.includes("Project root") && local.includes("Project root"));
});

test("paths_project_in_ssh_mode_keeps_full_card: a real project still shows the full card", () => {
  const out = withSsh(true, () => html(wrap(h(m.paths.default, { initial: pathsData(true) }))));
  assert.ok(out.includes("Rebuild missing folders"));
  assert.ok(out.includes("Project root"));
});

test("memory_local_mode_full_card: local memory card renders normally", () => {
  const out = withSsh(false, () => html(wrap(h(m.memory.default, { initial: { data: memoryData } }))));
  assert.ok(out.includes("Ask Chat about memory"));
});

// Repositories: the clone destination is <root>/code in every mode and for every open folder.
test("codeDirOf: a plain server folder gets <root>/code, same as a project", () => {
  const plain = { root: "/srv/home/docs/", id: "", folders: [{ name: "code", exists: true }], isProject: false };
  assert.equal(m.projectModel.codeDirOf(plain), "/srv/home/docs/code");
  const project = { ...plain, isProject: true };
  assert.equal(m.projectModel.codeDirOf(project), "/srv/home/docs/code");
});

test("codeDirOf: no code/ folder listed, no destination", () => {
  const none = { root: "/Users/me/docs", id: "", folders: [{ name: "system", exists: true }] };
  assert.equal(m.projectModel.codeDirOf(none), null);
});

test("codeDirOf: an older host that omits isProject keeps the destination", () => {
  const old = m.projectModel.decodePaths({ root: "/srv/p", id: "x", folders: [{ name: "code", exists: true }] });
  assert.equal(m.projectModel.codeDirOf(old), "/srv/p/code");
});

test("paths_export_needs_a_project: isProject false disables both Export buttons with the hint; true or omitted enables them", () => {
  const hint = "Press Rebuild missing folders first: this folder is not a project yet.";
  const btn = (out, label) => out.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";
  const render = (initial) => withSsh(true, () => html(wrap(h(m.paths.default, { initial }))));
  const labels = ["Export Project Data", "Export Plans"];
  const none = render({ ...pathsData(false), id: "p1" });
  for (const label of labels) assert.ok(/disabled/.test(btn(none, label)), `${label} disabled`);
  assert.ok(none.includes(hint), "hint shown");
  const ok = render({ ...pathsData(true), id: "p1" });
  for (const label of labels) assert.ok(btn(ok, label) && !/disabled/.test(btn(ok, label)), `${label} enabled`);
  assert.ok(!ok.includes(hint), "no hint");
  const { isProject, ...omitted } = { ...pathsData(true), id: "p1" };
  const old = render(m.projectModel.decodePaths(omitted));
  for (const label of labels) assert.ok(btn(old, label) && !/disabled/.test(btn(old, label)), `${label} enabled when omitted`);
});

// Server errors reach the sentence: a string, an Error and the SSH { code, message } object all keep the host's text.
test("projectError: string, Error and { code, message } keep the host's message; no_project maps to its text", () => {
  const pe = m.projectModel.projectError;
  assert.equal(pe("permission denied"), "permission denied");
  assert.equal(pe(new Error("disk full")), "disk full");
  assert.equal(pe({ code: "invalid_path", message: "That path is not valid on the server." }), "That path is not valid on the server.");
  assert.equal(pe({ code: "no_project", message: "No project is open." }), m.projectModel.PATHS_TEXT.noProject);
  assert.equal(pe("No project is open on this server."), m.projectModel.PATHS_TEXT.noProject);
  assert.equal(pe({ code: "weird" }), "The project folders could not be read.");
});

test("cloneError: clone_timeout shows its own message; no_project maps to the no-project text", () => {
  const ce = m.projectModel.cloneError;
  const timeout = "The clone took longer than 30 minutes and was stopped.";
  assert.equal(ce({ code: "clone_timeout", message: timeout }), timeout);
  assert.equal(ce({ code: "no_project", message: "not a project" }), m.projectModel.PATHS_TEXT.noProject);
  assert.equal(ce("already exists"), "already exists");
  assert.equal(ce({}), "The clone failed.");
});
