// The skill registry — single owner of every skill-related concern:
// core skill loading (global + internal), the plugin-skill cache, the
// per-user effective skill/command/subagent view, the agent catalog
// (for chat "/" autocomplete), plugin reload, and the startup
// handler-wiring check.
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
// The global dir composes its base via composeGlobalPrompt (no _base.md) and
// keeps a non-skill role file (prompt.md) alongside the skills — tell the
// loader so neither produces a spurious startup warning that would mask a real
// malformed-skill warning.
export const globalSkills = loadSkills(GLOBAL_DIR, { requireBase: false, ignore: ['prompt.md'] });
export const internalSkills = loadSkills(INTERNAL_SKILLS_DIR);

if (globalSkills.warnings.length > 0) {
  console.warn('[llm_agent] global warnings:', globalSkills.warnings);
}
if (internalSkills.warnings.length > 0) {
  console.warn('[llm_agent] internal warnings:', internalSkills.warnings);
}

// Every core 'read' skill MUST have an execution handler, or a call to it
// fails mid-session as "no read handler for 'X'". Global read skills are wired
// in route.mjs's handlers map, keyed by GLOBAL_HANDLER_NAMES (the same array
// route.mjs self-checks — see global-handlers.mjs / global-handlers-sync.test.mjs).
// Internal read skills resolve from INTERNAL_HANDLERS. The internal side is the
// live footgun: sync-skills.sh mirrors the central repo's agent-family wholesale
// into internal/skills/, so a newly-added central READ skill lands here with no
// local handler and used to only console.error at boot — reachable-looking but
// dead. Pure + exported so it's unit-testable with synthetic inputs.
export function assertReadSkillsWired({ globalSkills, internalSkills, globalHandlerNames, internalHandlers }) {
  const globalSet = new Set(globalHandlerNames);
  const unwired = [];
  for (const [name, skill] of globalSkills) {
    if (skill.kind === 'read' && !globalSet.has(name)) unwired.push(`global:${name}`);
  }
  for (const [name, skill] of internalSkills) {
    if (skill.kind === 'read' && !(name in internalHandlers)) unwired.push(`internal:${name}`);
  }
  if (unwired.length > 0) {
    throw new Error(
      `[llm_agent] read skill(s) with no registered handler — calls to them fail mid-session: ${unwired.join(', ')}. ` +
      `Wire a handler: global → route.mjs handlers + global-handlers.mjs; internal → INTERNAL_HANDLERS in handlers/ask-internal.mjs.`,
    );
  }
}

// Fail boot loudly on a broken shipped/synced skill set rather than serving a
// dead skill. Only covers CORE skills (global + internal), which the build
// controls — per-user plugin skills are validated separately and must not be
// able to crash boot.
assertReadSkillsWired({
  globalSkills: globalSkills.skills,
  internalSkills: internalSkills.skills,
  globalHandlerNames: GLOBAL_HANDLER_NAMES,
  internalHandlers: INTERNAL_HANDLERS,
});

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
// reloadPlugins(). Avoids re-reading every plugin's skills/ directory
// when /kb/agent/catalog is hit repeatedly (chat "/" autocomplete).
let _allSkillsCache = null;

/**
 * Skill catalog for GET /kb/agent/catalog (Code Assistant "/" menu).
 * Returns ALL installed skills grouped by source — global tools,
 * internal (KB-aware) skills, and per-plugin skills. Plugin
 * enable-state is NOT considered here; this is a discovery catalog.
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
