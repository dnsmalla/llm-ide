// The "active view" of a plugin (plan D8): when a user has unchecked members of
// a plugin, the Agent SDK must not be handed the whole directory, because the
// SDK has no per-member switch. This builds a generated plugin root holding the
// plugin's files minus the unchecked skills, commands, agents (and minus the
// hooks / monitors / bin / lsp components when those are unchecked), and the
// caller hands THAT path to the SDK.
//
// Safe by construction:
//  - the view lives beside the plugin directory (never inside it) under a
//    per-user, per-content-stamp folder; a plugin update changes the stamp, so
//    a stale view is never reused;
//  - symbolic links are never copied (the loader refuses them inside a plugin);
//  - anything the view cannot honour exactly (a manifest that relocates its
//    component directories or declares hooks/servers inline while those are
//    unchecked) returns `{ error }` and the plugin is NOT delivered: a switched
//    off member must never load, so failing to filter means not loading.
//
// Whether the SDK honours a generated subset root exactly like a full plugin is
// the plan's open item R3 (unverified); the root has the same layout, and the
// manifest is copied verbatim.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { defaultPluginDir } from '../../plugins/loader.mjs';

const FILTERED = new Set(['skills', 'commands', 'agents']);
// Never copied: the SDK must not rediscover servers here (skipMcpDiscovery is
// set too), and stray VCS state has no business in a generated root.
const SKIP_TOP = new Set(['.mcp.json', '.git']);

export function viewsRoot() {
  return join(dirname(defaultPluginDir()), 'extensions', 'views');
}

function treeStamp(root) {
  const parts = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isSymbolicLink() || (dir === root && SKIP_TOP.has(e.name))) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { parts.push(`d:${relative(root, p)}`); if (parts.length < 20_000) walk(p); } else {
        const st = statSync(p);
        parts.push(`${relative(root, p)}:${st.size}:${st.mtimeMs}`);
      }
      if (parts.length >= 20_000) return;
    }
  };
  walk(root);
  return parts.join('\n');
}

const noLinks = (src) => {
  try { return !lstatSync(src).isSymbolicLink(); } catch { return false; }
};

function manifestOf(plugin) {
  try { return JSON.parse(readFileSync(join(plugin.dir, plugin.manifestRel), 'utf8')); } catch { return null; }
}

/**
 * @param {object} plugin   a loader plugin object
 * @param {string[]} disabled  `<type>:<name>` member ids the user unchecked
 * @param {{ userId: string }} o
 * @returns {{ path: string, remainingExecutable: string[] } | { error: string }}
 */
