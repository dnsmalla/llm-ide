import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { baseName, needsPatch, patchMonacoSource } from "./scripts/monaco-freeze-patch.ts";
import { ALL_FEATURES, compiledFeatures } from "../ui/screens/shell/features.ts";

const appVersion = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "dev";

// The feature profile for this build: `LLMIDE_BUILD_FEATURES=agent_chat,file_explorer,...` (unset/empty = all).
// Dependencies are closed here too, so a build cannot contain Graph without Explorer. The booleans are injected as
// `__FEATURE_*__` defines; screens.tsx uses them in dead branches, which Rollup removes together with the chunk.
const requested = (process.env.LLMIDE_BUILD_FEATURES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => (ALL_FEATURES as readonly string[]).includes(s));
const compiled = compiledFeatures(Object.fromEntries(ALL_FEATURES.map((f) => [f, requested.length === 0 || requested.includes(f)])));
const featureDefines: Record<string, string> = {};
for (const f of ALL_FEATURES) {
  featureDefines[`__FEATURE_${f.toUpperCase()}__`] = JSON.stringify(compiled.has(f));
}

// Monaco 0.57 ships its own copy of DOMPurify (3.4.15, with known advisories) at
// esm/vs/base/browser/dompurify/dompurify.js, imported by relative path, so an npm
// override cannot reach it. Redirect that import to the pinned `dompurify` package
// (package.json, exact version). `scripts/check-dompurify.mjs` verifies the build.
const useNpmDompurify = (): Plugin => ({
  name: "llmide-monaco-dompurify",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!importer || !/monaco-editor\/esm\//.test(importer.replaceAll("\\", "/"))) return null;
    if (!/\/dompurify\/dompurify\.js$/.test(source)) return null;
    return this.resolve("dompurify", importer, { ...options, skipSelf: true });
  },
});

// Tauri's `freezePrototype` freezes Object.prototype (a hardening we keep). Monaco assigns `toString` on plain
// namespace objects in five files at module init; under a frozen prototype that throws and the editor never
// loads ("Attempted to assign to readonly property."). Rewrite just those assignments to defineProperty.
const freezeSafeMonaco = (): Plugin => ({
  name: "llmide-monaco-frozen-prototype",
  enforce: "pre",
  transform(code, id) {
    if (!needsPatch(id)) return null;
    const next = patchMonacoSource(code, baseName(id));
    return next === code ? null : { code: next, map: null };
  },
});

// Tauri expects a fixed dev port (see src-tauri/tauri.conf.json devUrl).
export default defineConfig(({ mode }) => ({
  plugins: [useNpmDompurify(), freezeSafeMonaco(), react()],
  resolve: {
    // @llmide/ui-kit is consumed from source (../ui/kit): one React for kit and app.
    alias: [
      { find: /^@tauri-apps\/api\/event$/, replacement: fileURLToPath(new URL("./node_modules/@tauri-apps/api/event.js", import.meta.url)) },
      { find: /^@llmide\/ui-kit\/styles\.css$/, replacement: fileURLToPath(new URL("../ui/kit/src/styles/kit.css", import.meta.url)) },
      { find: /^@llmide\/ui-kit$/, replacement: fileURLToPath(new URL("../ui/kit/src/index.ts", import.meta.url)) },
      // Phase 3 screens live in ../ui/screens/<name> (one owner per folder; see ui/screens/README.md).
      { find: /^@llmide\/screens\/(.*)$/, replacement: fileURLToPath(new URL("../ui/screens/", import.meta.url)) + "$1" },
      // The System (Agentic OS) page is graph-kit's React view, consumed from the submodule source.
      { find: /^@dnsmalla\/graph-kit-web$/, replacement: fileURLToPath(new URL("../graph-kit/web/src/index.ts", import.meta.url)) },
      // graph-kit web has its own vendored three (the desktop does not install it); resolve exactly.
      { find: /^three\/examples\/jsm\/(.*)$/, replacement: fileURLToPath(new URL("../graph-kit/web/node_modules/three/examples/jsm/", import.meta.url)) + "$1" },
      { find: /^three$/, replacement: fileURLToPath(new URL("../graph-kit/web/node_modules/three/build/three.module.js", import.meta.url)) },
    ],
    // graphology and sigma (ui/screens/graph) and qrcode-generator (ui/screens/settings) are imported outside desktop/:
    // resolve them from here too.
    dedupe: ["react", "react-dom", "graphology", "sigma", "three", "qrcode-generator"],
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          // Same redirect for the dev pre-bundle (esbuild does not run Vite plugins).
          name: "llmide-monaco-dompurify",
          setup(build) {
            build.onResolve({ filter: /\/dompurify\/dompurify\.js$/ }, async (args) => {
              if (!args.importer.replaceAll("\\", "/").includes("monaco-editor/esm/")) return null;
              return build.resolve("dompurify", { resolveDir: args.resolveDir, kind: args.kind });
            });
          },
        },
        {
          // The frozen-prototype patch for the dev pre-bundle (same rewrite as the Vite plugin above).
          name: "llmide-monaco-frozen-prototype",
          setup(build) {
            build.onLoad({ filter: /monaco-editor[\\/]esm[\\/].*\.js$/ }, (args) => {
              if (!needsPatch(args.path)) return null;
              const src = readFileSync(args.path, "utf8");
              return { contents: patchMonacoSource(src, baseName(args.path)), loader: "js" };
            });
          },
        },
      ],
    },
  },
  // Shown in Settings > About (the webview cannot read package.json or ask the host for it).
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    ...featureDefines,
    // The Phase 0 spike views ship only in dev or when asked for (they pull monaco/sigma/xterm copies).
    __INCLUDE_SPIKE__: JSON.stringify(process.env.LLMIDE_INCLUDE_SPIKE === "1" || mode !== "production"),
  },
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "127.0.0.1", fs: { allow: [".."] } },
  build: { target: "es2022" },
}));
