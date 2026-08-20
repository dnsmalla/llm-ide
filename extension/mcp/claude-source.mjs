// extension/mcp/claude-source.mjs
// Read-only scan of ~/.claude.json mcpServers — the SP1 import source.
// We NEVER write to this file; Claude Code owns it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultClaudeJsonPath() {
  return process.env.CLAUDE_CONFIG_PATH || join(homedir(), '.claude.json');
}

export function scanClaudeMcpServers(claudeJsonPath) {
  const p = claudeJsonPath || defaultClaudeJsonPath();
  if (!existsSync(p)) return [];
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  // Keyed by name; the first writer wins, and top-level servers are scanned
  // first, so a user-scope entry always beats a same-named project one.
  const byName = new Map();
  const collect = (servers) => {
    if (!servers || typeof servers !== 'object') return;
    for (const [name, s] of Object.entries(servers)) {
      if (byName.has(name)) continue;
      if (!s || typeof s !== 'object') continue;
      if (typeof s.command !== 'string') continue; // skip http/url-only entries for SP1
      byName.set(name, {
        name,
        command: s.command,
        args: Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string') : [],
        env: s.env && typeof s.env === 'object' ? s.env : undefined,
      });
    }
  };
  collect(cfg?.mcpServers);
  // `claude mcp add` defaults to PROJECT scope, storing servers under
  // projects.<path>.mcpServers — many real installs have zero top-level
  // entries, which made this scan (and the Mac's "Add from Claude Code…"
  // submenu) permanently empty for them.
  const projects = cfg?.projects;
  if (projects && typeof projects === 'object') {
    for (const proj of Object.values(projects)) collect(proj?.mcpServers);
  }
  return [...byName.values()];
}
