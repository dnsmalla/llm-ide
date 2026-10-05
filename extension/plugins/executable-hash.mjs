import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_RELS = ['.claude-plugin/plugin.json', 'plugin.json'];

function isExecutablePath(rel, mode) {
  return rel.startsWith('hooks/') || rel === 'hooks.json' || rel === '.mcp.json'
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

/** Inline `hooks` / `mcpServers` declared by a vendor manifest, as stable JSON. */
function manifestExecutableFields(dir) {
  for (const rel of MANIFEST_RELS) {
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(dir, rel), 'utf8')); } catch { continue; }
    const picked = {};
    if (manifest.hooks !== undefined) picked.hooks = manifest.hooks;
    if (manifest.mcpServers !== undefined) picked.mcpServers = manifest.mcpServers;
    return Object.keys(picked).length ? JSON.stringify(picked) : null;
  }
  return null;
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
  const inline = manifestExecutableFields(dir);
  if (inline) hash.update(`manifest\0${inline}\0`);
  return hash.digest('hex');
}
