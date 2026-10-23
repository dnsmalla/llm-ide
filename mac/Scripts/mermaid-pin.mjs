#!/usr/bin/env node
// Prints the pin for the optional mermaid component (Core/Editor/Mermaid.swift)
// for one exact mermaid release, after confirming the CDN serves the same
// bytes npm publishes.
//
// mermaid is no longer vendored into the app: it is 3.4 MB that only a
// document with a ```mermaid fence needs, so the app downloads it on demand
// from cdn.jsdelivr.net and refuses any file whose SHA-256 differs from the
// pin. This script is how that pin is produced. Two sources must agree — the
// npm tarball and the CDN file the app will actually fetch — so a pin is never
// taken on the CDN's word alone.
//
// Keep the version EXACT (no `@11` range): mermaid bundles its own DOMPurify,
// and that is the control that makes `securityLevel: 'strict'` actually
// sanitise the SVG the preview injects with innerHTML. Review the release
// before bumping.
//
// Usage:
//   cd mac && npm install mermaid@<version> --no-save && node Scripts/mermaid-pin.mjs <version>
// then paste the printed constants into Core/Editor/Mermaid.swift.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node Scripts/mermaid-pin.mjs <exact version, e.g. 11.17.2>');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const macRoot = path.resolve(__dirname, '..');
const pkgDir = path.join(macRoot, 'node_modules', 'mermaid');
const npmFile = path.join(pkgDir, 'dist', 'mermaid.min.js');
if (!existsSync(npmFile)) {
  console.error(`mermaid not installed. Run: cd mac && npm install mermaid@${version} --no-save`);
  process.exit(1);
}
const installed = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
if (installed !== version) {
  console.error(`node_modules has mermaid ${installed}, not ${version}. Reinstall with --no-save.`);
  process.exit(1);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const npmBytes = readFileSync(npmFile);

const url = `https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`CDN fetch failed: HTTP ${res.status} for ${url}`);
  process.exit(1);
}
const cdnBytes = Buffer.from(await res.arrayBuffer());

if (sha256(npmBytes) !== sha256(cdnBytes)) {
  console.error('MISMATCH: the CDN file differs from the npm tarball. Do not pin.');
  console.error(`  npm ${sha256(npmBytes)} (${npmBytes.length} bytes)`);
  console.error(`  cdn ${sha256(cdnBytes)} (${cdnBytes.length} bytes)`);
  process.exit(1);
}

console.log(`npm and CDN agree for mermaid ${version}. Paste into Core/Editor/Mermaid.swift:`);
console.log(`    static let version = "${version}"`);
console.log(`    static let sha256 = "${sha256(cdnBytes)}"`);
console.log(`    static let byteCount = ${cdnBytes.length.toLocaleString('en-US').replace(/,/g, '_')}`);
