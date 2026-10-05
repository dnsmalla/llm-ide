import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

const MANIFEST_RELS = ['.claude-plugin/plugin.json', 'plugin.json'];

function isExecutablePath(rel, mode) {
  return rel.startsWith('hooks/') || rel === 'hooks.json' || rel === '.mcp.json' || rel === '.lsp.json' || rel.startsWith('monitors/')
    || rel.endsWith('/.mcp.json') || rel.startsWith('bin/') || (mode & 0o111) !== 0;
}

function walk(root, rel, out) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue; // same policy as the loader
    if (entry.isDirectory()) { walk(root, childRel, out); continue; }
    if (!entry.isFile()) continue;
    const mode = lstatSync(join(root, childRel)).mode;
    if (isExecutablePath(childRel, mode)) out.push(childRel);
  }
}

/** JSON with object keys sorted, so key order alone never changes the hash. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Bytes of a manifest-named file when it resolves inside `dir`; escapes are ignored. */
function readInside(dir, rel) {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(join(dir, rel));
    if (!real.startsWith(root + sep)) return null;
    return readFileSync(real);
  } catch { return null; }
}

/** Executable-declaring manifest fields (same kinds the loader gates), plus any files they name. */
function manifestExecutableParts(dir, hash) {
  for (const rel of MANIFEST_RELS) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(dir, rel), 'utf8')); } catch { continue; }
    const fields = {
      hooks: manifest.hooks,
      mcpServers: manifest.mcpServers,
      monitors: manifest.monitors,
      'experimental.monitors': manifest.experimental?.monitors,
      lspServers: manifest.lspServers,
    };
    for (const key of Object.keys(fields).sort()) {
      const value = fields[key];
      if (value === undefined) continue;
      hash.update(`manifest:${key}\0${canonicalJson(value)}\0`);
      if (typeof value === 'string') {
        const bytes = readInside(dir, value);
        if (bytes) { hash.update(`file:${value}\0`); hash.update(bytes); hash.update('\0'); }
      }
    }
    return;
  }
}

/**
 * Hash the parts of a plugin that can run code: hooks, MCP configs, bin/ and
 * any execute-bit file, plus inline hooks/mcpServers in the manifest. Used to
 * decide when hook/MCP trust must be reset after an update.
 * Skill/command text is deliberately excluded.
 * @param {string} dir - Plugin directory
 * @returns {string} hex sha256 (hash of the empty list when nothing matches)
 */
export function hashExecutables(dir) {
  const files = [];
  walk(dir, '', files);
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(dir, rel)));
    hash.update('\0');
  }
  manifestExecutableParts(dir, hash);
  return hash.digest('hex');
}
