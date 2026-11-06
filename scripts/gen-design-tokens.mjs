#!/usr/bin/env node
// Generates the design-token outputs from schema/design/tokens.json:
//
//   schema/design/tokens.css                               CSS custom properties, one
//                                                           block per theme (Tauri)
//   extension/src/styles/tokens.generated.css              the same CSS, bundled by the
//                                                           side panel (Vite)
//   ui/kit/src/styles/tokens.generated.css                 the same CSS, shipped by the
//                                                           shared React package ui/kit
//                                                           (desktop and web)
//   ui/kit/src/themes.generated.ts                         theme ids/names for the kit's
//                                                           theme switcher (TypeScript)
//
//   node scripts/gen-design-tokens.mjs           write the files
//   node scripts/gen-design-tokens.mjs --check   exit 1 when a file is stale, or when
//                                                the source is malformed
//
// Output is deterministic, so --check is a plain byte comparison. The source
// lists every value; nothing here invents a value.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'schema/design/tokens.json');
const CSS_OUT = join(ROOT, 'schema/design/tokens.css');
const EXT_CSS_OUT = join(ROOT, 'extension/src/styles/tokens.generated.css');
const KIT_CSS_OUT = join(ROOT, 'ui/kit/src/styles/tokens.generated.css');
const KIT_THEMES_OUT = join(ROOT, 'ui/kit/src/themes.generated.ts');
const CHECK = process.argv.includes('--check');

// The colour roles every theme must define, in the order the Swift Palette lists them.
const ROLES = [
  'body', 'surface', 'surface2', 'border', 'text', 'textMuted',
  'accent', 'accent2', 'accent3', 'accent4', 'danger', 'rowAlt', 'gridLine',
  'categoryPurple', 'categoryTeal', 'categoryAmber',
];
const SPACING = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];
const RADIUS = ['sm', 'md', 'lg'];
const TYPE = [
  'display', 'title', 'section', 'body', 'bodyStrong', 'caption', 'captionStrong',
  'mono', 'filename', 'fileMeta', 'treeHeader', 'emptyTitle', 'emptyHint', 'button',
];
const WEIGHTS = { regular: 400, medium: 500, semibold: 600, bold: 700 };
const TEXT_STYLES = ['callout', 'caption'];
// Web fallback sizes for the platform text styles (macOS HIG point sizes), so a web
// surface paints the same size the Mac resolves from the style name.
const TEXT_STYLE_PX = { callout: 12, caption: 10 };
const SANS_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
const MONO_STACK = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

// ---------- validation ----------

function fail(msg) {
  throw new Error(`tokens.json: ${msg}`);
}

function exactKeys(obj, expected, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(`${where} must be an object`);
  const got = Object.keys(obj).sort();
  const want = [...expected].sort();
  if (got.join(',') !== want.join(',')) {
    fail(`${where} keys must be exactly ${want.join(', ')} (found ${got.join(', ')})`);
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isSize = (v) => isNum(v) && v >= 0 && v <= 1000;
// Theme ids become `static let <id>` in Swift; a keyword would not compile.
const SWIFT_RESERVED = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init',
  'inout', 'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static',
  'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do',
  'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while',
  'as', 'catch', 'false', 'is', 'nil', 'self', 'super', 'throw', 'throws', 'true', 'try', 'all', 'find',
]);

function checkSwatch(v, where) {
  if (!v || typeof v !== 'object') fail(`${where} must be an object`);
  const keys = Object.keys(v);
  if (keys.length !== 1) fail(`${where} must have exactly one of rgb, white, black`);
  const [kind] = keys;
  if (kind === 'rgb') {
    if (!Array.isArray(v.rgb) || v.rgb.length !== 3 || !v.rgb.every((x) => isNum(x) && x >= 0 && x <= 1)) {
      fail(`${where}.rgb must be three numbers in 0..1`);
    }
  } else if (kind === 'white' || kind === 'black') {
    if (!isNum(v[kind]) || v[kind] < 0 || v[kind] > 1) fail(`${where}.${kind} must be a number in 0..1`);
  } else {
    fail(`${where} has unknown colour kind "${kind}"`);
  }
}

