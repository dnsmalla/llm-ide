import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHELL = resolve(HERE, "..");
const REPO = resolve(SHELL, "../../..");
const DESKTOP = join(REPO, "desktop");
const requireFromDesktop = createRequire(join(DESKTOP, "package.json"));

/**
 * Bundle a shell module with esbuild (desktop's pinned copy) next to desktop/node_modules, so
 * `react` resolves to desktop's single copy, and import it. Source files use extensionless imports.
 */
export async function load(entryRel) {
  const { build } = requireFromDesktop("esbuild");
  const dir = join(DESKTOP, "node_modules/.cache/shell-test");
  mkdirSync(dir, { recursive: true });
  const name = entryRel.replace(/[^a-z0-9]+/gi, "_");
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [join(SHELL, entryRel)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") },
  });
  return import(`${outfile}?t=${Date.now()}`);
}
