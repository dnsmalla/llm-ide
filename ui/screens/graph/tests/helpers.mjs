import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const REPO = resolve(HERE, "../../../..");
const requireFromDesktop = createRequire(join(REPO, "desktop/package.json"));

/** Bundle entry.ts with desktop's esbuild so react and sigma resolve to desktop's copies; import the result. */
export async function loadEntry() {
  const { build } = requireFromDesktop("esbuild");
  const outfile = join(bundleDir("graph"), "entry.mjs");
  await build({
    entryPoints: [join(HERE, "entry.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts"), sigma: join(HERE, "stubs/sigma.ts") },
    jsx: "automatic",
    logLevel: "silent",
  });
  return import(`${outfile}?t=${Date.now()}`);
}

export const react = () => requireFromDesktop("react");
export const server = () => requireFromDesktop("react-dom/server");