function validate(src) {
  exactKeys(src, ['$comment', 'themes', 'spacing', 'radius', 'typography'], 'root');
  if (!Array.isArray(src.themes) || src.themes.length === 0) fail('themes must be a non-empty array');
  const ids = new Set();
  for (const t of src.themes) {
    exactKeys(t, ['id', 'name', 'isDark', 'colors'], `theme ${t.id}`);
    if (!/^[a-z][A-Za-z0-9]*$/.test(t.id)) fail(`theme id "${t.id}" must be a lowerCamel Swift identifier`);
    if (SWIFT_RESERVED.has(t.id)) fail(`theme id "${t.id}" is a Swift keyword`);
    if (ids.has(t.id)) fail(`duplicate theme id "${t.id}"`);
    ids.add(t.id);
    if (typeof t.name !== 'string' || typeof t.isDark !== 'boolean') fail(`theme ${t.id}: name/isDark malformed`);
    exactKeys(t.colors, ROLES, `theme ${t.id} colors`);
    for (const r of ROLES) checkSwatch(t.colors[r], `theme ${t.id}.${r}`);
  }
  exactKeys(src.spacing, SPACING, 'spacing');
  for (const k of SPACING) if (!isSize(src.spacing[k])) fail(`spacing.${k} must be a number in 0..1000`);
  exactKeys(src.radius, RADIUS, 'radius');
  for (const k of RADIUS) if (!isSize(src.radius[k])) fail(`radius.${k} must be a number in 0..1000`);
  exactKeys(src.typography, TYPE, 'typography');
  for (const k of TYPE) {
    const t = src.typography[k];
    const allowed = ['size', 'weight', 'monospaced', 'textStyle'];
    for (const key of Object.keys(t)) if (!allowed.includes(key)) fail(`typography.${k} has unknown key "${key}"`);
    if (t.size !== undefined && !(isSize(t.size) && t.size > 0)) fail(`typography.${k}.size must be a number in 1..1000`);
    if (t.weight !== undefined && !(t.weight in WEIGHTS)) fail(`typography.${k}.weight "${t.weight}" unknown`);
    if (t.textStyle !== undefined && !TEXT_STYLES.includes(t.textStyle)) fail(`typography.${k}.textStyle "${t.textStyle}" unknown`);
    if (t.size === undefined && t.textStyle === undefined) fail(`typography.${k} needs a size or a textStyle`);
    if (t.monospaced !== undefined && typeof t.monospaced !== 'boolean') fail(`typography.${k}.monospaced must be boolean`);
  }
}

// ---------- number formatting ----------

// Swift Double literal. JS prints the shortest round-tripping form, which is the
// literal the author wrote, so the Swift value equals the JSON value exactly.
const lit = (x) => String(x);

// CSS percentage of a 0..1 channel, rounded to 4 decimals (exact for the source values).
const pct = (x) => `${Number((x * 100).toFixed(4))}%`;

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// ---------- CSS ----------

function cssColour(v) {
  if (v.rgb) return `rgb(${v.rgb.map(pct).join(' ')})`;
  const kind = 'white' in v ? 'white' : 'black';
  const channel = kind === 'white' ? '100%' : '0%';
  const a = v[kind];
  const alpha = a === 1 ? '' : ` / ${pct(a)}`;
  return `rgb(${channel} ${channel} ${channel}${alpha})`;
}

function colourBlock(t) {
  return ROLES.map((r) => `  --tok-color-${kebab(r)}: ${cssColour(t.colors[r])};`).join('\n');
}

