import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "..");
const require = createRequire(join(WEB, "package.json"));
export const h = require("react").createElement;
export const html = require("react-dom/server").renderToStaticMarkup;

export async function loadUi() {
  const dir = join(WEB, "node_modules/.cache/ui-tests");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `ui-${process.pid}.mjs`);
  await build({
    entryPoints: [join(HERE, "ui-entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external",
    jsx: "automatic", logLevel: "silent", loader: { ".css": "empty" },
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts"), "@llmide/screens": join(REPO, "ui/screens") },
    define: { __APP_VERSION__: '"test"' },
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}
