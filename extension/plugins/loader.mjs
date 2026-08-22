// Plugin discovery + manifest validation.
//
// A plugin is a directory containing:
//   plugin.json        — manifest with name, version, displayName, …
//   skills/*.md        — agent-runtime skills (same format as
//                        llm_agent/runtime/skill-loader.mjs expects).
//                        Each gets merged into the system prompt when
//                        the plugin is enabled for the active user.
//   commands/*.md      — slash commands. Markdown with optional
//                        frontmatter declaring an arg schema; body is
//                        a prompt template with {{argName}} slots.
//
// A vendor plugin (Claude Code / Codex) carries
// `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` instead;
// components live in `skills/<name>/SKILL.md`, `commands/*.md`, and
// `agents/*.md`. Both layouts normalize into the same internal plugin
// model, so nothing downstream has to know which vendor a plugin came
// from.
//
// Plugins live under the OS-standard per-user data directory:
//   ~/Library/Application Support/llm-ide/plugins/   (macOS; legacy: LLM IDE)
//   $XDG_DATA_HOME/llmide/plugins/                  (Linux)
//   %APPDATA%\llm-ide\plugins\                       (Windows; legacy: LLM IDE)
//
// Per-user enable state is stored in the existing user_secrets vault
// under the synthetic key 'plugins.enabled' (JSON array of plugin
// names). Discovery returns every installed plugin; the agent runtime
// only loads the enabled ones.

import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import * as yaml from 'js-yaml';

// Reserved slug — never let a plugin pretend to be a core skill.
const RESERVED_NAMES = new Set(['global', 'internal', 'core', 'kb', 'system']);
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

// Vendor plugin manifests (Claude Code `.claude-plugin/plugin.json`, Codex
// `.codex-plugin/plugin.json`). Codex's format is a near-subset of Claude's,
// so one code path serves both. `plugin.json` at the root always wins — an
// own-format plugin is never reinterpreted.
const VENDOR_MANIFEST_DIRS = ['.claude-plugin', '.codex-plugin'];

function detectPluginFormat(dir) {
  if (existsSync(join(dir, 'plugin.json'))) return 'llmide';
  for (const sub of VENDOR_MANIFEST_DIRS) {
    if (existsSync(join(dir, sub, 'plugin.json'))) return 'claude';
  }
  return null;
}

/**
 * Validate a vendor manifest into the same normalized shape the own-format
 * path produces, plus component-path overrides (./skills etc.). Only `name`
 * is required by the vendor spec; version defaults. `defaultEnabled` is
 * parsed nowhere on purpose — LLM-IDE stays opt-in regardless of manifest.
 */
function validateClaudeManifest(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'manifest is not an object' };
  const { name, version } = raw;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { error: `name must match ${NAME_RE} (got ${JSON.stringify(name)})` };
  }
  if (RESERVED_NAMES.has(name)) return { error: `name '${name}' is reserved` };
  const author = typeof raw.author === 'string'
    ? raw.author.slice(0, 120)
    : (raw.author && typeof raw.author === 'object' && typeof raw.author.name === 'string')
      ? raw.author.name.slice(0, 120)
      : '';
  const components = {};
  for (const key of ['skills', 'commands', 'agents']) {
    const rel = raw[key];
    if (rel === undefined) continue;
    if (typeof rel !== 'string' || !/^\.\/[A-Za-z0-9._-]+$/.test(rel) || rel.includes('..')) {
      return { error: `component path '${key}' must be a './'-prefixed relative path without traversal` };
    }
    components[key] = rel.slice(2);
  }
  return {
    manifest: {
      name,
      version: (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) ? version : '0.0.0',
      displayName: typeof raw.displayName === 'string' ? raw.displayName.slice(0, 80) : name,
      description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : '',
      author,
    },
    components,
  };
}

// Hard caps on plugin content so a malicious or oversized plugin
// can't exhaust the Claude context window or the server's heap.
const MAX_SKILL_BYTES    = 32_768;   // 32 KB per skill file
const MAX_COMMAND_BYTES  = 16_384;   // 16 KB per command template
const MAX_SUBAGENT_BYTES = 32_768;   // 32 KB per subagent system prompt
const MAX_FILES_PER_DIR  = 50;       // max skills/commands/subagents per plugin

