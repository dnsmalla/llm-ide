#!/usr/bin/env node
// React runtime smoke check — `npm run test:render`.
//
// The main suite (node --test --experimental-strip-types) cannot import a
// .tsx, so nothing there renders a component: type-check, build and lint can
// all pass while React itself is broken. This builds tests/render/cases.tsx
// through the app's own vite pipeline and renders real components with
// react-dom/server.
//
// Kept out of `npm test` on purpose — it shells out to a vite SSR build, which
// is far slower than the unit suite. Run it when touching React, the React
// types, or anything in src/sidepanel/components/.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
// Must live INSIDE the package so node resolves the externalised react /
// react-dom from extension/node_modules — a tmpdir build cannot see them.
// dist/ is gitignored, so this leaves no tracked artefact.
const out = join(ROOT, 'dist', '.render');
mkdirSync(out, { recursive: true });

let failed = 0;
try {
  await build({
    root: ROOT,
    // Do NOT inherit the app's vite.config.ts — this harness needs only the
    // React plugin, and loading the app config drags in its manifest/plugins
    // (and its warnings) for no benefit.
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    build: {
      ssr: resolve(ROOT, 'tests/render/cases.tsx'),
      outDir: out,
      emptyOutDir: true,
      // Externalised so the harness renders with the versions actually
      // installed, not a bundled copy.
      rollupOptions: {
        external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
      },
    },
  });

  const { getCases } = await import(pathToFileURL(join(out, 'cases.js')).href);
  const { reactVersion, cases } = getCases();
  console.log(`React ${reactVersion} — rendering ${cases.length} component case(s)\n`);

  for (const { name, render, expect } of cases) {
    let html;
    try {
      html = render();
    } catch (err) {
      // A component that throws is the loudest possible failure — name it
      // rather than letting an uncaught stack bury which case broke.
      console.error(`  ✗ ${name}\n      THREW: ${err?.message || err}`);
      failed++;
      continue;
    }
    const missing = expect.filter((needle) => !html.includes(needle));
    if (html.trim().length === 0) {
      console.error(`  ✗ ${name}\n      rendered EMPTY output`);
      failed++;
    } else if (missing.length > 0) {
      console.error(
        `  ✗ ${name}\n      missing ${missing.map((m) => JSON.stringify(m)).join(', ')}` +
          `\n      got: ${html.slice(0, 120)}…`,
      );
      failed++;
    } else {
      console.log(`  ✓ ${name} (${html.length} chars)`);
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log();
if (failed > 0) {
  console.error(`✗ ${failed} render case(s) failed`);
  process.exit(1);
}
console.log('✓ all render cases passed');
