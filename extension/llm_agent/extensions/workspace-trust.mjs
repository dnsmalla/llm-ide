// Workspace trust gate (MASTER-PLAN Security, Tauri plan section 8).
//
// A project folder can carry executable config of its own: a `.mcp.json` that starts a local process, hooks in
// `.claude/settings*.json`, a project plugin, a project skill that ships scripts. Opening a repo must not be
// enough to run any of it. A folder is UNTRUSTED unless the user trusted that exact real path
// (kb/workspace-trust.mjs); user-level installed and consented items are never affected by this gate.
//
// What is enforced today, honestly:
//   - `.mcp.json` servers that start a process: withheld on a Claude turn (strictMcpConfig) in an untrusted folder.
//     The Claude CLI reads that file from the turn's cwd, so this is a real change.
//   - Project hooks, project plugins and project skill scripts: the engine already isolates project settings
//     (settingSources: []) and only mounts user-level plugins, so none of them ran. They are still DETECTED and
//     named in an info notice, so a user can see what the folder carries and trust it knowingly.
//   - A provider-adapter turn never read project config; same detection and info notice.
//
// Fail closed: for ANY untrusted folder (and any folder that cannot be resolved) a Claude turn ALWAYS runs
// strictMcpConfig, whatever detection found. Detection only drives the notice; a `.mcp.json` that is oversized,
// has a BOM, is unparseable, or sits in a PARENT directory is still withheld by strict mode (the CLI walks up).
// http/sse servers in that file are withheld too (an exfiltration channel); the user's own servers are passed
// explicitly and stay.
//
// LLMIDE_WORKSPACE_TRUST=off: nothing here runs and nothing changes. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceTrustEnabled } from './flags.mjs';
import { realFolder, isWorkspaceTrusted } from '../../kb/workspace-trust.mjs';

const MAX_JSON_BYTES = 262_144;
const MAX_ENTRIES = 50;

function readJson(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
/** @returns {{ state: 'absent' }|{ state: 'uninspected' }|{ state: 'ok', json: object }} for the file that matters most. */
function inspectMcpJson(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? { state: 'absent' } : { state: 'uninspected' }; }
  if (!st.isFile() || st.size > MAX_JSON_BYTES) return { state: 'uninspected' };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? { state: 'ok', json: v } : { state: 'uninspected' };
  } catch { return { state: 'uninspected' }; }
}
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name).sort(); } catch { return []; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const hasScripts = (dir) => {
  if (exists(path.join(dir, 'scripts'))) return true;
  try { return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && (fs.statSync(path.join(dir, e.name)).mode & 0o111) !== 0); } catch { return false; }
};
const hooksIn = (j) => !!j && typeof j.hooks === 'object' && j.hooks !== null && Object.keys(j.hooks).length > 0;

/**
 * What a project folder carries that could execute. Names only: never a command line, argument or env value.
 * @returns {Array<{ kind: 'mcp-stdio'|'mcp-remote'|'mcp-uninspected'|'hooks'|'plugin'|'skill-scripts', name: string, file: string, withheld: boolean }>}
 *   `withheld` is true for the kinds this gate actually removes from a Claude turn.
 */
