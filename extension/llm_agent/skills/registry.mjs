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
import { getSource as getPluginSource } from '../../plugins/source-store.mjs';
import {
  listEnabled as listEnabledPlugins,
  listHooksTrusted as listHooksTrustedPlugins,
  listHooksTrustedKinds as listHooksTrustedKindsOf,
  pruneOrphans as prunePluginOrphans,
} from '../../plugins/state.mjs';
import { syncPluginMcpServers } from '../../mcp/state.mjs';
import { buildPluginHooks } from '../sdk/hooks.mjs';
import { nativePluginsEnabled } from '../../kb/user.mjs';
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
// Boot-time reconcile so a plugin installed while the server was down (or by
// an earlier build that predated MCP support) still gets its declared servers
// registered — unconsented, as always.
try {
  const synced = syncPluginMcpServers(mcpDeclarationGroups());
  if (synced.skipped?.length) console.warn('[plugins] mcp declarations skipped:', synced.skipped);
} catch (err) {
  console.warn('[plugins] mcp sync failed at boot:', err?.message || err);
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
  // Reconcile the MCP registry with what the installed plugins declare. This
  // layer does the wiring because plugins/ and mcp/ are peers that may not
  // import each other, and llm_agent may import both. Registration is not
  // activation: every entry lands unconsented, and an uninstalled plugin's
  // entries go away with it.
  try {
    const synced = syncPluginMcpServers(mcpDeclarationGroups());
    if (synced.skipped?.length) console.warn('[plugins] mcp declarations skipped:', synced.skipped);
  } catch (err) {
    console.warn('[plugins] mcp sync failed:', err?.message || err);
  }
  return {
    pluginDir: pluginRegistry.pluginDir,
    count: pluginRegistry.plugins.size,
    warnings: pluginRegistry.warnings,
  };
}

/**
 * Whether `p`'s grant still covers what it declares NOW. A grant records the
 * executable kinds the user agreed to; a plugin that has since gained another
 * (an update adds monitors, a language server, bin/) is untrusted again until
 * the user re-grants — `outdated` lets the UI say why instead of looking
 * mysteriously reset. A grant with no record reads as hooks-only.
 */
export function trustStatusFor(p, trustedNames, trustedKinds) {
  if (!trustedNames.has(p.name)) return { trusted: false, outdated: false, missing: [] };
  const recorded = trustedKinds.get(p.name) || new Set(['hooks']);
  const current = currentTrustKinds(p);
  const missing = [...current].filter((kind) => !recorded.has(kind));
  return missing.length
    ? { trusted: false, outdated: true, missing }
    : { trusted: true, outdated: false, missing: [] };
}

/**
 * What a grant must cover for `p` as it is now: its executable kinds, plus the
 * internal `sdk` marker when the Agent SDK would load the package itself. `sdk`
 * is not a component the user sees; it records the DELIVERY MODE, because a
 * package that moves from the translated path (command hooks only, bounded) to
 * native loading (every handler type, JS modules) keeps the same kinds but
 * gains capability.
 */
export function currentTrustKinds(p) {
  const kinds = new Set(Array.isArray(p.executableKinds) ? p.executableKinds : []);
  if (Array.isArray(p.hooks) && p.hooks.length > 0) kinds.add('hooks');
  const sdkLoads = p.format === 'claude'
    && typeof p.manifestRel === 'string' && p.manifestRel.startsWith('.claude-plugin');
  if (sdkLoads && kinds.size > 0) kinds.add('sdk');
  return kinds;
}

/**
 * How this user's enabled plugins reach the v2 engine. Two mechanisms, and each
 * plugin uses exactly one:
 *
 *   native     — handed to the Agent SDK as `{ type: 'local', path }`. The SDK
 *                loads the package's skills/commands/agents and runs its hooks
 *                with full fidelity (every handler type and event it supports),
 *                which our own translation cannot match.
 *   translated — llm-ide runs the plugin's `command` hooks itself, bounded by
 *                its own timeout and output cap (sdk/hooks.mjs).
 *
 * Native is the default and is what `nativeEnabled: false` turns off, falling
 * back to translation. Three rules hold either way:
 *
 *  1. **Hook trust still gates everything.** Handing a plugin to the SDK means
 *     the SDK runs its hooks, so a plugin with hooks is only handed over once
 *     the user has trusted them. An untrusted plugin's hooks run through
 *     NEITHER mechanism.
 *  2. **Never both.** A natively-loaded plugin is excluded from translation, or
 *     every hook would fire twice.
 *  3. **MCP stays ours.** `skipMcpDiscovery` is always set: a plugin's declared
 *     servers keep their own consent gate (mcp/state.mjs) and must not be
 *     connected by the SDK behind it.
 *
 * Only a `.claude-plugin` package can go native — the SDK does not read Codex's
 * `.codex-plugin` manifest, and an own-format plugin has no vendor manifest at
 * all, so both keep the translated path.
 */
