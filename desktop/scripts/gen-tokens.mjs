#!/usr/bin/env node
// Generates desktop/src/design/tokens.css from the macOS app's ThemeTokens.swift + Theme.swift.
//
//   npm run tokens            write the file
//   npm run tokens -- --check exit 1 if the file on disk differs (drift guard)
//
// No dependencies. Parsing is regex-based over the known Theme.swift shapes;
// every role that cannot be parsed is a hard error, never a silent default.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLATFORM = resolve(here, "../../mac/Sources/LlmIdeMac/Core/Platform");
const THEME_SWIFT = resolve(PLATFORM, "Theme.swift"); // derived-colour aliases
const TOKENS_SWIFT = resolve(PLATFORM, "ThemeTokens.swift"); // palettes, scales, type
const OUT = resolve(here, "../src/design/tokens.css");

const THEME_IDS = ["dark", "light", "midnight"];
const COLOR_ROLES = [
  "body", "surface", "surface2", "border", "text", "textMuted",
  "accent", "accent2", "accent3", "accent4", "danger", "rowAlt", "gridLine",
];
const CATEGORY_ROLES = ["categoryPurple", "categoryTeal", "categoryAmber"];
const TEXT_STYLE_PT = {
  // macOS HIG text-style sizes; ThemeTokens.swift refers to these by style name only.
  largeTitle: 26, title: 22, title2: 17, title3: 15, headline: 13, body: 13,
  callout: 12, subheadline: 11, footnote: 10, caption: 10, caption2: 10,
};
const WEIGHT = { regular: 400, medium: 500, semibold: 600, bold: 700 };
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

function fail(msg) {
  throw new Error(`gen-tokens: ${msg}`);
}

const kebab = (s) => s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

const cssColor = ({ r, g, b, a }) =>
  a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;

/** `.rgb(r, g, b)` | `.white(a)` | `.black(a)` (ThemeTokens.Swatch) → {r,g,b,a}. */
function parseSwatch(expr, where) {
  let m = expr.match(/^\.rgb\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/);
  if (m) {
    return { r: Math.round(+m[1] * 255), g: Math.round(+m[2] * 255), b: Math.round(+m[3] * 255), a: 1 };
  }
  m = expr.match(/^\.(white|black)\(\s*([\d.]+)\s*\)$/);
  if (m) {
    const v = m[1] === "white" ? 255 : 0;
    return { r: v, g: v, b: v, a: +m[2] };
  }
  return fail(`cannot parse swatch in ${where}: ${expr}`);
}

function paletteBlock(src, id) {
  const re = new RegExp(`static let ${id} = Palette\\(([\\s\\S]*?)\\n    \\)`);
  const m = src.match(re);
  if (!m) fail(`no "static let ${id} = Palette(" block in ThemeTokens.swift`);
  return m[1];
}

/** Colour roles + category hues per theme, from ThemeTokens.swift palettes. */
function parseThemes(src) {
  const themes = {};
  const switches = Object.fromEntries(CATEGORY_ROLES.map((n) => [n, {}]));
  for (const id of THEME_IDS) {
    const block = paletteBlock(src, id).replace(/\/\/.*$/gm, "");
    const roles = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^\s+(\w+):\s*(.+?),?\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "id" || key === "name" || key === "isDark") continue;
      if (COLOR_ROLES.includes(key)) roles[key] = parseSwatch(value, `${id}.${key}`);
      else if (CATEGORY_ROLES.includes(key)) switches[key][id] = parseSwatch(value, `${id}.${key}`);
      else fail(`unexpected role "${key}" in palette "${id}"`);
    }
    const missing = [...COLOR_ROLES, ...CATEGORY_ROLES].filter(
      (r) => !roles[r] && !switches[r]?.[id],
    );
    if (missing.length) fail(`palette "${id}" is missing roles: ${missing.join(", ")}`);
    themes[id] = roles;
  }
  return { themes, switches };
}

/** Single-line derived colours: `var success: Color { accent3 }`, `… { success.opacity(0.16) }`. */
function parseAliases(src) {
  const out = [];
  for (const m of src.matchAll(/^\s*var (\w+): Color \{ (\w+)(?:\.opacity\(([\d.]+)\))? \}/gm)) {
    out.push({ name: m[1], ref: m[2], alpha: m[3] ? +m[3] : null });
  }
  if (!out.length) fail("no derived colour aliases found");
  return out;
}

function parseScale(src, valueName, structName) {
  const m = src.match(new RegExp(`static let ${valueName} = ${structName}\\(([\\s\\S]*?)\\n    \\)`));
  if (!m) fail(`no "static let ${valueName} = ${structName}("`);
  const out = [];
  for (const s of m[1].matchAll(/^\s+(\w+):\s*([\d.]+),?\s*$/gm)) {
    out.push({ name: s[1], value: +s[2] });
  }
  if (!out.length) fail(`${valueName} has no values`);
  return out;
}

