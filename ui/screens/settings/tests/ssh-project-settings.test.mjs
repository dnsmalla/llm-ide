// Paths and Memory on a server folder (ssh mode): a plain folder shows only the notice; a project and local mode are unchanged.
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
const NOTICE = () => m.projectModel.PATHS_TEXT.plainFolder;

const withSsh = (on, fn) => {
  m.shellHost.setSshModeProvider(() => on);
  try { return fn(); } finally { m.shellHost.setSshModeProvider(() => false); }
};

test("paths_shows_notice_for_plain_server_folder: ssh plain folder renders only the notice", () => {
  const out = withSsh(true, () => html(wrap(h(m.paths.default, { initial: pathsData(false) }))));
  assert.ok(out.includes(NOTICE()), "notice text");
  assert.ok(!out.includes("Rebuild missing folders"), "no Rebuild button");
  assert.ok(!out.includes(m.projectModel.PATHS_TEXT.hint), "no generic hint");
  assert.ok(!out.includes("data-partial-note"), "no partial note");
  assert.ok(!out.includes("Project root"), "no project root row");
  assert.ok(!out.includes("Export Project Data"), "no export");
});

test("memory_shows_notice_for_plain_server_folder: ssh plain folder renders only the notice", () => {
  const out = withSsh(true, () => html(wrap(h(m.memory.default, { initial: { data: memoryData, plainFolder: true } }))));
  assert.ok(out.includes(NOTICE()), "notice text");
  assert.ok(!out.includes("Ask Chat about memory"), "no Ask Chat button");
  assert.ok(!out.includes(m.projectModel.MEMORY_TEXT.hint), "no generic hint");
});

test("paths_unchanged_in_local_mode: a plain folder in local mode keeps the full card", () => {
  const out = withSsh(false, () => html(wrap(h(m.paths.default, { initial: pathsData(false) }))));
  assert.ok(!out.includes(NOTICE()), "no notice in local mode");
  assert.ok(out.includes("Rebuild missing folders"));
  assert.ok(out.includes(m.projectModel.PATHS_TEXT.hint));
  assert.ok(out.includes("Project root"));
});

test("paths_unchanged_in_local_mode: a project in ssh mode keeps the full card", () => {
  const out = withSsh(true, () => html(wrap(h(m.paths.default, { initial: pathsData(true) }))));
  assert.ok(!out.includes(NOTICE()));
  assert.ok(out.includes("Rebuild missing folders"));
  assert.ok(out.includes("Project root"));
});

test("memory_unchanged_in_local_mode: a plain folder in local mode keeps the full card", () => {
  const out = withSsh(false, () => html(wrap(h(m.memory.default, { initial: { data: memoryData, plainFolder: true } }))));
  assert.ok(!out.includes(NOTICE()));
  assert.ok(out.includes("Ask Chat about memory"));
});

// Repositories: the clone destination follows the project. A plain server folder has no clone destination in ssh mode.
test("codeDirOf: a plain server folder in ssh mode offers no code/ destination, even when code/ exists", () => {
  const data = { root: "/srv/home/docs/", id: "", folders: [{ name: "code", exists: true }], isProject: false };
  assert.equal(m.projectModel.codeDirOf(data, true), null);
});

test("codeDirOf: a project in ssh mode gives its code/ folder", () => {
  const data = { root: "/srv/home/docs/", id: "", folders: [{ name: "code", exists: true }], isProject: true };
  assert.equal(m.projectModel.codeDirOf(data, true), "/srv/home/docs/code");
});

test("codeDirOf: local mode is unchanged, plain folder included", () => {
  const plain = { root: "/Users/me/docs", id: "", folders: [{ name: "code", exists: false }], isProject: false };
  assert.equal(m.projectModel.codeDirOf(plain, false), "/Users/me/docs/code");
  const none = { root: "/Users/me/docs", id: "", folders: [{ name: "system", exists: true }], isProject: true };
  assert.equal(m.projectModel.codeDirOf(none, false), null, "no code/ folder, no destination");
});

test("codeDirOf: an older host that omits isProject keeps the destination (decoded as a project)", () => {
  const old = m.projectModel.decodePaths({ root: "/srv/p", id: "x", folders: [{ name: "code", exists: true }] });
  assert.equal(old.isProject, true);
  assert.equal(m.projectModel.codeDirOf(old, true), "/srv/p/code");
});
