// What is in a fetched tree: its kind, name, members and the executable things
// it declares (plan section 5.1/7). Pure: takes Map<path, Buffer>, reads and
// executes nothing from disk. Nothing here is trusted; every name is validated
// and every JSON parse is guarded.

import { itemId, memberId, KINDS, EXECUTABLE_MEMBER_TYPES } from './model.mjs';

const MAX_MEMBERS = 500;
const MAX_NAME = 120;
const text = (buf) => buf.toString('utf8');

function json(files, path) {
  const buf = files.get(path);
  if (!buf) return undefined;
  try { const v = JSON.parse(text(buf)); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
}

/** `name` and `description` from the first `---` block. Good enough for a label; never evaluated. */
export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '').slice(0, 1536);
  }
  return out;
}

const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, MAX_NAME);

function addMember(members, type, name) {
  const n = cleanName(name);
  if (!n || members.length >= MAX_MEMBERS) return;
  let id;
  try { id = memberId(type, n); } catch { return; }
  if (!members.some((m) => m.memberId === id)) members.push({ memberId: id, type, name: n, executable: EXECUTABLE_MEMBER_TYPES.includes(type) });
}

function pluginMembers(files, base, manifest, members) {
  const under = (dir, ext) => [...files.keys()].filter((p) => p.startsWith(`${base}${dir}/`) && p.endsWith(ext) && !p.slice(base.length + dir.length + 1).includes('/'));
  for (const p of under('commands', '.md')) addMember(members, 'command', p.split('/').pop().replace(/\.md$/, ''));
  for (const p of under('agents', '.md')) addMember(members, 'agent', p.split('/').pop().replace(/\.md$/, ''));
  for (const p of files.keys()) {
    const sk = new RegExp(`^${base}skills/([^/]+)/SKILL\\.md$`).exec(p);
    if (sk) addMember(members, 'skill', frontmatter(text(files.get(p))).name || sk[1]);
  }
  // hooks: hooks/hooks.json or manifest.hooks (an object); one member per event name
  const hooks = json(files, `${base}hooks/hooks.json`)?.hooks ?? (manifest.hooks && typeof manifest.hooks === 'object' ? manifest.hooks : undefined);
  if (hooks && typeof hooks === 'object') for (const ev of Object.keys(hooks)) addMember(members, 'hook', ev);
  const mcp = json(files, `${base}.mcp.json`)?.mcpServers ?? (manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : undefined);
  if (mcp && typeof mcp === 'object') for (const s of Object.keys(mcp)) addMember(members, 'mcp', s);
  for (const p of files.keys()) if (p.startsWith(`${base}bin/`) && !p.slice(base.length + 4).includes('/')) addMember(members, 'bin', p.split('/').pop());
  if (files.has(`${base}.lsp.json`) || manifest.lspServers) addMember(members, 'lsp', 'lsp');
}

const PERMISSION_TEXT = {
  hook: 'Runs commands automatically when events happen in a session (hooks).',
  mcp: 'Starts or connects to MCP servers that can act on your behalf.',
  bin: 'Ships programs that can be run from the command line.',
  lsp: 'Declares language servers (programs).',
  skill: 'Adds instructions the assistant may follow (skills).',
  command: 'Adds slash commands (instructions).',
  agent: 'Adds sub-agent definitions (instructions).',
};

export function permissionSummary(members) {
  const types = [...new Set(members.map((m) => m.type))];
  return types.filter((t) => PERMISSION_TEXT[t]).sort((a, b) => Number(EXECUTABLE_MEMBER_TYPES.includes(b)) - Number(EXECUTABLE_MEMBER_TYPES.includes(a)))
    .map((t) => ({ type: t, executable: EXECUTABLE_MEMBER_TYPES.includes(t), text: PERMISSION_TEXT[t] }));
}

/**
 * @param {Map<string, Buffer>} files  paths relative to the item's root
 * @param {{ publisher: string, fallbackName: string }} o
 * @returns {{ ok: true, kind: string, id: string, name: string, version: string|null, description: string, members: object[], executableKinds: string[], permissions: object[] }
 *          | { ok: false, code: 'marketplace', entries: string[] } | { ok: false, code: 'nothing_installable' }}
 */
export function inspectTree(files, { publisher, fallbackName }) {
  const members = [];
  const pluginManifestPath = ['.claude-plugin/plugin.json', 'plugin.json', '.codex-plugin/plugin.json'].find((p) => files.has(p));
  if (pluginManifestPath) {
    const manifest = json(files, pluginManifestPath) ?? {};
    const name = cleanName(manifest.name) || fallbackName;
    pluginMembers(files, '', manifest, members);
    return done('plugin', name, manifest.version, manifest.description, members, publisher);
  }
  const market = json(files, '.claude-plugin/marketplace.json');
  if (market) {
    const entries = (Array.isArray(market.plugins) ? market.plugins : []).map((p) => cleanName(p?.name)).filter(Boolean).slice(0, 200);
    return { ok: false, code: 'marketplace', entries };
  }
  const skillPaths = [...files.keys()].filter((p) => p === 'SKILL.md' || /^skills\/[^/]+\/SKILL\.md$/.test(p) || /^[^/]+\/SKILL\.md$/.test(p));
  if (files.has('SKILL.md') && skillPaths.length === 1) {
    const fm = frontmatter(text(files.get('SKILL.md')));
    addMember(members, 'skill', fm.name || fallbackName);
    return done('skill', cleanName(fm.name) || fallbackName, null, fm.description, members, publisher);
  }
  if (skillPaths.length) {
    for (const p of skillPaths) addMember(members, 'skill', frontmatter(text(files.get(p))).name || p.split('/').slice(-2)[0]);
    return done('llm-source', fallbackName, null, '', members, publisher);
  }
  const server = json(files, 'server.json');
  if (server && typeof server.name === 'string') {
    addMember(members, 'mcp', server.name);
    return done('mcp', cleanName(server.name.split('/').pop()) || fallbackName, server.version, server.description, members, publisher);
  }
  return { ok: false, code: 'nothing_installable' };
}

function done(kind, name, version, description, members, publisher) {
  if (!KINDS.includes(kind)) return { ok: false, code: 'nothing_installable' };
  return {
    ok: true, kind, id: itemId(kind, publisher, name), name,
    version: typeof version === 'string' ? version.slice(0, 64) : null,
    description: typeof description === 'string' ? description.slice(0, 1536) : '',
    members,
    executableKinds: [...new Set(members.filter((m) => m.executable).map((m) => m.type))].sort(),
    permissions: permissionSummary(members),
  };
}
