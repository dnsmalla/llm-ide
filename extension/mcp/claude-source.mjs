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
  const servers = cfg?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.command !== 'string') continue; // skip http/url-only entries for SP1
    out.push({
      name,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string') : [],
      env: s.env && typeof s.env === 'object' ? s.env : undefined,
    });
  }
  return out;
}
