#!/usr/bin/env node
// Vendors mermaid into Sources/LlmIdeMac/Resources/mermaid/ so the markdown
// preview can draw ```mermaid fences as diagrams instead of showing their
// source.
//
// Vendored rather than loaded from a CDN for the same reason monaco and
// highlight.js are: the preview is a WKWebView rendering a local HTML string,
// the app is expected to work offline, and a remote <script> would put document
// rendering at the mercy of the network.
//
// Only `mermaid.min.js` is copied — NOT the 13 MB source map beside it, which
// is the bulk of the package and useless in a shipped bundle.
//
// Usage: cd mac && npm install mermaid@11 --no-save && node Scripts/build-mermaid-bundle.mjs

import { existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const macRoot = path.resolve(__dirname, '..');
const src = path.join(macRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const outDir = path.join(macRoot, 'Sources', 'LlmIdeMac', 'Resources', 'mermaid');
const out = path.join(outDir, 'mermaid.min.js');

if (!existsSync(src)) {
  console.error('mermaid not installed. Run:');
  console.error('  cd mac && npm install mermaid@11 --no-save && node Scripts/build-mermaid-bundle.mjs');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(src, out);

const mb = (statSync(out).size / (1024 * 1024)).toFixed(1);
console.log(`mermaid: vendored mermaid.min.js (${mb} MB) → Resources/mermaid/`);
