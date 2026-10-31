#!/usr/bin/env node
// Vendors the Lucide glyphs the kit uses into src/icons.generated.ts, so the shipped
// package has no runtime icon dependency. lucide-static is a pinned devDependency
// (ISC); its licence text is copied to LICENSES/lucide-ISC.txt.
//
//   node scripts/vendor-icons.mjs           write the files
//   node scripts/vendor-icons.mjs --check   exit 1 when they are stale
//
// To add an icon: add its Lucide name to ICONS below, run `npm run icons`, then
// export a component for it in src/icons.tsx.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LUCIDE = join(ROOT, 'node_modules/lucide-static');
const OUT = join(ROOT, 'src/icons.generated.ts');
const LICENSE_OUT = join(ROOT, 'LICENSES/lucide-ISC.txt');
const CHECK = process.argv.includes('--check');

export const ICONS = [
  'network', 'file-code', 'terminal', 'message-square', 'gauge', 'chevron-right', 'x',
  'panel-left', 'triangle-alert', 'info', 'house', 'search', 'refresh-cw', 'folder', 'bell',
  'plus', 'audio-waveform', 'code', 'table', 'file-text', 'puzzle', 'chart-column',
  'audio-lines', 'chevrons-right', 'message-circle', 'check', 'chevron-down',
  // Settings group headers (Mac SF Symbol -> nearest Lucide).
  'sliders-horizontal', 'hammer', 'server', 'plug', 'circle-arrow-down', 'smartphone', 'globe',
  'hand', 'package', 'leaf', 'key-round', 'repeat', 'hard-drive', 'rotate-ccw-clock', 'shield-check',
  'list-checks', 'stethoscope', 'brain', 'git-branch', 'folder-cog',
];

const lf = (t) => t.replace(/\r\n/g, '\n');
const version = JSON.parse(readFileSync(join(LUCIDE, 'package.json'), 'utf8')).version;
const nodes = JSON.parse(readFileSync(join(LUCIDE, 'icon-nodes.json'), 'utf8'));

const rows = ICONS.map((name) => {
  const n = nodes[name];
  if (!n) throw new Error(`vendor-icons: lucide-static ${version} has no icon "${name}"`);
  return `  ${JSON.stringify(name)}: ${JSON.stringify(n)},`;
});

const text = `// GENERATED - do not edit. Run \`npm run icons\` in ui/kit.
// Glyphs from Lucide (https://lucide.dev), lucide-static ${version}, ISC licence
// (LICENSES/lucide-ISC.txt). Each entry is a list of [tag, attributes] on a 24x24 grid.

export const LUCIDE_VERSION = ${JSON.stringify(version)};

export type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

export const ICON_NODES = {
${rows.join('\n')}
} as const satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICON_NODES;
`;
const license = lf(readFileSync(join(LUCIDE, 'LICENSE'), 'utf8'));

const outputs = [[OUT, text], [LICENSE_OUT, license]];
if (CHECK) {
  const stale = outputs.filter(([f, t]) => !existsSync(f) || lf(readFileSync(f, 'utf8')) !== t);
  if (stale.length) {
    console.error(`icons: stale ${stale.map(([f]) => f).join(', ')}`);
    process.exit(1);
  }
  console.log(`icons: ok (${ICONS.length} glyphs, lucide-static ${version})`);
} else {
  for (const [f, t] of outputs) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, t);
  }
  console.log(`wrote ${ICONS.length} glyphs (lucide-static ${version})`);
}