// `web` adds what a web surface needs beyond the legacy outputs (kept byte-identical
// so the committed System-view bundle stays valid): the sans family, a cross-platform
// mono stack, the platform text-style sizes, and an explicit weight for every role.
function generateCss(src, { web = false } = {}) {
  const defaultTheme = src.themes[0];
  const shared = [
    ...SPACING.map((k) => `  --tok-space-${k}: ${lit(src.spacing[k])}px;`),
    ...RADIUS.map((k) => `  --tok-radius-${k}: ${lit(src.radius[k])}px;`),
    ...(web
      ? [`  --tok-type-sans-family: ${SANS_STACK};`, `  --tok-type-mono-family: ${MONO_STACK};`]
      : ['  --tok-type-mono-family: ui-monospace, SFMono-Regular, Menlo, monospace;']),
  ];
  for (const k of TYPE) {
    const t = src.typography[k];
    const name = kebab(k);
    if (t.size !== undefined) {
      shared.push(`  --tok-type-${name}-size: ${lit(t.size)}px;`);
    } else if (web) {
      shared.push(`  --tok-type-${name}-size: ${TEXT_STYLE_PX[t.textStyle]}px; /* platform ${t.textStyle} text style */`);
    }
    if (t.weight !== undefined || web) {
      shared.push(`  --tok-type-${name}-weight: ${WEIGHTS[t.weight ?? 'regular']};`);
    }
    if (t.size === undefined && !web) {
      shared.push(`  /* ${name}: platform ${t.textStyle} text style, no fixed size */`);
    }
  }
  const blocks = [
    `:root {\n  /* default theme: ${defaultTheme.id} */\n${colourBlock(defaultTheme)}\n${shared.join('\n')}\n}`,
    ...src.themes.map((t) => `:root[data-theme="${t.id}"] {\n${colourBlock(t)}\n}`),
  ];
  return `/* GENERATED - do not edit.
 * Source: schema/design/tokens.json
 * Regenerate with \`node scripts/gen-design-tokens.mjs\` (or \`make design-tokens\`).
 * Check with \`node scripts/gen-design-tokens.mjs --check\` (part of \`make contract-gates\`).
 *
 * :root holds the default theme's colours and the theme-independent tokens
 * (spacing, radius, type). Each [data-theme="<id>"] block overrides only the
 * colours. Colour values are written as rgb() percentages so they carry the
 * exact authored components. Variables are prefixed --tok- so they cannot
 * collide with a stylesheet's own names.
 */
${blocks.join('\n\n')}
`;
}

// ---------- TypeScript themes ----------

function generateThemesTs(src) {
  const rows = src.themes
    .map((t) => `  { id: ${JSON.stringify(t.id)}, label: ${JSON.stringify(t.name)}, isDark: ${t.isDark} },`)
    .join('\n');
  return `// GENERATED - do not edit.
// Source: schema/design/tokens.json
// Regenerate with \`node scripts/gen-design-tokens.mjs\` (or \`make design-tokens\`).

export const THEMES = [
${rows}
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
`;
}

// ---------- main ----------

export function loadSource(text = readFileSync(SOURCE, 'utf8')) {
  // A Windows checkout may carry CRLF; JSON.parse accepts it, but be explicit.
  const src = JSON.parse(text.replace(/\r\n/g, '\n'));
  validate(src);
  return src;
}

export { generateCss, generateThemesTs, validate };

function buildOutputs(src) {
  return [
    { file: CSS_OUT, text: generateCss(src) },
    { file: EXT_CSS_OUT, text: generateCss(src) },
    { file: KIT_CSS_OUT, text: generateCss(src, { web: true }) },
    { file: KIT_THEMES_OUT, text: generateThemesTs(src) },
  ];
}

function main() {
  const src = loadSource();
  const outputs = buildOutputs(src);
  // Generated files may be CRLF on a Windows checkout (core.autocrlf): compare on LF only.
  const lf = (t) => t.replace(/\r\n/g, '\n');
  if (CHECK) {
    const problems = [];
    for (const { file, text } of outputs) {
      const current = existsSync(file) ? lf(readFileSync(file, 'utf8')) : '';
      if (current !== text) {
        problems.push(`${relative(ROOT, file)} is stale; run node scripts/gen-design-tokens.mjs`);
      }
    }
    if (problems.length) {
      console.error(`design-tokens: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`design-tokens: ok (${src.themes.length} themes, ${outputs.length} outputs)`);
  } else {
    for (const { file, text } of outputs) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(`wrote ${relative(ROOT, file)}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
