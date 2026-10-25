#!/usr/bin/env node
// Generates desktop/src/design/tokens.css from the macOS app's Theme.swift.
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
const THEME_SWIFT = resolve(here, "../../mac/Sources/LlmIdeMac/Core/Platform/Theme.swift");
const OUT = resolve(here, "../src/design/tokens.css");

const THEME_IDS = ["dark", "light", "midnight"];
const COLOR_ROLES = [
  "body", "surface", "surface2", "border", "text", "textMuted",
  "accent", "accent2", "accent3", "accent4", "danger", "rowAlt", "gridLine",
];
const TEXT_STYLE_PT = {
  // macOS HIG text-style sizes; Theme.swift refers to these by style name only.
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

/** Parses `Color(red:, green:, blue:)` or `Color.white|black.opacity(a)` → {r,g,b,a}. */
function parseColor(expr, where) {
  let m = expr.match(/^Color\(red:\s*([\d.]+),\s*green:\s*([\d.]+),\s*blue:\s*([\d.]+)\)$/);
  if (m) {
    return { r: Math.round(+m[1] * 255), g: Math.round(+m[2] * 255), b: Math.round(+m[3] * 255), a: 1 };
  }
  m = expr.match(/^Color\.(white|black)(?:\.opacity\(([\d.]+)\))?$/);
  if (m) {
    const v = m[1] === "white" ? 255 : 0;
    return { r: v, g: v, b: v, a: m[2] === undefined ? 1 : +m[2] };
  }
  return fail(`cannot parse colour in ${where}: ${expr}`);
}

const cssColor = ({ r, g, b, a }) =>
  a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;

function themeBlock(src, id) {
  const re = new RegExp(`static let ${id} = Theme\\(([\\s\\S]*?)\\n    \\)`);
  const m = src.match(re);
  if (!m) fail(`no "static let ${id} = Theme(" block`);
  return m[1];
}

function parseThemes(src) {
  const out = {};
  for (const id of THEME_IDS) {
    const block = themeBlock(src, id).replace(/\/\/.*$/gm, "");
    const roles = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^\s+(\w+):\s*(.+?),?\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "id" || key === "name" || key === "isDark") continue;
      if (!COLOR_ROLES.includes(key)) fail(`unexpected role "${key}" in theme "${id}"`);
      roles[key] = parseColor(value.replace(/,\s*$/, ""), `${id}.${key}`);
    }
    const missing = COLOR_ROLES.filter((r) => !roles[r]);
    if (missing.length) fail(`theme "${id}" is missing roles: ${missing.join(", ")}`);
    out[id] = roles;
  }
  return out;
}

/** `var categoryPurple: Color { switch id { case "light": …; default: … } }` per theme. */
function parseSwitchColors(src) {
  const names = ["categoryPurple", "categoryTeal", "categoryAmber"];
  const out = {};
  for (const name of names) {
    const m = src.match(new RegExp(`var ${name}: Color \\{([\\s\\S]*?)\\n    \\}`));
    if (!m) fail(`no computed colour "${name}"`);
    const body = m[1].replace(/\/\/.*$/gm, "");
    const perTheme = {};
    for (const c of body.matchAll(/case "(\w+)":\s*return (Color[^\n]*?\))\s*$/gm)) {
      perTheme[c[1]] = parseColor(c[2], `${name}.${c[1]}`);
    }
    const d = body.match(/default:\s*return (Color[^\n]*?\))\s*$/m);
    if (!d) fail(`"${name}" has no default case`);
    perTheme.default = parseColor(d[1], `${name}.default`);
    for (const id of ["light", "midnight"]) {
      if (!perTheme[id]) fail(`"${name}" has no case "${id}"`);
    }
    out[name] = {
      dark: perTheme.default,
      light: perTheme.light,
      midnight: perTheme.midnight,
    };
  }
  return out;
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

function parseSpacing(src, enumName) {
  const m = src.match(new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) fail(`no enum ${enumName}`);
  const out = [];
  for (const s of m[1].matchAll(/static let (\w+): CGFloat = ([\d.]+)/g)) {
    out.push({ name: s[1], value: +s[2] });
  }
  if (!out.length) fail(`enum ${enumName} has no CGFloat values`);
  return out;
}

function parseTypography(src) {
  const m = src.match(/enum Typography \{([\s\S]*?)\n\}/);
  if (!m) fail("no enum Typography");
  const out = [];
  for (const line of m[1].split("\n")) {
    const decl = line.match(/^\s*static let (\w+)\s*=\s*(.+?)\s*$/);
    if (!decl) continue;
    const [, name, expr] = decl;
    let size;
    let weight = "regular";
    let mono = false;
    let s = expr.match(/^Font\.system\(size: (\d+)(.*)\)$/);
    if (s) {
      size = +s[1];
      const w = s[2].match(/weight: \.(\w+)/);
      if (w) weight = w[1];
      mono = /design: \.monospaced/.test(s[2]);
    } else {
      s = expr.match(/^Font\.(\w+)(?:\.weight\(\.(\w+)\))?$/);
      if (!s) fail(`cannot parse Typography.${name}: ${expr}`);
      if (!(s[1] in TEXT_STYLE_PT)) fail(`unknown text style "${s[1]}" in Typography.${name}`);
      size = TEXT_STYLE_PT[s[1]];
      if (s[2]) weight = s[2];
    }
    if (!(weight in WEIGHT)) fail(`unknown weight "${weight}" in Typography.${name}`);
    out.push({ name, size, weight, mono });
  }
  if (!out.length) fail("enum Typography has no entries");
  return out;
}

function render(src) {
  const themes = parseThemes(src);
  const switches = parseSwitchColors(src);
  const aliases = parseAliases(src);
  const spacing = parseSpacing(src, "Spacing");
  const radius = parseSpacing(src, "Radius");
  const typo = parseTypography(src);

  const lines = [];
  lines.push("/* GENERATED from mac/Sources/LlmIdeMac/Core/Platform/Theme.swift — do not edit.");
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

const src = readFileSync(THEME_SWIFT, "utf8");
const css = render(src);
const check = process.argv.includes("--check");

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  if (current !== css) {
    console.error(`tokens.css is stale: run "npm run tokens" (${OUT})`);
    process.exit(1);
  }
  console.log("tokens.css is up to date");
} else {
  writeFileSync(OUT, css);
  console.log(`wrote ${OUT}`);
}
