#!/usr/bin/env node
// Mechanical Mac-vs-desktop parity inventory. Pulls every user-visible literal out of the Swift views
// (buttons, menus, toggles, fields, section titles, help tooltips, alerts, shortcuts, static text) and looks
// for each one in the matching desktop source. It cannot judge behaviour; it finds what is NOT there at all.
//
//   node scripts/parity-inventory.mjs [area ...]      areas: chat loop autotask ... (default: all)
//   node scripts/parity-inventory.mjs chat --md       markdown report on stdout
//   node scripts/parity-inventory.mjs chat --json     machine-readable
//
// Matching is a normalised substring test (case, whitespace and ellipsis forms folded), so "Save…" matches
// `Save...`. A hit proves the label exists in desktop code, not that it behaves like the Mac; a miss is a
// real gap or a deliberate rename to review. Strings with interpolation are matched on their longest literal
// fragment. Known limits: labels built at runtime, localisation tables and asset names are not seen.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const F = "mac/Sources/LlmIdeMac/Features";

/** area -> Swift dirs (under Features, or repo-relative) and desktop dirs that may hold the equivalent. */
export const AREAS = {
  explorer: { swift: [`${F}/Explorer`, `${F}/Search`, `${F}/SourceControl`, `${F}/Terminal`], desktop: ["ui/screens/explorer"] },
  chat: { swift: [`${F}/Chat`], desktop: ["ui/screens/chat", "ui/kit/src"] },
  library: { swift: [`${F}/Library`], desktop: ["ui/screens/library", "ui/kit/src"] },
  extensions: { swift: [`${F}/Extensions`], desktop: ["ui/screens/library", "ui/kit/src"] },
  docgen: { swift: [`${F}/Generation`], desktop: ["ui/screens/docgen", "ui/kit/src"] },
  graph: { swift: [`${F}/CodeGraph`], desktop: ["ui/screens/graph", "ui/kit/src"] },
  issues: { swift: [`${F}/Issues`, `${F}/ReviewConflicts`], desktop: ["ui/screens/issues", "ui/screens/gantt", "ui/screens/review", "ui/kit/src"] },
  loop: { swift: [`${F}/Loop`], desktop: ["ui/screens/loop", "ui/kit/src"] },
  autotask: { swift: [`${F}/AutoTask`], desktop: ["ui/screens/autotasks", "ui/screens/loop", "ui/kit/src"] },
  settings: { swift: [`${F}/Settings`], desktop: ["ui/screens/settings", "ui/screens/shell", "ui/kit/src"] },
  shell: { swift: ["mac/Sources/LlmIdeMac/Shell"], desktop: ["ui/screens/shell", "ui/screens/welcome", "ui/screens/settings", "desktop/src-tauri/src/menu.rs", "ui/kit/src"] },
};

const walk = (d, ok, out = []) => {
  let es;
  try { es = readdirSync(d); } catch { return out; }
  for (const e of es) {
    if (e === "node_modules" || e === ".build" || e === "tests" || e === "dist") continue;
    const p = join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, ok, out);
    else if (ok(p)) out.push(p);
  }
  return out;
};

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const CTRL = ["Button", "Toggle", "Menu", "Picker", "TextField", "SecureField", "TextEditor", "Label", "Section", "DisclosureGroup", "Link", "NavigationLink", "GroupBox", "Stepper", "Slider", "Tab", "ContentUnavailableView", "ProgressView"];
const MODS = ["help", "navigationTitle", "alert", "confirmationDialog", "accessibilityLabel", "accessibilityHint", "accessibilityValue", "prompt", "placeholder", "badge"];
const PATTERNS = [
  ...CTRL.map((k) => ({ kind: k.toLowerCase(), re: new RegExp(String.raw`\b${k}\(\s*${STR}`, "g") })),
  ...MODS.map((k) => ({ kind: k, re: new RegExp(String.raw`\.${k}\(\s*${STR}`, "g") })),
  { kind: "text", re: new RegExp(String.raw`\bText\(\s*${STR}\s*\)`, "g") },
  { kind: "shortcut", re: /\.keyboardShortcut\(\s*([^)]*)\)/g, raw: true },
];

/** Swift literal -> comparable fragment. Returns {text, dynamic}. */
function literal(s) {
  const unescaped = s.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\t/g, " ");
  if (!unescaped.includes("\\(")) return { text: unescaped, dynamic: false };
  // Interpolated: keep the longest literal fragment between \( ... ) groups.
  const frags = unescaped.split(/\\\([^)]*\)/).map((x) => x.trim()).filter(Boolean);
  frags.sort((a, b) => b.length - a.length);
  return { text: frags[0] ?? "", dynamic: true };
}

export const norm = (s) =>
  s.toLowerCase().replace(/[…]/g, "...").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\\u\{[0-9a-f]+\}/gi, "").replace(/\s+/g, " ").replace(/[.:!]+\s*$/g, "").trim();

