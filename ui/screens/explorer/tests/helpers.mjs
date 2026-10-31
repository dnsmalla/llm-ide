import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXPLORER = resolve(HERE, "..");
const REPO = resolve(EXPLORER, "../../..");
const DESKTOP = join(REPO, "desktop");
const requireFromDesktop = createRequire(join(DESKTOP, "package.json"));

/**
 * Bundle an explorer module with esbuild (desktop's pinned copy) next to desktop/node_modules, so
 * `react` resolves to desktop's single copy, and import it. Source files use extensionless imports.
 */
export async function load(entryRel) {
  const { build } = requireFromDesktop("esbuild");
  const dir = join(DESKTOP, "node_modules/.cache/explorer-test");
  mkdirSync(dir, { recursive: true });
  const name = entryRel.replace(/[^a-z0-9]+/gi, "_");
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [join(EXPLORER, entryRel)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
    // Vite-only: no screens exist in node tests.
    define: { "import.meta.glob": "Object" },
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") },
  });
  return import(`${outfile}?t=${Date.now()}`);
}

/** Desktop's single React copy: tests must render with the same instance the bundles import. */
export const React = requireFromDesktop("react");
export const { renderToStaticMarkup } = requireFromDesktop("react-dom/server");