export function detectProjectExecutables(root) {
  const out = [];
  if (!root) return out;
  const push = (e) => { if (out.length < MAX_ENTRIES) out.push(e); };

  // The folder's own .mcp.json and every ancestor's (the CLI reads parents too).
  const chain = [{ dir: root, rel: '.mcp.json' }];
  for (let d = path.dirname(root), n = 0; d && d !== path.dirname(d) && n < 12; d = path.dirname(d), n += 1) {
    chain.push({ dir: d, rel: `${path.relative(root, d) ? `${path.relative(root, d)}/` : ''}.mcp.json`.replace(/\\/g, '/') });
  }
  for (const { dir, rel } of chain) {
    const r = inspectMcpJson(path.join(dir, '.mcp.json'));
    if (r.state === 'uninspected') { push({ kind: 'mcp-uninspected', name: 'could not be inspected', file: rel, withheld: true }); continue; }
    if (r.state !== 'ok') continue;
    const servers = typeof r.json.mcpServers === 'object' && r.json.mcpServers && !Array.isArray(r.json.mcpServers) ? r.json.mcpServers : {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const stdio = typeof cfg.command === 'string' && cfg.command && (cfg.type === undefined || cfg.type === 'stdio');
      push({ kind: stdio ? 'mcp-stdio' : 'mcp-remote', name: String(name).slice(0, 64), file: rel, withheld: true });
    }
  }
  for (const f of ['settings.json', 'settings.local.json']) {
    const j = readJson(path.join(root, '.claude', f));
    if (hooksIn(j)) push({ kind: 'hooks', name: Object.keys(j.hooks).slice(0, 8).join(', ').slice(0, 120), file: `.claude/${f}`, withheld: false });
  }
  if (exists(path.join(root, '.claude-plugin', 'plugin.json'))) {
    push({ kind: 'plugin', name: '.claude-plugin', file: '.claude-plugin/plugin.json', withheld: false });
  }
  for (const n of dirs(path.join(root, '.claude', 'plugins'))) push({ kind: 'plugin', name: n.slice(0, 64), file: `.claude/plugins/${n}`, withheld: false });
  for (const n of dirs(path.join(root, '.claude', 'skills'))) {
    if (hasScripts(path.join(root, '.claude', 'skills', n))) push({ kind: 'skill-scripts', name: n.slice(0, 64), file: `.claude/skills/${n}`, withheld: false });
  }
  return out;
}

/**
 * The trust decision for one turn.
 * @returns {{ active: boolean, root: string|null, trusted: boolean, strict: boolean, restricted: boolean, detected: Array, withheld: Array }}
 *   `strict` is true for EVERY untrusted (or unresolvable) folder: the engine must pass strictMcpConfig.
 *   `restricted` is true only when something executable was found (it drives the notice).
 */
export function workspaceTrustForTurn(userId, workspaceRoot) {
  const none = { active: false, root: null, trusted: false, strict: false, restricted: false, detected: [], withheld: [] };
  if (!workspaceTrustEnabled() || !workspaceRoot || !userId) return none;
  try {
    const root = realFolder(workspaceRoot);
    if (!root) return { ...none, active: true, strict: true };
    const trusted = isWorkspaceTrusted(userId, root);
    if (trusted) return { ...none, active: true, root, trusted: true };
    const detected = detectProjectExecutables(root);
    return { active: true, root, trusted: false, strict: true, restricted: detected.length > 0, detected, withheld: detected.filter((d) => d.withheld) };
  } catch { return { ...none, active: true, strict: true }; }
}

const KIND_TEXT = { 'mcp-stdio': 'MCP server', 'mcp-remote': 'remote (http/sse) MCP server', 'mcp-uninspected': '.mcp.json that', hooks: 'hooks', plugin: 'plugin', 'skill-scripts': 'skill with scripts' };

/** The notice event for a restricted turn, or null. Warning only when something was actually withheld. */
export function workspaceTrustNotice(t) {
  if (!t?.restricted) return null;
  const names = t.detected.slice(0, 6).map((d) => `${KIND_TEXT[d.kind]} ${d.name}`).join(', ');
  const more = t.detected.length > 6 ? ` and ${t.detected.length - 6} more` : '';
  const skipped = t.withheld.length
    ? `This folder is not trusted, so its own executable config was not loaded: ${names}${more}.`
    : `This folder is not trusted. It carries executable config that is never loaded here: ${names}${more}.`;
  return {
    type: 'notice', kind: 'workspace_trust', level: t.withheld.length ? 'warning' : 'info',
    text: `${skipped} To use it, trust the folder in Settings (PUT /auth/me/workspace-trust).`.slice(0, 300),
    data: { path: t.root, trusted: false, skipped: t.detected.map((d) => ({ kind: d.kind, name: d.name, file: d.file, withheld: d.withheld })) },
  };
}
