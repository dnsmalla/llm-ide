import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIBRARY = resolve(HERE, "..");
const REPO = resolve(LIBRARY, "../../..");
const DESKTOP = join(REPO, "desktop");
const requireFromDesktop = createRequire(join(DESKTOP, "package.json"));

/**
 * Bundle `entry.ts` with esbuild (desktop's pinned copy) next to desktop/node_modules, so `react`
 * resolves to desktop's single copy, and import it. `@llmide/ui-kit` resolves to the kit's source.
 */
export async function loadEntry() {
  const { build } = requireFromDesktop("esbuild");
  const dir = join(DESKTOP, "node_modules/.cache/library-test");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, "entry.mjs");
  await build({
    entryPoints: [join(HERE, "entry.ts")],
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
