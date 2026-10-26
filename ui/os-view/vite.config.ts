import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The committed bundle lives in the Mac app's resources (Monaco precedent).
// OS_VIEW_OUT redirects the build, which `make os-view-check` uses to build
// into a temp dir and diff against the committed output.
const outDir =
  process.env.OS_VIEW_OUT ??
  fileURLToPath(new URL('../../mac/Sources/LlmIdeMac/Resources/os-view', import.meta.url));

// The page is opened from file:// inside a WKWebView. A module script or a
// crossorigin attribute is refused for file:// origins, so the build emits
// one classic IIFE script, deferred, and a plain stylesheet link.
function classicPage(): Plugin {
  return {
    name: 'os-view-classic-page',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, '<script defer src="$1"></script>')
          .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, '<link rel="stylesheet" href="$1">');
      },
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), classicPage()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
