// /code-assist handler logic. Orchestrates the global agent and
// delegates to ask-internal when needed. The thin route file in
// extension/server/ai-routes.mjs just builds the ctx and calls
// `handleCodeAssist`.

import { runAgentLoop } from './loop.mjs';
import { loadSkills } from './skill-loader.mjs';
import { askInternal } from './handlers/ask-internal.mjs';
import { askSubagent } from './handlers/ask-subagent.mjs';
import { composeGlobalPrompt } from '../global/compose-prompt.mjs';
import { loadPlugins, expandSlashCommand } from '../../plugins/loader.mjs';
import { listEnabled as listEnabledPlugins, pruneOrphans as prunePluginOrphans } from '../../plugins/state.mjs';
import { sanitizePersonaSuffix } from '../../agents/prompt-utils.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DIR = join(__dirname, '..', 'global');
const INTERNAL_SKILLS_DIR = join(__dirname, '..', 'internal', 'skills');

// Load skills + base once per process (same lifecycle as the old
// skillsCache).
const globalSkills = loadSkills(GLOBAL_DIR);
const internalSkills = loadSkills(INTERNAL_SKILLS_DIR);

if (globalSkills.warnings.length > 0) {
  console.warn('[llm_agent] global warnings:', globalSkills.warnings);
}
if (internalSkills.warnings.length > 0) {
  console.warn('[llm_agent] internal warnings:', internalSkills.warnings);
}

// Plugin discovery is also done once at module init. Discovery is
// cheap (one readdir + N JSON parses); we don't watch the directory
// dynamically — operators add a plugin then restart the server.
// Per-user enable state is read PER REQUEST in handleCodeAssist
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
    const loaded = loadSkills(join(p.dir, 'skills'));
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

/**
 * Build the per-user effective skill map and command map. Layers the
 * skills from every enabled plugin on top of the core internal set.
 * Plugin skills with names that clash with core skills lose — core
 * always wins, so a malicious plugin can't shadow ask-internal etc.
 */
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