// Strip known prompt-injection delimiters that the server itself uses
// as content fences.  A plugin author could accidentally (or
// maliciously) include these in skill/command/subagent bodies and
// break the fence contract used by every AI route.
function stripInjectionFences(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<<<BEGIN>>>/gi, '').replace(/<<<END>>>/gi, '');
}

// Patterns that indicate a plugin is trying to manipulate the LLM's
// behavior beyond what a normal skill/command should do.  These are
// surfaced as warnings — they don't block installation, but they do
// flag the content for admin review.
const SUSPICIOUS_CONTENT_PATTERNS = [
  { name: 'role override',        re: /\b(?:you are now|ignore (?:all )?(?:previous|above|prior) (?:instructions?|rules?|prompts?)|forget (?:everything|all|your))\b/i },
  { name: 'system prompt leak',   re: /\b(?:print|show|reveal|output|repeat|display) (?:your |the )?(?:system (?:prompt|instructions?|message)|initial (?:prompt|instructions?))\b/i },
  { name: 'fence variant',        re: /<<<|>>>|\[INST\]|\[\/INST\]|<\|(?:im_start|im_end|system|endoftext)\|>/i },
  { name: 'tool abuse',           re: /\b(?:call|invoke|execute|run)\s+(?:any|all|every)\s+(?:tools?|functions?|commands?)\b/i },
  { name: 'exfiltration attempt', re: /\b(?:send|post|fetch|upload|transmit)\s+(?:to|data|the|all)\b.*\b(?:https?:\/\/|webhook|endpoint)\b/i },
];

function scanForSuspiciousContent(text) {
  if (typeof text !== 'string') return [];
  const findings = [];
  for (const p of SUSPICIOUS_CONTENT_PATTERNS) {
    if (p.re.test(text)) {
      findings.push(p.name);
    }
  }
  return findings;
}

/**
 * OS-standard per-user plugin root. Override via $LLMIDE_PLUGIN_DIR
 * for tests / dev.
 */
export function defaultPluginDir() {
  if (process.env.LLMIDE_PLUGIN_DIR) return process.env.LLMIDE_PLUGIN_DIR;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return resolveSupportSubdir(home, 'Library/Application Support', 'plugins');
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const canonical = join(base, 'llm-ide', 'plugins');
    const legacy = join(base, 'LLM IDE', 'plugins');
    if (existsSync(legacy) && !existsSync(join(base, 'llm-ide'))) return legacy;
    return canonical;
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'llmide', 'plugins');
}

/** Prefer `llm-ide/`; fall back to legacy `LLM IDE/` when only that exists. */
function resolveSupportSubdir(home, supportRelative, subdir, { absoluteBase } = {}) {
  const base = absoluteBase ?? join(home, ...supportRelative.split('/'));
  const canonical = join(base, 'llm-ide', subdir);
  const legacy = join(base, 'LLM IDE', subdir);
  if (existsSync(legacy) && !existsSync(join(base, 'llm-ide'))) return legacy;
  return canonical;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  let fm;
  try { fm = yaml.load(match[1]) || {}; }
  catch (err) { return { error: `invalid yaml: ${err.message}` }; }
  if (typeof fm !== 'object' || Array.isArray(fm)) {
    return { error: 'frontmatter must be an object' };
  }
  return { frontmatter: fm, body: match[2] };
}

function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'manifest is not an object' };
  const { name, version, displayName, description, author } = raw;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { error: `name must match ${NAME_RE} (got ${JSON.stringify(name)})` };
  }
  if (RESERVED_NAMES.has(name)) {
    return { error: `name '${name}' is reserved` };
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    return { error: 'version must be semver-ish (e.g. 1.0.0)' };
  }
  return {
    manifest: {
      name,
      version,
      displayName: typeof displayName === 'string' ? displayName.slice(0, 80) : name,
      description: typeof description === 'string' ? description.slice(0, 400) : '',
      author: typeof author === 'string' ? author.slice(0, 120) : '',
      // Skill / command lists are derived from disk, not the manifest,
      // so a plugin author can drop files in without editing the
      // manifest. The manifest is identity + metadata only.
    },
  };
}

