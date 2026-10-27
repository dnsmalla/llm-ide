#!/usr/bin/env node
// docs-kit K1b parity golden: the Node project-folder scan over the K1a
// project-marker fixtures, built into a temp project folder.
//
// Run `node scripts/docs-kit-parity-golden.mjs` to rewrite
// mac/Tests/LlmIdeMacTests/Fixtures/docgen/server-scan.golden.json.
// Two tests keep the two sides honest:
//   - extension/tests/docs-server-golden.test.mjs fails if the checked-in
//     file is stale (run this script to fix it);
//   - mac/Tests/LlmIdeMacTests/DocGenServerStoreParityTests.swift builds the
//     same project from the same fixtures, runs the Swift scan, and decodes
//     this file through the Mac's response types.
// The file holds the response bodies the server gives, so the Mac decodes
// them with the models it uses on the wire.

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCommandsPage, scanTemplatesPage } from '../extension/kb/doc-project-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The K1a fixtures (Swift side reads the same files). */
export const FIXTURE_DIR = join(here, '..', 'mac', 'Tests', 'LlmIdeMacTests', 'Fixtures', 'docgen', 'project');
export const GOLDEN_PATH = join(here, '..', 'mac', 'Tests', 'LlmIdeMacTests', 'Fixtures', 'docgen', 'server-scan.golden.json');

/**
 * The project both sides build, as [path inside project, fixture name].
 * Keep in step with `DocGenServerStoreParityTests.layout`. The `auto_task`
 * folder is in the layout so both sides prove they skip it.
 */
export const LAYOUT = Object.freeze([
  ['templates/v0-bare/template.md', 'template-md.v0-bare-marker.md'],
  ['templates/v2-visual/template.md', 'template-md.v2-visual-marker.md'],
  ['templates/auto_task/template.md', 'template-md.v0-bare-marker.md'],
  ['commands/v0-bare/command.md', 'command-md.v0-bare-marker.md'],
]);

/** Scan the layout in a temp project folder and return the two response bodies. */
export function buildGolden() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'docs-golden-')));
  try {
    mkdirSync(join(root, 'system'), { recursive: true });
    writeFileSync(join(root, 'system', 'project.json'), '{"schemaVersion":1,"id":"golden"}\n');
    for (const [dest, fixture] of LAYOUT) {
      const abs = join(root, dest);
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(join(FIXTURE_DIR, fixture), abs);
    }
    const t = scanTemplatesPage(root);
    const c = scanCommandsPage(root);
    return {
      templates: { templates: t.templates, count: t.templates.length, truncated: t.truncated, scannedFolders: t.scannedFolders },
      commands: { commands: c.commands, count: c.commands.length, truncated: c.truncated, scannedFolders: c.scannedFolders },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The exact bytes of the golden file. */
export function goldenText() {
  return `${JSON.stringify(buildGolden(), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(GOLDEN_PATH, goldenText());
  console.log(`wrote ${GOLDEN_PATH}`);
}
