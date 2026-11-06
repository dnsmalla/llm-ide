#!/usr/bin/env node
// docs-kit K1b parity golden: the Node project-folder scan over the K1a
// project-marker fixtures, built into a temp project folder.
//
// Run `node scripts/docs-kit-parity-golden.mjs` to rewrite
// extension/tests/fixtures/docgen/server-scan.golden.json;
// extension/tests/docs-server-golden.test.mjs fails if the checked-in file is
// stale. (The fixtures and golden were vendored from the retired Swift app's
// tests, which ran the same scan on the Swift side.)

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCommandsPage, scanTemplatesPage } from '../extension/kb/doc-project-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The K1a fixtures. */
export const FIXTURE_DIR = join(here, '..', 'extension', 'tests', 'fixtures', 'docgen', 'project');
export const GOLDEN_PATH = join(here, '..', 'extension', 'tests', 'fixtures', 'docgen', 'server-scan.golden.json');

/**
 * The project both sides build, as [path inside project, fixture name].
 * The `auto_task` folder is in the layout to prove the scan skips it.
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
