import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

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
  const dir = bundleDir("shell");
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
    // Vite-only: no screens exist in node tests.
    define: { "import.meta.glob": "Object" },
    // Screen modules and the dock chunk are stubbed: these tests exercise the shell, and bundling every screen
    // would pull Monaco/wasm/xterm (Vite handles those queries; esbuild does not).
    plugins: [{
      name: "test-screen-stubs",
      setup(b) {
        b.onResolve({ filter: /^\.\.\/(welcome|chat|library|settings|explorer|graph|docgen|live)\/(index|visual)\.tsx$/ }, (args) => ({ path: args.path, namespace: "screen-stub" }));
        b.onResolve({ filter: /^\.\.\/chat\/dock\.tsx$/ }, (args) => ({ path: args.path, namespace: "screen-stub" }));
        b.onLoad({ filter: /.*/, namespace: "screen-stub" }, () => ({ contents: "export default function Stub(){ return null; }", loader: "jsx" }));
      },
    }],
    // The dock chunk imports the kit stylesheet; bundle it as text (side-effect only) instead of failing.
    loader: { ".css": "text" },
    external: ["../../../../desktop/src/terminal/dockRuntime", "../../../desktop/src/terminal/dockRuntime"],
    alias: {
      "@llmide/ui-kit/styles.css": join(REPO, "ui/kit/src/styles/kit.css"),
      "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts"),
    },
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

/** Desktop's single React copy: tests must render with the same instance the bundles import. */
export const React = requireFromDesktop("react");
export const { renderToStaticMarkup } = requireFromDesktop("react-dom/server");
