// extension/mcp/codex-source.mjs
// Read-only scan of ~/.codex/config.toml's [mcp_servers.NAME] tables — the
// Codex counterpart to claude-source.mjs's ~/.claude.json scan. We NEVER
// write to this file; the codex CLI owns it. Uses core/toml-lite.mjs (a
// narrow TOML subset, not a full parser — see that file for what it
// supports: flat string/bool/array-of-strings/inline-table values only,
// which is exactly the shape `codex mcp add` produces).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseTomlLite } from '../core/toml-lite.mjs';

export function defaultCodexConfigPath() {
  return process.env.CODEX_CONFIG_PATH || join(homedir(), '.codex', 'config.toml');
}

export function scanCodexMcpServers(codexConfigPath) {
  const p = codexConfigPath || defaultCodexConfigPath();
  if (!existsSync(p)) return [];
  let config;
  try { config = parseTomlLite(readFileSync(p, 'utf8')); } catch { return []; }
  const servers = config?.mcp_servers;
  if (!servers || typeof servers !== 'object') return [];
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.command !== 'string') continue; // skip url-only entries, same as claude-source
    out.push({
      name,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string') : [],
      env: s.env && typeof s.env === 'object' ? s.env : undefined,
    });
  }
  return out;
}
