// The skill registry — single owner of every skill-related concern:
// core skill loading (global + internal), the plugin-skill cache, the
// per-user effective skill/command/subagent view, the Library catalog,
// plugin reload, and the startup handler-wiring check.
//
// route.mjs (the /code-assist orchestrator) and the HTTP routes import
// from here; nothing else should reach into skill state directly.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkills } from './loader.mjs';
import { loadPlugins } from '../../plugins/loader.mjs';
import { listEnabled as listEnabledPlugins, pruneOrphans as prunePluginOrphans } from '../../plugins/state.mjs';
import { INTERNAL_HANDLERS } from '../runtime/handlers/ask-internal.mjs';
import { GLOBAL_HANDLER_NAMES } from '../runtime/global-handlers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DIR = join(__dirname, '..', 'global');
const INTERNAL_SKILLS_DIR = join(__dirname, '..', 'internal', 'skills');

// Load skills + base once per process (same lifecycle as the old
// skillsCache).
export const globalSkills = loadSkills(GLOBAL_DIR);
export const internalSkills = loadSkills(INTERNAL_SKILLS_DIR);

if (globalSkills.warnings.length > 0) {
  console.warn('[llm_agent] global warnings:', globalSkills.warnings);
}
if (internalSkills.warnings.length > 0) {
  console.warn('[llm_agent] internal warnings:', internalSkills.warnings);
}

// Startup wiring check: every core 'read' skill must have an execution
// handler. Global read skills are wired in route.mjs's handlers map;
// GLOBAL_HANDLER_NAMES (imported above from runtime/global-handlers.mjs) is
// the SAME array route.mjs uses to build that map and to self-check its keys
// at request time — so this check and route.mjs's dispatch table can no
// longer drift apart via two hand-maintained literals (see
// global-handlers.mjs for the history of that footgun, and
// tests/global-handlers-sync.test.mjs for the regression test that pins it).
// Internal read skills resolve from INTERNAL_HANDLERS. A skill file without a
// handler would otherwise only fail at runtime, mid-session, as "no read
// handler for 'X'".
{
  const GLOBAL_HANDLED = new Set(GLOBAL_HANDLER_NAMES);
  for (const [name, skill] of globalSkills.skills) {
    if (skill.kind === 'read' && !GLOBAL_HANDLED.has(name)) {
      console.error(`[llm_agent] STARTUP: global read skill '${name}' has no registered handler — calls to it will fail`);
    }
  }
  for (const [name, skill] of internalSkills.skills) {
    if (skill.kind === 'read' && !(name in INTERNAL_HANDLERS)) {
      console.error(`[llm_agent] STARTUP: internal read skill '${name}' has no registered handler — calls to it will fail`);
    }
  }
}

// Plugin discovery is also done once at module init. Discovery is
// cheap (one readdir + N JSON parses); we don't watch the directory
// dynamically — operators add a plugin then restart the server.
// Per-user enable state is read PER REQUEST in buildPerUserSkillSet
// because users can toggle plugins live via the settings UI.
let pluginRegistry = loadPlugins();
if (pluginRegistry.warnings.length > 0) {
  console.warn('[llm_agent] plugin warnings:', pluginRegistry.warnings);
}

/**
 * Re-scan the plugin directory at runtime. Called by the plugin
 * management endpoints after an install / remove so users don't have
 * to restart the server. The new registry replaces the cached one
 * atomically.  The skill-catalog cache is also invalidated so the
 * next call to listAllSkills() reflects the new plugin set.
 */
export function reloadPlugins() {
  pluginRegistry = loadPlugins();
  // Invalidate the cached skill catalog — new/removed plugins change it.
  _allSkillsCache = null;
  // Drop parsed-plugin-skill cache so re-installed plugins get re-read.
  _pluginSkillCache = new Map();
  // Drop enable-state entries for plugins that have been uninstalled
  // since the last load. Without this, removing a plugin folder leaves
  // its name in plugin-state.json forever — harmless functionally
  // (the list endpoint filters by what's discoverable), but the file
  // grows unboundedly over many install/uninstall cycles.
  try {
    prunePluginOrphans(new Set(pluginRegistry.plugins.keys()));
  } catch (err) {
    console.warn('[plugins] orphan prune failed:', err?.message || err);
  }
  return {
    pluginDir: pluginRegistry.pluginDir,
    count: pluginRegistry.plugins.size,
    warnings: pluginRegistry.warnings,
  };
}

// Cache for listAllSkills() — populated on first call, invalidated by
// reloadPlugins().  Each call previously re-read every plugin's skills/
// directory from disk, which adds up when the Library sidebar polls
// /kb/agent/catalog on every open.
let _allSkillsCache = null;

/**
 * Skill catalog for the Library → Skills section in the Mac app.
 * Returns ALL installed skills grouped by source — global tools,
 * internal (KB-aware) skills, and per-plugin skills.  Plugin
 * enable-state is NOT considered here; this is a catalog view so the
 * user can see what's available regardless of which plugins are on.
 *
 * Each skill entry: { name, kind, description }.
 * Plugin groups: { pluginName, pluginDisplayName, skills[] }.
 */
