#!/usr/bin/env node
// Extracts `ChatSlashCommands.builtins` from the Mac source so the TypeScript port cannot drift from it.
//   node scripts/extract-chat-slash-builtins.mjs            prints the list as JSON
//   node scripts/extract-chat-slash-builtins.mjs --write F  writes it to F (the committed conformance fixture)
// The parser is string-aware (descriptions contain parentheses) and only understands the shapes the Swift list uses:
//   Builtin(label: "...", [aliases: ["..."],] description: "...", [insert: "...",] action: .case | .case(.arg))
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SWIFT_SOURCE = join(REPO, "mac/Sources/LlmIdeMac/Core/Editor/ChatSlashCommands.swift");

/** The text of the balanced `( ... )` starting at `open` (string-aware). */
function balanced(src, open) {
  let depth = 0, inStr = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error("unbalanced parentheses in the builtins list");
}

/** Splits `a: x, b: y` at top-level commas (not inside strings, brackets or parentheses). */
function topLevelArgs(body) {
  const parts = [];
  let depth = 0, inStr = false, cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { cur += c; if (c === "\\") { cur += body[++i]; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const unquote = (s) => { const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s.trim()); if (!m) throw new Error(`not a string literal: ${s}`); return JSON.parse(`"${m[1]}"`); };

export function extractBuiltins(swift = readFileSync(SWIFT_SOURCE, "utf8")) {
  const start = swift.indexOf("static let builtins: [Builtin] = [");
  if (start < 0) throw new Error("`static let builtins` not found in ChatSlashCommands.swift");
  const out = [];
  let i = swift.indexOf("[", start + "static let builtins: [Builtin]".length);
  const end = (() => { let d = 0, s = false; for (let k = i; k < swift.length; k++) { const c = swift[k]; if (s) { if (c === "\\") k++; else if (c === '"') s = false; continue; } if (c === '"') s = true; else if (c === "[") d++; else if (c === "]" && --d === 0) return k; } throw new Error("unterminated builtins array"); })();
  const body = swift.slice(i + 1, end).replace(/^\s*\/\/.*$/gm, "");
  for (let at = body.indexOf("Builtin("); at >= 0; at = body.indexOf("Builtin(", at + 1)) {
    const args = topLevelArgs(balanced(body, at + "Builtin".length));
    const o = { label: null, aliases: [], description: null, insert: null, action: null };
    for (const a of args) {
      const m = /^(\w+):\s*([\s\S]*)$/.exec(a);
      if (!m) throw new Error(`unexpected argument: ${a}`);
      const [, key, val] = m;
      if (key === "label") o.label = unquote(val);
      else if (key === "description") o.description = unquote(val);
      else if (key === "insert") o.insert = unquote(val);
      else if (key === "aliases") o.aliases = topLevelArgs(val.trim().slice(1, -1)).map(unquote);
      else if (key === "action") {
        const am = /^\.(\w+)(?:\(\.(\w+)\))?$/.exec(val.trim());
        if (!am) throw new Error(`unexpected action: ${val}`);
        o.action = am[2] ? { kind: am[1], section: am[2] } : { kind: am[1] };
      } else throw new Error(`unknown Builtin argument: ${key}`);
    }
    if (!o.label || o.description === null || !o.action) throw new Error(`incomplete Builtin: ${args.join(", ")}`);
    out.push({ label: o.label, aliases: o.aliases, description: o.description, insert: o.insert ?? o.label, action: o.action });
  }
  if (out.length === 0) throw new Error("no Builtin(...) entries parsed");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = extractBuiltins();
  const w = process.argv.indexOf("--write");
  if (w > 0) { writeFileSync(process.argv[w + 1], `${JSON.stringify(list, null, 2)}\n`); console.log(`wrote ${list.length} built-ins to ${process.argv[w + 1]}`); }
  else console.log(JSON.stringify(list, null, 2));
}
