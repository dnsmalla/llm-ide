import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const requireFromDesktop = createRequire(join(REPO, "desktop", "package.json"));

/** Bundles a test entry with desktop's esbuild (same recipe as helpers.mjs) into a per-process dir. */
export async function loadBundle(name, entryFile) {
  const { build } = requireFromDesktop("esbuild");
  const dir = bundleDir(name);
  const outfile = join(dir, "entry.mjs");
  await build({
    entryPoints: [join(HERE, entryFile)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") },
    jsx: "automatic",
    logLevel: "silent",
  });
  return import(`${outfile}?t=${Date.now()}`);
}

export const react = () => requireFromDesktop("react");
export const server = () => requireFromDesktop("react-dom/server");