export function listAllSkills() {
  if (_allSkillsCache) return _allSkillsCache;

  const toEntry = (name, skill) => ({
    name,
    kind: skill.kind || 'read',
    description: skill.description || '',
  });

  const global = [];
  for (const [name, skill] of globalSkills.skills) {
    global.push(toEntry(name, skill));
  }

  const internal = [];
  for (const [name, skill] of internalSkills.skills) {
    internal.push(toEntry(name, skill));
  }

  const plugins = [];
  for (const p of pluginRegistry.plugins.values()) {
    if (p.skillFiles.length === 0) continue;
    const loaded = loadPluginSkillsCached(join(p.dir, 'skills'));
    const skills = [];
    for (const [name, skill] of loaded.skills) {
      skills.push(toEntry(name, skill));
    }
    if (skills.length > 0) {
      plugins.push({
        pluginName: p.name,
        pluginDisplayName: p.displayName || p.name,
        skills,
      });
    }
  }

  _allSkillsCache = { global, internal, plugins };
  return _allSkillsCache;
}

/**
 * Public registry view — `/auth/me/plugins` reads through this. Lists
 * every installed plugin plus the active user's enable state.
 */
export function listInstalledPlugins(userId) {
  const enabled = listEnabledPlugins(userId);
  const items = [];
  for (const p of pluginRegistry.plugins.values()) {
    items.push({
      name: p.name,
      version: p.version,
      displayName: p.displayName,
      description: p.description,
      author: p.author,
      enabled: enabled.has(p.name),
      skillCount: p.skillFiles.length,
      commands: Object.keys(p.commands).map((trigger) => ({
        trigger,
        description: p.commands[trigger].description,
      })),
      subagents: Object.keys(p.subagents || {}).map((name) => ({
        name,
        description: p.subagents[name].description,
        allowedTools: p.subagents[name].allowedTools,
      })),
    });
  }
  return {
    pluginDir: pluginRegistry.pluginDir,
    plugins: items,
  };
}

// Parsed plugin skills cached by plugin skills-dir. Plugin skill files only
// change on install/remove, which call reloadPlugins() (clears this) — so we
// don't re-read + re-parse + re-validate every plugin's skills/ on every
// /code-assist request anymore.
let _pluginSkillCache = new Map();
function loadPluginSkillsCached(dir) {
  let cached = _pluginSkillCache.get(dir);
  if (!cached) {
    cached = loadSkills(dir);
    _pluginSkillCache.set(dir, cached);
  }
  return cached;
}

/**
 * Build the per-user effective skill map, command map, and subagent
 * map. Layers the skills from every enabled plugin on top of the core
 * internal set. Plugin skills with names that clash with core skills
 * lose — core always wins, so a malicious plugin can't shadow
 * ask-internal etc.
 */
export function buildPerUserSkillSet(userId) {
  const enabled = listEnabledPlugins(userId);
  // Start with a copy of the internal skill set so mutations here
  // don't bleed across users.
  const skills = new Map(internalSkills.skills);
  const commands = new Map();
  const subagents = new Map();
  for (const p of pluginRegistry.plugins.values()) {
    if (!enabled.has(p.name)) continue;
    // Skill files: re-run the strict skill-loader on the plugin's
    // skills/ directory so we get the same validation guarantees the
    // core skills get. Bad plugin skills are dropped with a warning
    // server-side.
    if (p.skillFiles.length > 0) {
      const pluginSkills = loadPluginSkillsCached(join(p.dir, 'skills'));
      if (pluginSkills.warnings.length > 0) {
        console.warn(`[plugin:${p.name}] skill warnings:`, pluginSkills.warnings);
      }
      for (const [name, skill] of pluginSkills.skills) {
        if (skills.has(name)) {
          // Core wins by design (a plugin must not shadow ask-internal
          // etc.) — but say so, or the plugin author has no way to know
          // their skill silently never loads.
          console.warn(`[plugin:${p.name}] skill '${name}' shadowed by a core skill of the same name — plugin version not loaded`);
          continue;
        }
        skills.set(name, { ...skill, pluginName: p.name });
      }
    }
    // Slash commands — qualified by trigger, last enabled plugin
    // wins on collision (deterministic since plugins are loaded in
    // directory order).
    for (const [trigger, cmd] of Object.entries(p.commands)) {
      commands.set(trigger, { ...cmd, pluginName: p.name });
    }
    // Subagents — single global namespace across plugins. First
    // plugin to declare a name wins (deterministic order), so a
    // malicious second plugin can't hijack a known name.
    for (const [name, sub] of Object.entries(p.subagents || {})) {
      if (subagents.has(name)) continue;
      subagents.set(name, { ...sub, pluginName: p.name });
    }
  }
  return { skills, commands, subagents };
}
