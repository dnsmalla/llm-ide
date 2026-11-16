// Repositories in ssh mode: the Mac's clone path never shows, gates provisioning or receives a server clone. Local mode is unchanged.
import { test, before, afterEach } from "node:test";
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

const MAC_CLONE = "/Users/me/Desktop/LLM/code/web";
const SERVER_CODE = "/srv/home/docs/code";
const GITLAB_REPO = { displayName: "", url: "https://gitlab.com/grp/web", clonePath: MAC_CLONE, active: true };

let m;
before(async () => {
  const outdir = bundleDir("settings-repo-ssh");
  await build({
    entryPoints: {
      repositories: join(SETTINGS, "sections/RepositoriesSection.tsx"),
      repoConfig: join(SETTINGS, "repo-config.ts"),
      context: join(SETTINGS, "context.tsx"),
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
  for (const k of ["repositories", "repoConfig", "context", "shellHost"]) m[k] = await import(pathToFileURL(join(outdir, `${k}.js`)).href + t);
});

// A Map-backed localStorage so the card's first render reads the saved repository; node has no window storage.
const realStorage = globalThis.localStorage;
function useStorage(saved) {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  globalThis.localStorage = storage;
  const config = m.repoConfig.decodeRepoConfig({ saved: { gitlab: [saved] } });
  m.repoConfig.writeRepoConfig(config, storage);
  return config;
}
afterEach(() => {
  globalThis.localStorage = realStorage;
  m.shellHost.setSshModeProvider(() => false);
});

const env = () => ({
  client: {},
  host: { projectPaths: async () => ({}), cloneRepository: async () => ({ path: "", name: "" }) },
});
const renderCard = (ssh) => {
  useStorage(GITLAB_REPO);
  m.shellHost.setSshModeProvider(() => ssh);
  return renderToStaticMarkup(h(m.context.SettingsEnvProvider, { env: env() }, h(m.repositories.default)));
};

test("local mode: the Local clone row shows the recorded Mac path", () => {
  const out = renderCard(false);
  assert.ok(out.includes("Local clone"), "Local clone label");
  assert.ok(out.includes(MAC_CLONE), "the Mac path");
});

test("ssh mode: the Local clone row is absent and the Mac path is not rendered", () => {
  const out = renderCard(true);
  assert.ok(!out.includes("Local clone"), "no Local clone row");
  assert.ok(!out.includes(MAC_CLONE), "no Mac path");
  assert.ok(out.includes("https://gitlab.com/grp/web"), "the saved URL still renders");
});

test("shouldProvision: a Mac clone path blocks blur-provisioning only in local mode", () => {
  const repo = { url: "https://gitlab.com/grp/web", clonePath: MAC_CLONE };
  assert.equal(m.repoConfig.shouldProvision(repo, false), false, "local: already cloned");
  assert.equal(m.repoConfig.shouldProvision(repo, true), true, "ssh: the server attempt decides");
  assert.equal(m.repoConfig.shouldProvision(repo), false, "default is local");
  assert.equal(m.repoConfig.shouldProvision({ url: "https://gitlab.com/grp/web", clonePath: "" }, true), true);
  assert.equal(m.repoConfig.shouldProvision({ url: "owner", clonePath: "" }, true), false, "a bare owner is never cloned");
});

test("cloneDestinationOf: ssh ignores the Mac path and uses the server code/ folder", () => {
  const repo = GITLAB_REPO;
  assert.equal(m.repoConfig.cloneDestinationOf(repo, SERVER_CODE, true), `${SERVER_CODE}/web`);
  assert.equal(m.repoConfig.cloneDestinationOf(repo, null, true), null, "a plain server folder has no destination");
  assert.equal(m.repoConfig.cloneDestinationOf(repo, SERVER_CODE, false), MAC_CLONE, "local: the recorded path wins");
  const unrecorded = { ...repo, clonePath: "" };
  assert.equal(m.repoConfig.cloneDestinationOf(unrecorded, "/Users/me/docs/code", false), "/Users/me/docs/code/web");
});

test("applyCloneResult: a server clone leaves the saved repository, Mac path included, unchanged", () => {
  const config = useStorage(GITLAB_REPO);
  const after = m.repoConfig.applyCloneResult(config, "gitlab", config.saved.gitlab[0].id, `${SERVER_CODE}/web`, true);
  assert.deepEqual(after, config);
  assert.equal(after.saved.gitlab[0].clonePath, MAC_CLONE);
});

test("applyCloneResult: a local clone records its path as before", () => {
  const config = useStorage({ ...GITLAB_REPO, clonePath: "" });
  const id = config.saved.gitlab[0].id;
  const after = m.repoConfig.applyCloneResult(config, "gitlab", id, MAC_CLONE, false);
  assert.equal(after.saved.gitlab[0].clonePath, MAC_CLONE);
  assert.equal(config.saved.gitlab[0].clonePath, "", "the input is not mutated");
});