function parseSubagentFile(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (err) { return { error: `read failed: ${err.message}` }; }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SUBAGENT_BYTES) {
    return { error: `subagent file exceeds ${MAX_SUBAGENT_BYTES} byte limit` };
  }
  raw = stripInjectionFences(raw);
  const parsed = parseFrontmatter(raw);
  if (parsed.error) return { error: parsed.error };
  const fm = parsed.frontmatter || {};
  const body = (parsed.body || '').trim();
  if (!body) return { error: 'empty body (subagent system prompt is required)' };

  const suspicious = scanForSuspiciousContent(body);

  // Tool list: the own format uses `allowed_tools` (a YAML list of lowercase
  // ids). Vendor frontmatter (Claude Code / Codex) uses `tools` — a CSV string
  // or a list of Capitalized names — normalized here: lowercased, and the
  // charset widened to allow underscores (mcp__server__tool) up to 64 chars.
  // `allowed_tools` wins when a plugin carries both.
  let toolList = fm.allowed_tools;
  if (toolList === undefined && fm.tools !== undefined) {
    toolList = typeof fm.tools === 'string'
      ? fm.tools.split(',').map((t) => t.trim()).filter(Boolean)
      : fm.tools;
  }
  const allowedTools = Array.isArray(toolList)
    ? toolList
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => /^[a-z][a-z0-9_-]{0,63}$/.test(t))
    : [];

  // Vendor `maxTurns` maps onto our maxIterations, same clamp.
  const rawIters = fm.maxIterations ?? fm.maxTurns;
  const maxIters = Number.isFinite(rawIters) && rawIters > 0
    ? Math.min(rawIters, 5)
    : 3;

  // Optional sub-model override, e.g. `model: claude-haiku-4-5` to run
  // a leaf subagent on a cheaper tier. Strict charset so the value is
  // safe to embed in an API request; bad values are dropped (the
  // subagent then inherits the deployment default), not fatal.
  const model = (typeof fm.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(fm.model))
    ? fm.model
    : undefined;

  return {
    subagent: {
      description: typeof fm.description === 'string' ? fm.description.slice(0, 300) : '',
      allowedTools,
      maxIterations: maxIters,
      model,
      systemPrompt: body,
    },
    suspicious,
  };
}

function parseCommandFile(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (err) { return { error: `read failed: ${err.message}` }; }
  if (Buffer.byteLength(raw, 'utf8') > MAX_COMMAND_BYTES) {
    return { error: `command file exceeds ${MAX_COMMAND_BYTES} byte limit` };
  }
  raw = stripInjectionFences(raw);
  const parsed = parseFrontmatter(raw);
  if (parsed.error) return { error: parsed.error };
  const fm = parsed.frontmatter || {};
  const args = fm.args && typeof fm.args === 'object' ? fm.args : {};
  const cleanArgs = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof k !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(k)) continue;
    if (!v || typeof v !== 'object') continue;
    const type = ['string', 'number', 'boolean'].includes(v.type) ? v.type : 'string';
    cleanArgs[k] = {
      type,
      required: v.required === true,
      description: typeof v.description === 'string' ? v.description.slice(0, 200) : '',
    };
  }

  const suspicious = scanForSuspiciousContent(parsed.body);

  // Vendor command bodies (Claude Code / Codex) use `$ARGUMENTS` for
  // "everything the user typed after the trigger" — exactly our `{{_rest}}`
  // semantics, so translate at parse time and let expandSlashCommand do the
  // rest. `argument-hint` is display-only; fold it into the description.
  const template = parsed.body.trim().replace(/\$ARGUMENTS\b/g, '{{_rest}}');
  const hint = typeof fm['argument-hint'] === 'string' ? fm['argument-hint'].slice(0, 80) : '';
  const baseDescription = typeof fm.description === 'string' ? fm.description.slice(0, 200) : '';

  return {
    command: {
      description: hint ? `${baseDescription} (args: ${hint})`.slice(0, 240) : baseDescription,
      args: cleanArgs,
      template,
    },
    suspicious,
  };
}