export function materializePluginView(plugin, disabled, { userId }) {
  try {
    const off = new Set(disabled);
    const manifest = manifestOf(plugin);
    if (!manifest) return { error: 'manifest unreadable' };
    for (const key of ['skills', 'commands', 'agents']) {
      if (manifest[key] !== undefined) return { error: `manifest relocates ${key}/; a member view cannot be built` };
    }
    if (plugin.skillsDir && relative(plugin.dir, plugin.skillsDir) !== 'skills') return { error: 'skills directory is not the conventional one' };
    const hooksOff = off.has('hook:hooks');
    if (hooksOff && manifest.hooks !== undefined && manifest.hooks !== null) return { error: 'hooks are declared inline in the manifest; they cannot be unchecked' };

    const stamp = createHash('sha256');
    stamp.update(JSON.stringify([userId, plugin.name, plugin.version ?? '', [...off].sort(), statSync(plugin.dir).mtimeMs,
      statSync(join(plugin.dir, plugin.manifestRel)).mtimeMs]));
    // Every file that can end up in the view, by path, size and mtime: editing a skill in place changes
    // neither its directory's mtime nor the manifest's.
    stamp.update(treeStamp(plugin.dir));
    const hash = stamp.digest('hex').slice(0, 16);
    const userDir = join(viewsRoot(), createHash('sha256').update(String(userId)).digest('hex').slice(0, 16));
    const target = join(userDir, `${plugin.name}-${hash}`);

    const remainingExecutable = (Array.isArray(plugin.executableKinds) ? plugin.executableKinds : [])
      .filter((k) => !(k === 'hooks' && off.has('hook:hooks')) && !off.has(`${k}:${k}`));

    if (existsSync(join(target, plugin.manifestRel))) return { path: target, remainingExecutable };

    // Private: the view holds a user's plugin files (and the folder name hints at who uses what).
    mkdirSync(userDir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try {
      // Everything at the top level that is not a filtered component.
      for (const entry of readdirSync(plugin.dir, { withFileTypes: true })) {
        const name = entry.name;
        if (FILTERED.has(name) || SKIP_TOP.has(name)) continue;
        if (entry.isSymbolicLink()) continue;
        if (name === 'hooks' && hooksOff) continue;
        if ((name === 'bin' && off.has('bin:bin')) || (name === '.lsp.json' && off.has('lsp:lsp'))) continue;
        cpSync(join(plugin.dir, name), join(tmp, name), { recursive: true, filter: noLinks });
      }
      // Skills: only the checked ones, in whichever layout they use.
      for (const file of Array.isArray(plugin.skillFiles) ? plugin.skillFiles : []) {
        const isDir = basename(file) === 'SKILL.md';
        const name = isDir ? basename(dirname(file)) : basename(file).replace(/\.md$/, '');
        if (off.has(`skill:${name}`)) continue;
        if (isDir) cpSync(dirname(file), join(tmp, 'skills', name), { recursive: true, filter: noLinks });
        else cpSync(file, join(tmp, 'skills', basename(file)));
      }
      for (const trigger of Object.keys(plugin.commands || {})) {
        if (off.has(`command:${trigger}`)) continue;
        const src = join(plugin.dir, 'commands', `${trigger}.md`);
        if (existsSync(src) && noLinks(src)) cpSync(src, join(tmp, 'commands', `${trigger}.md`));
      }
      for (const name of Object.keys(plugin.subagents || {})) {
        if (off.has(`agent:${name}`)) continue;
        const src = join(plugin.dir, 'agents', `${name}.md`);
        if (existsSync(src) && noLinks(src)) cpSync(src, join(tmp, 'agents', `${name}.md`));
      }
      try { renameSync(tmp, target); }
      catch { rmSync(tmp, { recursive: true, force: true }); if (!existsSync(target)) throw new Error('view not created'); }
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    // Drop views of this plugin made for older content stamps.
    try {
      for (const e of readdirSync(userDir)) {
        if (e !== basename(target) && e.length === plugin.name.length + 17 && e.startsWith(`${plugin.name}-`) && /^[0-9a-f]{16}$/.test(e.slice(-16))) {
          rmSync(join(userDir, e), { recursive: true, force: true });
        }
      }
    } catch { /* best effort */ }
    return { path: target, remainingExecutable };
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 200) };
  }
}

const userViewsDir = (userId) => join(viewsRoot(), createHash('sha256').update(String(userId)).digest('hex').slice(0, 16));

/** Remove the generated views of one plugin for one user (uninstall). Best effort. */
export function removeViewsFor(userId, pluginName) {
  try {
    const dir = userViewsDir(userId);
    for (const e of readdirSync(dir)) {
      if (e.length === String(pluginName).length + 17 && e.startsWith(`${pluginName}-`) && /^[0-9a-f]{16}$/.test(e.slice(-16))) {
        rmSync(join(dir, e), { recursive: true, force: true });
      }
    }
  } catch { /* nothing there */ }
}

/** Remove every generated view of one user (account deletion). Best effort. */
export function removeAllViewsFor(userId) {
  try { rmSync(userViewsDir(userId), { recursive: true, force: true }); } catch { /* nothing there */ }
}
