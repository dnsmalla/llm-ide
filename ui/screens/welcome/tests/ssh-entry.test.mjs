// Welcome's SSH server entry: the copy, the Set up button, and where it leads (Settings → Server & Backend).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const require = createRequire(join(REPO, "desktop/package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

let m;
before(async () => {
  const { build } = require("esbuild");
  const dir = bundleDir("welcome-ssh-entry");
  const entry = join(dir, "entry-src.ts");
  const outfile = join(dir, "entry.mjs");
  writeFileSync(entry, `export { SshServerEntry, SSH_SETUP_TARGET } from ${JSON.stringify(join(HERE, "../SshServerEntry.tsx"))};\n`);
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent" });
  m = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
});

test("the Welcome entry names the SSH server, says what it does, and offers Set up", () => {
  const html = renderToStaticMarkup(React.createElement(m.SshServerEntry)).replace(/<!-- -->/g, "").replaceAll("&#x27;", "'");
  assert.match(html, /SSH server/);
  assert.match(html, /Work on a server you can sign in to with SSH\. The app installs its server part in your home folder there\. No domain, certificate or administrator access is needed\./);
  assert.match(html, />Set up</);
});

test("Set up opens Settings at the server card", () => {
  assert.deepEqual(m.SSH_SETUP_TARGET, { section: "settings", anchor: "server" });
});
