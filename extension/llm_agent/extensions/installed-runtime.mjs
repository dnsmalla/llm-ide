// Installed catalog items, as the turn builders consume them (plan section 5.3).
//
// install.mjs puts bytes in a per-user store and records the item switched OFF;
// this module turns the items a user has switched ON into what each consumer
// already understands:
//
//   plugin        a loader plugin object (skills, commands, agents, hooks) that the
//                 SDK plugin delivery and the per-user skill set iterate beside the
//                 legacy registry, plus the servers its `.mcp.json` declares
//   skill         library entries (the '/' menu, load-skill)
//   llm-source    library entries, one per skill of the bundle
//   mcp           one server from a registry `server.json` (a remote only; a package
//                 that would need `npx`/`uvx` at turn time is not launched)
//
// Rules, all fail-closed and all re-read every turn, so a switched-off or
// uninstalled item is gone from the next turn:
//
//  - nothing loads without a gate (LLMIDE_EXT_ACTIVE_SET on, or a caller that
//    forces one: the active set and the provider adapter) and never when the
//    catalog is switched off (LLMIDE_EXT_CATALOG=off);
//  - the item must be explicitly enabled in the overlay, with no entry switching
//    it off, and the overlay and the installed record must both be readable;
//  - every executable kind the item declares (hook, mcp, lsp, bin) must carry a
//    consent recorded for THIS pinned commit;
//  - the bytes must still be a real directory inside this user's own store (no
//    symbolic link, nothing outside), and a plugin must be named like its item;
//  - a plugin whose name a legacy plugin already owns is skipped (legacy wins);
//  - a member the user unchecked is absent (the unchecked-set rule).
//
// MCP configs from a third party are built conservatively: `${CLAUDE_PLUGIN_ROOT}`
// in the command and arguments becomes the item's own directory; an env or header
// value that still holds a `${...}` placeholder is dropped (never expanded from the
// host environment); an http(s) server must be https and name a public-looking
// host. Nothing is started here; every call is approved by the user.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { catalogEnabled } from './flags.mjs';
import { readOverlay } from './store.mjs';
import { readInstalled, itemStoreDir, userStoreDir } from './installed.mjs';
import { parseItemId } from './model.mjs';
import { frontmatter } from './inspect.mjs';
import { loadPluginAt } from '../../plugins/loader.mjs';

const MAX_SKILLS_PER_ITEM = 200;
const MAX_SERVERS_PER_ITEM = 16;
const SKILL_MD_MAX_BYTES = 256 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

// What the loader calls an executable kind, in the words a consent uses.
const LOADER_TO_CONSENT = { hooks: 'hook', lsp: 'lsp', bin: 'bin' };

const EMPTY = Object.freeze({ plugins: [], skills: [], mcp: [], items: [], warnings: [] });

const pluginCache = new Map();
export function _resetInstalledRuntimeForTests() { pluginCache.clear(); }
/** Drop parsed plugins: call after bytes under a store directory were replaced. */
export function clearInstalledRuntimeCache() { pluginCache.clear(); }

const mcpId = (...parts) => {
  const raw = parts.join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const id = raw.slice(0, 40).replace(/-+$/, '');
  return SLUG_RE.test(id) ? id : null;
};

/** Consent kinds the item declares that no consent for THIS commit covers. */
export function missingConsents(rec) {
  const need = Array.isArray(rec?.declared?.executableKinds) ? rec.declared.executableKinds : [];
  return need.filter((k) => rec.consents?.[k]?.commit !== rec.pinnedCommit);
}

function safeDir(userId, id, rec) {
  if (typeof rec.pinnedCommit !== 'string' || !SHA_RE.test(rec.pinnedCommit)) return null;
  const dir = join(itemStoreDir(userId, id), rec.pinnedCommit);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    const root = realpathSync(userStoreDir(userId));
    const real = realpathSync(dir);
    return real.startsWith(root + sep) ? dir : null;
  } catch { return null; }
}

