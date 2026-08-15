// Narrow TOML-SUBSET parser — NOT a general TOML parser. Written specifically
// to read `~/.codex/config.toml` (plugins/codex-adapter.mjs, mcp/codex-source.mjs)
// without adding a TOML dependency for two small, well-known read paths.
//
// Supports exactly:
//   - `[section]`, `[section.sub]`, `[section."quoted key"]` headers (dotted
//     path, each segment optionally double-quoted — enough for config.toml's
//     `[marketplaces.NAME]`, `[plugins."name@marketplace"]`, `[projects."/abs/path"]`)
//   - `key = "string"`, `key = true|false`
//   - `key = ["a", "b"]` — flat arrays of double-quoted strings only
//   - `key = { K = "v", K2 = "v2" }` — flat inline tables of string values only
//   - `#` comments (outside quotes)
//
// Deliberately UNSUPPORTED (silently skipped, never mis-parsed as something
// else): multi-line/literal strings, numbers, dates, nested arrays/tables,
// array-of-tables (`[[x]]`), escaped quotes inside strings. None of these
// appear in the config.toml sections this repo actually reads.
export function parseTomlLite(text) {
  const root = {};
  let current = root;
  for (const raw of String(text).split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = navigateSection(root, section[1]);
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue; // unsupported line shape — skip rather than guess
    const [, key, rawValue] = kv;
    current[key] = parseValue(rawValue.trim());
  }
  return root;
}

function stripComment(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === '#' && !inQuotes) return line.slice(0, i);
  }
  return line;
}

// Splits a section-header path on `.`, treating a double-quoted segment as
// opaque (its own dots/slashes never split it). Quote characters themselves
// are stripped from the returned segment.
function splitSectionPath(s) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === '.' && !inQuotes) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function navigateSection(root, pathStr) {
  let node = root;
  for (const part of splitSectionPath(pathStr)) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  return node;
}

// Splits an inline-table body on top-level commas (not inside a quoted string).
function splitTopLevelCommas(s) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
  }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const out = {};
    const inner = raw.slice(1, -1).trim();
    if (!inner) return out;
    for (const pair of splitTopLevelCommas(inner)) {
      const m = pair.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }
  return raw; // unsupported type (number/date/etc.) — return the raw token
}