/**
 * Walk one plugin directory. Returns { plugin, warnings } or { error }.
 */
function loadOnePlugin(dir) {
  const format = detectPluginFormat(dir);
  if (format === null) {
    return { error: 'no plugin manifest (plugin.json or .claude-plugin/plugin.json)' };
  }
  let manifest;
  let components = {};
  if (format === 'llmide') {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')); }
    catch (err) { return { error: `plugin.json parse: ${err.message}` }; }
    const v = validateManifest(raw);
    if (v.error) return { error: v.error };
    manifest = v.manifest;
  } else {
    const manifestPath = VENDOR_MANIFEST_DIRS
      .map((sub) => join(dir, sub, 'plugin.json'))
      .find((candidate) => existsSync(candidate));
    let raw;
    try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (err) { return { error: `vendor plugin.json parse: ${err.message}` }; }
    const v = validateClaudeManifest(raw);
    if (v.error) return { error: v.error };
    manifest = v.manifest;
    components = v.components;
  }
  const warnings = [];

  // Skills: read every .md file under skills/ if the dir exists. We
  // don't fully validate against the skill-loader's strict schema here
  // — we just stash the file paths; the agent runtime re-loads them
  // through the existing loader so validation stays in one place.
  // Helper: reject symlinks inside a plugin subdirectory.  The root
  // directory is already checked via lstatSync in loadPlugins(); this
  // extends that check to every .md file so a plugin author cannot add a
  // skill/command/agent that is a symlink pointing outside the plugin.
  function rejectSymlink(subdir, entry) {
    try {
      if (lstatSync(join(subdir, entry)).isSymbolicLink()) {
        warnings.push(`${entry}: symbolic link rejected in plugin content`);
        return true;
      }
    } catch { /* stat failure — treat as skip, readFileSync will also fail */ }
    return false;
  }

  // A vendor manifest may relocate its component dirs (`skills: './x'`);
  // the own format always uses the conventional names.
  const skillsDir = join(dir, components.skills ?? 'skills');
  const skillFiles = [];
  if (existsSync(skillsDir)) {
    try {
      let count = 0;
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        // Two layouts: a flat `<name>.md` (own format) or a vendor
        // `<name>/SKILL.md` directory. A subdirectory without SKILL.md is a
        // plain asset folder (references/, scripts/) — not a skill.
        let skillPath;
        let label;
        if (entry.isDirectory()) {
          skillPath = join(skillsDir, entry.name, 'SKILL.md');
          if (!existsSync(skillPath)) continue;
          label = `${entry.name}/SKILL.md`;
        } else {
          if (!entry.name.endsWith('.md')) continue;
          skillPath = join(skillsDir, entry.name);
          label = entry.name;
        }
        if (count >= MAX_FILES_PER_DIR) {
          warnings.push(`skills/ has more than ${MAX_FILES_PER_DIR} files — extras ignored`);
          break;
        }
        // Reject a symlink at whichever level it appears — the entry itself
        // or the SKILL.md inside a directory entry.
        if (rejectSymlink(skillsDir, entry.name)) continue;
        if (entry.isDirectory() && rejectSymlink(join(skillsDir, entry.name), 'SKILL.md')) continue;
        try {
          const content = readFileSync(skillPath, 'utf8');
          if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
            warnings.push(`skills/${label}: exceeds ${MAX_SKILL_BYTES} byte limit`);
            continue;
          }
          const suspicious = scanForSuspiciousContent(content);
          if (suspicious.length) {
            warnings.push(`skills/${label}: suspicious content detected — ${suspicious.join(', ')}`);
          }
        } catch { /* read error — runtime loader will also fail and skip */ }
        skillFiles.push(skillPath);
        count++;
      }
    } catch (err) {
      warnings.push(`skills/ scan failed: ${err.message}`);
    }
  }

  // Commands: file name == trigger. summary.md → /summary.
  const cmdDir = join(dir, components.commands ?? 'commands');
  const commands = {};
  if (existsSync(cmdDir)) {
    try {
      let count = 0;
      for (const entry of readdirSync(cmdDir)) {
        if (!entry.endsWith('.md')) continue;
        if (count >= MAX_FILES_PER_DIR) {
          warnings.push(`commands/ has more than ${MAX_FILES_PER_DIR} files — extras ignored`);
          break;
        }
        if (rejectSymlink(cmdDir, entry)) continue;
        const trigger = entry.replace(/\.md$/, '');
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(trigger)) {
          warnings.push(`commands/${entry}: trigger name invalid (must be lowercase a-z, 0-9, dash)`);
          continue;
        }
        const parsed = parseCommandFile(join(cmdDir, entry));
        if (parsed.error) {
          warnings.push(`commands/${entry}: ${parsed.error}`);
          continue;
        }
        if (parsed.suspicious?.length) {
          warnings.push(`commands/${entry}: suspicious content detected — ${parsed.suspicious.join(', ')}`);
        }
        commands[trigger] = parsed.command;
        count++;
      }
    } catch (err) {
      warnings.push(`commands/ scan failed: ${err.message}`);
    }
  }

  // Subagents: file name == subagent name. summarizer.md → callable
  // via `ask-subagent { name: "summarizer", question: "..." }`. The
  // global runtime exposes a single generic `ask-subagent` tool;
  // routing to the right body happens in the handler by looking up
  // the union of subagent maps across the user's enabled plugins.
  const agentsDir = join(dir, components.agents ?? 'agents');
  const subagents = {};
  if (existsSync(agentsDir)) {
    try {
      let count = 0;
      for (const entry of readdirSync(agentsDir)) {
        if (!entry.endsWith('.md')) continue;
        if (count >= MAX_FILES_PER_DIR) {
          warnings.push(`agents/ has more than ${MAX_FILES_PER_DIR} files — extras ignored`);
          break;
        }
        if (rejectSymlink(agentsDir, entry)) continue;
        const subagentName = entry.replace(/\.md$/, '');
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(subagentName)) {
          warnings.push(`agents/${entry}: subagent name invalid (must be lowercase a-z, 0-9, dash)`);
          continue;
        }
        const parsed = parseSubagentFile(join(agentsDir, entry));
        if (parsed.error) {
          warnings.push(`agents/${entry}: ${parsed.error}`);
          continue;
        }
        if (parsed.suspicious?.length) {
          warnings.push(`agents/${entry}: suspicious content detected — ${parsed.suspicious.join(', ')}`);
        }
        subagents[subagentName] = parsed.subagent;
        count++;
      }
    } catch (err) {
      warnings.push(`agents/ scan failed: ${err.message}`);
    }
  }

  // Vendor components LLM-IDE does not run. Catalogued for display only —
  // parsing them must never lead to execution (spec: parse-and-ignore).
  // `pending` are the ones a later phase will activate behind their own
  // consent gate (hooks) or MCP consent flow.
  const unsupportedComponents = [];
  const pendingComponents = [];
  if (format === 'claude') {
    for (const rel of ['themes', 'output-styles', 'monitors', 'workflows', 'bin', '.lsp.json', 'settings.json']) {
      if (existsSync(join(dir, rel))) unsupportedComponents.push(rel);
    }
    if (existsSync(join(dir, 'hooks', 'hooks.json'))) pendingComponents.push('hooks');
    if (existsSync(join(dir, '.mcp.json'))) pendingComponents.push('mcp');
    if (unsupportedComponents.length) {
      warnings.push(`unsupported components ignored: ${unsupportedComponents.join(', ')}`);
    }
  }

  return {
    plugin: {
      ...manifest,
      dir,
      format,
      skillsDir,
      skillFiles,
      commands,
      subagents,
      unsupportedComponents,
      pendingComponents,
    },
    warnings,
  };
}