function loadPluginCached(dir) {
  if (pluginCache.has(dir)) return pluginCache.get(dir);
  const r = loadPluginAt(dir);
  const out = r.error ? { error: r.error } : { plugin: r.plugin, warnings: r.warnings ?? [] };
  pluginCache.set(dir, out);
  return out;
}

function underDir(dir, rel) {
  try {
    return readdirSync(join(dir, rel), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort();
  } catch { return []; }
}

/** SKILL.md files of a skill or a bundle, in the shapes inspect.mjs recognises. */
function skillEntriesOf(dir, rec) {
  const found = [];
  const add = (rel, dirName) => found.push({ file: join(dir, rel), dirName });
  if (rec.kind === 'skill') { if (existsSync(join(dir, 'SKILL.md'))) add('SKILL.md', rec.name); return found; }
  for (const d of underDir(dir, 'skills')) if (existsSync(join(dir, 'skills', d, 'SKILL.md'))) add(join('skills', d, 'SKILL.md'), d);
  for (const d of underDir(dir, '')) if (d !== 'skills' && existsSync(join(dir, d, 'SKILL.md'))) add(join(d, 'SKILL.md'), d);
  return found;
}

function readSkill(file, dirName) {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > SKILL_MD_MAX_BYTES) return null;
    const fm = frontmatter(readFileSync(file, 'utf8'));
    const name = (fm.name || dirName || '').trim();
    return name ? { name, description: (fm.description || '').slice(0, 200) } : null;
  } catch { return null; }
}

function publicHttps(u) {
  let url;
  try { url = new URL(String(u)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const h = url.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost|lan|home)$/.test(h) || /^[\d.]+$/.test(h) || h.startsWith('[')) return null;
  return url.toString();
}

const hasPlaceholder = (v) => typeof v === 'string' && v.includes('${');

function cleanMap(obj, root) {
  const out = {};
  for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    if (typeof v !== 'string') continue;
    const value = v.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
    if (hasPlaceholder(value)) continue;
    out[k] = value;
  }
  return out;
}