export function buildUserPluginDelivery(userId, { nativeEnabled = true, cwd, env, onNote } = {}) {
  const enabled = listEnabledPlugins(userId);
  const grantedNames = listHooksTrustedPlugins(userId);
  const grantedKinds = listHooksTrustedKindsOf(userId);
  // Names whose grant still covers what the plugin declares today.
  const trusted = new Set();
  for (const p of pluginRegistry.plugins.values()) {
    if (trustStatusFor(p, grantedNames, grantedKinds).trusted) trusted.add(p.name);
  }
  const sdkPlugins = [];
  const native = [];
  const translated = [];
  const toTranslate = [];

  for (const p of pluginRegistry.plugins.values()) {
    if (!enabled.has(p.name)) continue;
    const hooks = Array.isArray(p.hooks) ? p.hooks : [];
    // Any declaration counts, not just the ones llm-ide can translate: the SDK
    // runs what it understands from the whole package (see loader.mjs).
    const hasHooks = hooks.length > 0 || p.declaresHooks === true;
    const hookTrusted = trusted.has(p.name);
    const sdkReadable = p.format === 'claude'
      && typeof p.manifestRel === 'string'
      && p.manifestRel.startsWith('.claude-plugin');

    if (nativeEnabled && sdkReadable && (!hasHooks || hookTrusted)) {
      sdkPlugins.push({ type: 'local', path: p.dir, skipMcpDiscovery: true });
      native.push(p.name);
      continue;
    }
    // Only a plugin with something to translate counts as translated: a trusted
    // one whose parts are all lsp/bin/monitors/modules has zero command hooks
    // here, and listing it would claim something runs when nothing does.
    if (hooks.length > 0 && hookTrusted) {
      toTranslate.push({ name: p.name, hooks });
      translated.push(p.name);
    }
  }

  return {
    sdkPlugins,
    native,
    translated,
    hooks: buildPluginHooks(toTranslate, { trusted, cwd, env, onNote }),
  };
}

/**
 * Just the translated-hook half of `buildUserPluginDelivery`, kept for callers
 * that only need the SDK `hooks` option.
 */
export function buildUserPluginHooks(userId, opts = {}) {
  return buildUserPluginDelivery(userId, opts).hooks;
}

/** What every installed plugin declares in its `.mcp.json`, grouped by plugin. */
function mcpDeclarationGroups() {
  const groups = [];
  for (const p of pluginRegistry.plugins.values()) {
    if (Array.isArray(p.mcpServers) && p.mcpServers.length > 0) {
      groups.push({ pluginName: p.name, servers: p.mcpServers });
    }
  }
  return groups;
}

/**
 * Predicate for `effectiveMcpServers({ pluginEnabled })`: is this plugin
 * enabled for this user? A plugin-declared MCP server must go dark when the
 * plugin itself is switched off, so the MCP layer asks this before including
 * one. An unknown name answers false — a server whose plugin is no longer
 * installed is never effective.
 */
export function pluginEnabledFor(userId) {
  const enabled = listEnabledPlugins(userId);
  return (pluginName) => typeof pluginName === 'string'
    && enabled.has(pluginName)
    && pluginRegistry.plugins.has(pluginName);
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
    const loaded = loadPluginSkillsCached(pluginSkillsDir(p));
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
  const grantedNames = listHooksTrustedPlugins(userId);
  const grantedKinds = listHooksTrustedKindsOf(userId);
  // Which plugins this user's next turn would hand to the SDK. Reported so the
  // UI can describe hook behaviour truthfully: natively the SDK runs every
  // handler type it supports, translated only `command` ones.
  const nativeNames = new Set(buildUserPluginDelivery(userId, {
    nativeEnabled: nativePluginsEnabled(userId),
  }).native);
  // The client cannot tell "native pref off" from "waiting for trust" from
  // "Codex layout" by `nativeDelivery` alone (false in all three), so say the two
  // facts that decide whether the agent engine can ever load a plugin.
  const nativePluginsOn = nativePluginsEnabled(userId);
  const items = [];
  for (const p of pluginRegistry.plugins.values()) {
    items.push({
      name: p.name,
      version: p.version,
      sdkReadable: p.format === 'claude'
        && typeof p.manifestRel === 'string' && p.manifestRel.startsWith('.claude-plugin'),
      nativePluginsOn,
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
      // Vendor-package provenance + the components that came along but stay
      // inert here, so the Library detail view can say so instead of the user
      // wondering why a Claude plugin's hooks do nothing.
      format: p.format || 'llmide',
      // 'claude' | 'codex' when a vendor bridge imported it, else null.
      origin: p.origin ?? null,
      // The vendor version the import copied (the stamp), else null.
      sourceVersion: p.sourceVersion ?? null,
      // Where git/marketplace/zip installs came from (null when unrecorded).
      installSource: getPluginSource(p.name, pluginRegistry.pluginDir) ?? null,
      unsupportedComponents: p.unsupportedComponents || [],
      pendingComponents: p.pendingComponents || [],
      // Hooks: how many runnable handlers the plugin declares, what llm-ide
      // will NOT run from its hooks file, and whether this user has trusted
      // them. The count gates the trust toggle — there is nothing to trust
      // when it is zero.
      hookCount: Array.isArray(p.hooks) ? p.hooks.length : 0,
      declaresHooks: p.declaresHooks === true,
      executableKinds: Array.isArray(p.executableKinds) ? p.executableKinds : [],
      hookNotes: p.hookNotes || [],
      // Effective trust: a grant that no longer covers the plugin reads untrusted.
      hooksTrusted: trustStatusFor(p, grantedNames, grantedKinds).trusted,
      trustOutdated: trustStatusFor(p, grantedNames, grantedKinds).outdated,
      // Only the kinds the old grant did not cover, so the UI names what is NEW.
      trustOutdatedKinds: trustStatusFor(p, grantedNames, grantedKinds).missing,
      nativeDelivery: nativeNames.has(p.name),
      mcpServerCount: Array.isArray(p.mcpServers) ? p.mcpServers.length : 0,
    });
  }
  return {
    pluginDir: pluginRegistry.pluginDir,
    plugins: items,
  };
}

// A vendor manifest can relocate its skills dir (`skills: './x'`), so the
// loader resolves it once and hands it over as `skillsDir`. Older plugin
// objects (own format) always used the conventional name — keep that as the
// fallback so nothing depends on the field's presence.
function pluginSkillsDir(p) {
  return p.skillsDir || join(p.dir, 'skills');
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
      const pluginSkills = loadPluginSkillsCached(pluginSkillsDir(p));
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