function buildPerUserSkillSet(userId) {
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
        if (skills.has(name)) continue; // core wins
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

// Pre-compose the global prompt body that runAgentLoop will use.
// We pass it as `agentContext.base` so the existing composer in
// loop.mjs picks it up; the rest of the agentContext fields are
// intentionally empty so no app-state leaks into global's prompt.
const globalPromptBase = composeGlobalPrompt({ skills: globalSkills.skills });

export async function handleCodeAssist({
  message,
  history,
  agentContext,             // arrives from the client; ONLY internal consumes it
  attachmentsText,          // sanitized attachment block (optional)
  languageDirective,        // "Respond in <lang>" style line (optional)
  runClaude,
  kb,
  userId,
}) {
  // Per-user plugin view. Building it is cheap (Map clone + readdir
  // for each enabled plugin's skills/). Done per request so a user
  // toggling a plugin in Settings is reflected immediately.
  const { skills: userSkills, commands: userCommands, subagents: userSubagents } = buildPerUserSkillSet(userId);

  // Slash-command expansion. If the user's message starts with /foo,
  // look it up against the enabled command set and expand the prompt
  // template before the agent runs. The expanded text replaces the
  // original message; we surface a small note in `expandedFrom` so
  // the response renderer can show "(via /foo)" if it wants.
  let effectiveMessage = message;
  let expandedFrom = null;
  if (typeof message === 'string' && message.trim().startsWith('/')) {
    const expansion = expandSlashCommand(message, userCommands);
    if (expansion && expansion.error) {
      return { reply: expansion.error, pendingTool: null };
    }
    if (expansion) {
      effectiveMessage = expansion.prompt;
      expandedFrom = expansion.trigger;
    }
  }

  // The agent path historically only forwarded `message`, dropping the
  // attachment block + language directive that the legacy non-agent
  // path embedded. Restitch them in front of the user message so the
  // global agent sees the same context the user provided.
  const composedUserMessage = [
    languageDirective || '',
    attachmentsText || '',
    effectiveMessage || '',
  ].filter((s) => typeof s === 'string' && s.length > 0).join('\n\n');

  // Persona suffix appended to the global agent's system prompt so
  // code-assist answers in the user's configured voice without
  // changing the tool-calling contract (skills + ask-internal +
  // ask-subagent are above it). Empty string when no persona — no
  // token cost for users who haven't customised. Wrapped in
  // try/catch because a stray DB error here shouldn't break the
  // code-assist path; we just lose the persona this request.
  let personaBase = globalPromptBase;
  try {
    if (kb && userId && typeof kb.getAgentPersona === 'function') {
      const persona = kb.getAgentPersona(userId);
      // Sanitize both the name and the suffix before embedding.
      // sanitizePersonaSuffix strips fence tokens (<<<…>>>) and common
      // injection openers; using it on the name too ensures a persona
      // named "<<<TOOL_CALL>>>…" can't forge a write-tool invocation
      // inside the system prompt.  Name is hard-capped at 80 chars;
      // suffix uses the standard PERSONA_SUFFIX_EMBED_MAX (600).
      const name   = sanitizePersonaSuffix((persona?.name   || '').trim()).slice(0, 80);
      const suffix = sanitizePersonaSuffix((persona?.promptSuffix || '').trim());
      if (name || suffix) {
        let prefix = '\n\n---\nPersona\n';
        if (name)   prefix += `You are also known to the user as ${name}; sign off in that voice when natural.\n`;
        if (suffix) prefix += `Voice & focus: ${suffix}\n`;
        personaBase = globalPromptBase + prefix;
      }
    }
  } catch { /* keep the un-persona'd base */ }
  // Global handler set: ask-internal (for app-state-aware questions)
  // plus ask-subagent (for plugin-defined named delegates). The
  // ask-subagent handler is registered unconditionally — when no
  // plugin defines a subagent the user's subagent Map is empty and
  // any invocation gets a helpful "unknown subagent" error rather
  // than a tool-not-found.
  const handlers = {
    'ask-internal': (args) => askInternal(args, {
      agentContext,
      runClaude,
      kb,
      userId,
      // Pass the per-user view; ask-internal already reads
      // ctx.internalSkills.{skills, base}.
      internalSkills: {
        skills: userSkills,
        base: internalSkills.base,
      },
    }),
    'ask-subagent': (args) => askSubagent(args, {
      runClaude,
      kb,
      userId,
      subagents: userSubagents,
      // Subagents that declare allowed_tools need the fence-shape
      // contract; reuse internal's _base.md so authors don't have to
      // duplicate the protocol description.
      internalSkillsBase: internalSkills.base,
    }),
  };

  const out = await runAgentLoop({
    skills: globalSkills.skills,
    userMessage: composedUserMessage,
    history: Array.isArray(history) ? history : [],
    // base = global's composed prompt (role + ask-internal skill).
    // The rest of agentContext is intentionally empty so the loop's
    // composeSystemContext produces only (none configured) sections,
    // which then collapse to "## Active project\n- (none
    // configured)\n## Indexed code repositories ...\n- (none indexed)".
    //
    // The agent's prompt instructs it not to look at those — but in
    // practice global doesn't need to see them either. They cost ~120
    // tokens; tolerable for the architectural cleanliness of using
    // the same composer for both agents.
    agentContext: { base: personaBase },
    runClaude,
    kb,
    userId,
    handlers,
    maxIterations: 3,         // global cap is tighter; see runAgentLoop DEFAULT_MAX_ITERATIONS (10)
    // Long-form writing / refactoring asks routinely take 60-90s per
    // Claude call; with a single internal delegation that's two calls
    // back-to-back. 3 minutes covers the realistic worst case while
    // still bounding a truly stuck loop.
    deadlineMs: 180_000,
  });
  return expandedFrom ? { ...out, expandedFrom } : out;
}