/**
 * Discover every plugin under the per-user plugin root.
 * Returns { plugins, warnings }. Warnings are non-fatal — a bad
 * plugin.json should not block the server from starting.
 */
export function loadPlugins({ pluginDir = defaultPluginDir() } = {}) {
  const plugins = new Map();
  const warnings = [];
  if (!existsSync(pluginDir)) {
    // No plugin directory is the default state on a fresh install — it's
    // created lazily on first plugin import. Absence is NOT a warning (it
    // would print noise on every clean boot); surface it via `missing` for
    // callers that care, and keep `warnings` for genuine load problems.
    return { plugins, warnings: [], pluginDir, missing: true };
  }
  let entries;
  try { entries = readdirSync(pluginDir); }
  catch (err) { return { plugins, warnings: [`scan failed: ${err.message}`], pluginDir }; }

  for (const entry of entries) {
    const full = join(pluginDir, entry);
    let st;
    // Use lstatSync so we inspect the entry itself, NOT its target.
    // Symlinks to directories would otherwise let a plugin author escape
    // the plugin root — a malicious plugin.json could reference paths
    // anywhere on disk that the server process can read.
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      warnings.push(`${entry}: skipped — symbolic links are not allowed as plugin directories`);
      continue;
    }
    if (!st.isDirectory()) continue;
    const result = loadOnePlugin(full);
    if (result.error) {
      warnings.push(`${entry}: ${result.error}`);
      continue;
    }
    if (result.warnings?.length) {
      for (const w of result.warnings) warnings.push(`${entry}: ${w}`);
    }
    if (plugins.has(result.plugin.name)) {
      warnings.push(`${entry}: duplicate plugin name '${result.plugin.name}' — skipping`);
      continue;
    }
    plugins.set(result.plugin.name, result.plugin);
  }
  return { plugins, warnings, pluginDir };
}