export function extractSwift(file) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const lineAt = (idx) => src.slice(0, idx).split("\n").length;
  const items = [];
  for (const { kind, re, raw } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      if (lines[lineAt(m.index) - 1].trimStart().startsWith("//")) continue;
      if (raw) {
        items.push({ kind, text: m[1].replace(/\s+/g, " ").trim(), dynamic: false, line: lineAt(m.index), shortcut: true });
        continue;
      }
      const { text, dynamic } = literal(m[1]);
      if (text.length < 3 || /^[\W\d_]+$/.test(text)) continue; // punctuation, numbers, SF symbol-ish noise
      if (/^[a-z]+(\.[a-z]+)+$/i.test(text) && kind !== "text") continue; // "sidebar.left" symbol names
      items.push({ kind, text, dynamic, line: lineAt(m.index), file: undefined });
    }
  }
  return items;
}

/** exact: the label is a whole string literal or JSX text node (quote/backtick/angle bracket on both sides).
 *  loose: it appears only inside a longer sentence. Short labels ("Run") are only trusted when exact. */
export function matchKind(corpus, label) {
  const n = norm(label);
  if (!n) return "none";
  let loose = false;
  for (let i = corpus.indexOf(n); i !== -1; i = corpus.indexOf(n, i + 1)) {
    const before = corpus[i - 1] ?? " ";
    const edge = (c) => c === '"' || c === "'" || c === "`" || c === ">" || c === "<" || c === "{" || c === "}";
    let j = i + n.length;
    while (/[.:!?]/.test(corpus[j] ?? "")) j += 1; // "Save…" is stored as "save..."; the label's own trailing marks were folded away
    if (edge(before) && edge(corpus[j] ?? " ")) return "exact";
    if (n.length >= 14 || /\s/.test(n)) loose = true;
  }
  return loose ? "loose" : "none";
}

export function buildCorpus(paths) {
  const files = paths.flatMap((p) => {
    const abs = join(REPO, p);
    try {
      return statSync(abs).isDirectory() ? walk(abs, (f) => /\.(tsx?|mjs|css|rs)$/.test(f) && !/\.test\./.test(f)) : [abs];
    } catch { return []; }
  });
  return norm(files.map((f) => readFileSync(f, "utf8")).join("\n"));
}

export function inventory(area) {
  const cfg = AREAS[area];
  if (!cfg) throw new Error(`unknown area: ${area} (known: ${Object.keys(AREAS).join(", ")})`);
  const corpus = buildCorpus(cfg.desktop);
  const swiftFiles = cfg.swift.flatMap((d) => walk(join(REPO, d), (f) => f.endsWith(".swift")));
  const seen = new Map();
  for (const f of swiftFiles) {
    for (const it of extractSwift(f)) {
      if (it.shortcut) { it.found = true; }
      const key = `${it.kind}|${norm(it.text)}`;
      const rel = relative(REPO, f);
      const entry = seen.get(key);
      if (entry) { entry.sites.push(`${rel}:${it.line}`); continue; }
      const how = it.shortcut ? null : matchKind(corpus, it.text);
      seen.set(key, { ...it, sites: [`${rel}:${it.line}`], how, found: it.shortcut ? null : how !== "none" });
    }
  }
  const items = [...seen.values()].map(({ file, line, ...rest }) => rest);
  const real = items.filter((i) => i.found !== null);
  const missing = real.filter((i) => !i.found);
  const exact = real.filter((i) => i.how === "exact").length;
  return {
    area, swiftFiles: swiftFiles.length, unique: real.length, found: real.length - missing.length, exact,
    missing, shortcuts: items.filter((i) => i.found === null).map((i) => ({ text: i.text, sites: i.sites })),
    byKind: Object.fromEntries([...new Set(real.map((i) => i.kind))].sort().map((k) => [k, {
      total: real.filter((i) => i.kind === k).length, missing: missing.filter((i) => i.kind === k).length,
    }])),
  };
}

function markdown(r) {
  const pct = r.unique ? Math.round((r.exact / r.unique) * 100) : 100;
  const out = [`## ${r.area}: ${r.exact}/${r.unique} Swift labels exact in desktop code (${pct}%), ${r.found - r.exact} only inside a longer sentence, ${r.missing.length} missing`, "",
    `Swift files scanned: ${r.swiftFiles}. Shortcuts in Swift (not machine-matched): ${r.shortcuts.length}.`, "",
    "| kind | total | missing |", "|---|---|---|",
    ...Object.entries(r.byKind).map(([k, v]) => `| ${k} | ${v.total} | ${v.missing} |`), "", "### Missing", ""];
  for (const i of r.missing) out.push(`- [${i.kind}] ${JSON.stringify(i.text)}${i.dynamic ? " (interpolated; longest fragment)" : ""} - ${i.sites[0]}${i.sites.length > 1 ? ` (+${i.sites.length - 1})` : ""}`);
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const areas = args.filter((a) => !a.startsWith("--"));
  const list = areas.length ? areas : Object.keys(AREAS);
  const results = list.map(inventory);
  if (flags.has("--json")) console.log(JSON.stringify(results, null, 1));
  else if (flags.has("--md")) console.log(results.map(markdown).join("\n\n"));
  else for (const r of results) console.log(`${r.area.padEnd(11)} exact ${String(r.exact).padStart(4)}  in-sentence ${String(r.found - r.exact).padStart(3)}  missing ${String(r.missing.length).padStart(4)}  of ${String(r.unique).padEnd(4)} labels (${r.swiftFiles} swift files, ${r.shortcuts.length} shortcuts)`);
}
