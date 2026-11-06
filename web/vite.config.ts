import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

// One fixed origin for dev and preview: the host's LLMIDE_HOST_API_WEB_ORIGINS must list http://127.0.0.1:5180.
// Not 5173: that is the desktop's own Vite.
export const WEB_PORT = 5180;
// connect-src: plaintext ws only to loopback (the dev listener); wss to any host the user enters (phase 6 hosts);
// MEGA for offline sync (design 8.3): the API host and the transfer hosts it hands out per download/upload.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:* wss: https://g.api.mega.co.nz https://*.userstorage.mega.co.nz https://gitlab.com https://api.box.com https://dl.boxcloud.com https://public.boxcloud.com", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
].join("; ");

// Vite's dev server injects an inline React-refresh preamble, so the CSP meta goes into the built page only.
const cspMeta = (): Plugin => ({
  name: "llmide-web-csp",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The public site owns `/`; the PWA is mounted at `/app/`.
  base: process.env.VITE_BASE || "/",
  plugins: [react(), cspMeta()],
  resolve: {
    alias: [
      { find: /^@llmide\/ui-kit\/styles\.css$/, replacement: here("../ui/kit/src/styles/kit.css") },
      { find: /^@llmide\/ui-kit$/, replacement: here("../ui/kit/src/index.ts") },
      { find: /^@llmide\/screens\/(.*)$/, replacement: here("../ui/screens/") + "$1" },
    ],
    dedupe: ["react", "react-dom"],
  },
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: { port: WEB_PORT, strictPort: true, host: "127.0.0.1", fs: { allow: [".."] } },
  preview: { port: WEB_PORT, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022" },
});