/**
 * Expand a slash command — `/summary repo=foo` → expanded prompt
 * string. Returns null if `text` doesn't start with `/` or no
 * matching command in the enabled set.
 *
 * Args parsing supports `key=value` pairs (space-separated, quoted
 * values via simple "..." or '...'). Everything after the recognized
 * args is folded into a `_rest` variable so `/summary repo=foo and
 * also mention the deploy` produces `{{repo}}` + `{{_rest}}`.
 *
 * A template that never references `{{_rest}}` still gets it appended
 * to the end of the expanded prompt, if non-empty. Without this, a
 * template with NO placeholders at all — the norm for commands
 * imported from Claude Code's own marketplace, which use a positional-
 * argument convention this parser doesn't share — would silently drop
 * whatever the user typed after the trigger. `/code-review 123` and
 * bare `/code-review` produced byte-identical prompts before this: the
 * PR number was parsed into `_rest` and then never used anywhere,
 * so the agent had nothing to review. Skipped when the template DOES
 * reference `{{_rest}}` explicitly, so an llm-ide-native template that
 * places it deliberately (e.g. mid-sentence) doesn't get it twice.
 */
export function expandSlashCommand(text, enabledCommands) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const m = trimmed.match(/^\/([a-z][a-z0-9-]{0,40})(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const trigger = m[1];
  const rest = (m[2] || '').trim();
  const cmd = enabledCommands.get(trigger);
  if (!cmd) return null;

  const kv = {};
  let remainder = rest;
  // Parse leading key=value pairs (and key="quoted value").
  const argRe = /^([a-zA-Z][a-zA-Z0-9_]{0,30})=(?:"([^"]*)"|'([^']*)'|(\S+))\s*/;
  while (true) {
    const am = remainder.match(argRe);
    if (!am) break;
    const [matched, k, q1, q2, bare] = am;
    kv[k] = q1 ?? q2 ?? bare;
    remainder = remainder.slice(matched.length);
  }
  kv._rest = remainder.trim();

  // Required-arg check.
  for (const [k, def] of Object.entries(cmd.args || {})) {
    if (def.required && !(k in kv && kv[k])) {
      return {
        error: `Missing required argument '${k}' for /${trigger}`,
        trigger,
      };
    }
  }

  // Substitute {{key}} in the template. Unknown placeholders are
  // left as empty strings — predictable + lets templates degrade
  // gracefully when optional args are omitted.
  const usesRestPlaceholder = cmd.template.includes('{{_rest}}');
  let expanded = cmd.template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return (key in kv) ? String(kv[key]) : '';
  });
  if (kv._rest && !usesRestPlaceholder) {
    expanded += `\n\n${kv._rest}`;
  }
  return { trigger, prompt: expanded, args: kv };
}