/** The SDK/adapter `mcpServers` entry for one declared server, or null when it cannot be built safely. */
function configFor(decl, root) {
  if (decl.transport === 'http' || decl.transport === 'sse') {
    const url = publicHttps(decl.url);
    if (!url) return null;
    const headers = cleanMap(decl.headers, root);
    return { type: decl.transport, url, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  if (typeof decl.command !== 'string' || !decl.command.trim()) return null;
  const sub = (s) => String(s).replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
  const command = sub(decl.command);
  const args = (Array.isArray(decl.args) ? decl.args : []).filter((a) => typeof a === 'string').map(sub);
  if (hasPlaceholder(command) || args.some(hasPlaceholder)) return null;
  const env = cleanMap(decl.env, root);
  return { command, args, ...(Object.keys(env).length ? { env } : {}) };
}

function registryRemotes(dir) {
  try {
    const sj = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'));
    return (Array.isArray(sj?.remotes) ? sj.remotes : [])
      .filter((r) => r && (r.type === 'streamable-http' || r.type === 'sse') && typeof r.url === 'string')
      .map((r) => ({ transport: r.type === 'sse' ? 'sse' : 'http', url: r.url, headers: {} }));
  } catch { return []; }
}

/**
 * What this user's enabled, consented, installed items contribute.
 *
 * @param {string} userId
 * @param {ReturnType<import('./gate.mjs').makeGate> | null | undefined} gate  none: nothing loads
 * @param {{ legacyPluginNames?: Set<string> }} [o]
 * @returns {{ plugins: object[], skills: object[], mcp: { id: string, itemId: string, config: object }[], items: object[], warnings: string[] }}
 */
export function activeInstalled(userId, gate, { legacyPluginNames = new Set() } = {}) {
  if (!gate || gate.failClosed || !catalogEnabled() || typeof userId !== 'string' || !userId) return EMPTY;
  const installed = readInstalled(userId);
  const overlay = readOverlay(userId);
  if (installed.corrupt || overlay.corrupt || installed.items.size === 0) return EMPTY;

  const plugins = [];
  const skills = [];
  const mcp = [];
  const items = [];
  const warnings = [];
  const usedServerIds = new Set();
  const addServer = (id, itemId, config) => {
    if (!id || usedServerIds.has(id)) { warnings.push(`${itemId}: server id '${id}' unusable or taken`); return; }
    usedServerIds.add(id);
    mcp.push({ id, itemId, config });
  };

  for (const id of [...installed.items.keys()].sort()) {
    const rec = installed.items.get(id);
    const parsed = parseItemId(id);
    if (!parsed || overlay.items.get(id)?.enabled !== true || !gate.installedActive(parsed.kind, parsed.name)) continue;
    if (missingConsents(rec).length) { warnings.push(`${id}: consent for this commit is missing`); continue; }
    const dir = safeDir(userId, id, rec);
    if (!dir) { warnings.push(`${id}: stored files are missing or not a plain directory`); continue; }
    items.push({ id, kind: parsed.kind, publisher: { trust: rec.publisher?.trust ?? 'unknown' }, source: { commit: rec.pinnedCommit },
      state: { disabledMembers: [...(overlay.items.get(id)?.disabledMembers ?? [])].sort() } });
    const memberOn = (type, name) => gate.installedMemberActive(parsed.kind, parsed.name, type, name);

    if (parsed.kind === 'plugin') {
      const loaded = loadPluginCached(dir);
      if (loaded.error) { warnings.push(`${id}: ${loaded.error}`); continue; }
      const p = loaded.plugin;
      if (p.name !== parsed.name) { warnings.push(`${id}: plugin is named '${p.name}', not like its item`); continue; }
      if (legacyPluginNames.has(p.name)) { warnings.push(`${id}: a plugin named '${p.name}' is already installed`); continue; }
      const kinds = new Set(Array.isArray(p.executableKinds) ? p.executableKinds : []);
      const consented = new Set(Object.keys(rec.consents ?? {}));
      // Everything the loader sees as runnable must be covered; `monitors` and any
      // kind with no consent word can never be, so such a plugin is never trusted.
      const trusted = [...kinds].every((k) => LOADER_TO_CONSENT[k] && consented.has(LOADER_TO_CONSENT[k]));
      plugins.push({ ...p, installedItem: { id, commit: rec.pinnedCommit, trusted } });
      let n = 0;
      for (const decl of p.mcpServers ?? []) {
        if (n >= MAX_SERVERS_PER_ITEM) break;
        if (!memberOn('mcp', decl.name)) continue;
        const config = configFor(decl, dir);
        if (!config) { warnings.push(`${id}: server '${decl.name}' cannot be built safely`); continue; }
        addServer(mcpId(p.name, decl.name), id, config);
        n += 1;
      }
    } else if (parsed.kind === 'skill' || parsed.kind === 'llm-source') {
      let n = 0;
      for (const { file, dirName } of skillEntriesOf(dir, { kind: parsed.kind, name: parsed.name })) {
        if (n >= MAX_SKILLS_PER_ITEM) break;
        const s = readSkill(file, dirName);
        if (!s || !memberOn('skill', s.name)) continue;
        skills.push({
          id: `catalog/${parsed.publisher}__${parsed.name}/${String(dirName).replace(/[^A-Za-z0-9._-]+/g, '-')}`, family: 'skills',
          name: s.name, description: s.description, path: file, sourceId: id, sourceName: rec.name,
        });
        n += 1;
      }
    } else if (parsed.kind === 'mcp') {
      const decl = registryRemotes(dir)[0];
      if (!decl) { warnings.push(`${id}: no remote endpoint to connect to (packages are not launched)`); continue; }
      const member = (rec.members ?? []).find((m) => m.type === 'mcp');
      if (member && !memberOn('mcp', member.name)) continue;
      const config = configFor(decl, dir);
      if (!config) { warnings.push(`${id}: endpoint cannot be used safely`); continue; }
      addServer(mcpId(parsed.name), id, config);
    }
  }
  return { plugins, skills, mcp, items, warnings };
}