function parseTypography(src) {
  const m = src.match(/static let typeScale = TypeScale\(([\s\S]*?)\n    \)/);
  if (!m) fail('no "static let typeScale = TypeScale("');
  const out = [];
  for (const line of m[1].split("\n")) {
    const decl = line.match(/^\s*(\w+):\s*TypeToken\((.*)\),?\s*$/);
    if (!decl) continue;
    const [, name, args] = decl;
    const size = args.match(/size: ([\d.]+)/);
    const style = args.match(/textStyle: \.(\w+)/);
    const w = args.match(/weight: \.(\w+)/);
    const weight = w ? w[1] : "regular";
    const mono = /monospaced: true/.test(args);
    let pt;
    if (size) pt = +size[1];
    else if (style) {
      if (!(style[1] in TEXT_STYLE_PT)) fail(`unknown text style "${style[1]}" in typeScale.${name}`);
      pt = TEXT_STYLE_PT[style[1]];
    } else fail(`typeScale.${name} has neither size nor textStyle`);
    if (!(weight in WEIGHT)) fail(`unknown weight "${weight}" in typeScale.${name}`);
    out.push({ name, size: pt, weight, mono });
  }
  if (!out.length) fail("typeScale has no entries");
  return out;
}

export function render(themeSrcRaw, tokensSrcRaw) {
  // Windows checkouts may convert line endings (core.autocrlf): parse on LF only.
  const themeSrc = themeSrcRaw.replace(/\r\n/g, "\n");
  const tokensSrc = tokensSrcRaw.replace(/\r\n/g, "\n");
  const { themes, switches } = parseThemes(tokensSrc);
  const aliases = parseAliases(themeSrc);
  const spacing = parseScale(tokensSrc, "spacing", "SpacingScale");
  const radius = parseScale(tokensSrc, "radius", "RadiusScale");
  const typo = parseTypography(tokensSrc);

  const lines = [];
  lines.push("/* GENERATED from mac/Sources/LlmIdeMac/Core/Platform/ThemeTokens.swift (+ Theme.swift aliases) — do not edit.");
  lines.push(" * Regenerate with: npm run tokens   (drift check: npm run tokens -- --check) */");
  lines.push("");
  lines.push(":root {");
  lines.push(`  --font-sans: ${SANS};`);
  lines.push(`  --font-mono: ${MONO};`);
  for (const s of spacing) lines.push(`  --space-${kebab(s.name)}: ${s.value}px;`);
  for (const r of radius) lines.push(`  --radius-${kebab(r.name)}: ${r.value}px;`);
  for (const t of typo) {
    const k = kebab(t.name);
    lines.push(`  --font-${k}-size: ${t.size}px;`);
    lines.push(`  --font-${k}-weight: ${WEIGHT[t.weight]};`);
    lines.push(`  --font-${k}-family: ${t.mono ? "var(--font-mono)" : "var(--font-sans)"};`);
  }
  lines.push("}");

  for (const id of THEME_IDS) {
    const roles = themes[id];
    lines.push("");
    lines.push(`:root[data-theme="${id}"] {`);
    for (const r of COLOR_ROLES) lines.push(`  --${kebab(r)}: ${cssColor(roles[r])};`);
    for (const [name, byTheme] of Object.entries(switches)) {
      lines.push(`  --${kebab(name)}: ${cssColor(byTheme[id])};`);
    }
    for (const a of aliases) {
      const isRole = a.ref in roles || aliases.some((x) => x.name === a.ref);
      if (!isRole) fail(`alias "${a.name}" refers to unknown "${a.ref}"`);
      const target = `var(--${kebab(a.ref)})`;
      const value = a.alpha === null
        ? target
        : `color-mix(in srgb, ${target} ${Math.round(a.alpha * 100)}%, transparent)`;
      lines.push(`  --${kebab(a.name)}: ${value};`);
    }
    lines.push("}");
  }
  return lines.join("\n") + "\n";
}

function main() {
// The generated file may also be CRLF on a Windows checkout: compare on LF only.
const lf = (t) => t.replace(/\r\n/g, "\n");
const css = render(readFileSync(THEME_SWIFT, "utf8"), readFileSync(TOKENS_SWIFT, "utf8"));
const check = process.argv.includes("--check");

if (check) {
  const current = existsSync(OUT) ? lf(readFileSync(OUT, "utf8")) : null;
  if (current !== css) {
    console.error(`tokens.css is stale: run "npm run tokens" (${OUT})`);
    process.exit(1);
  }
  console.log("tokens.css is up to date");
} else {
  writeFileSync(OUT, css);
  console.log(`wrote ${OUT}`);
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
