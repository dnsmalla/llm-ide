import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

// Tauri expects a fixed dev port (see src-tauri/tauri.conf.json devUrl).
export default defineConfig({
  plugins: [useNpmDompurify(), react()],
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
      ],
    },
  },
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022" },
});
