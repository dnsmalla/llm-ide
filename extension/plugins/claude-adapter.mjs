import { join } from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, copyFileSync, lstatSync } from 'node:fs';
import { defaultPluginDir } from './loader.mjs';

// Plugin names are joined into filesystem paths (findClaudePlugin, targetDir),
// so they MUST be validated to prevent path traversal (e.g. "../../etc").
// Mirrors loader.mjs NAME_RE — lowercase, starts with a letter, hyphens ok.
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * Semver-aware version comparison.
 * Returns true if `a` is strictly newer than `b`.
 * Falls back to string inequality for non-semver strings.
 * Treats '0.0.0' as "unknown" (never considered newer).
 */
function semverNewer(a, b) {
  if (!a || a === '0.0.0') return false;
  if (!b || b === '0.0.0') return true;
  const parse = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  if (aPatch !== bPatch) return aPatch > bPatch;
  return false; // equal
}

/**
 * Root directory where Claude Code stores plugins.
 * Override via $CLAUDE_PLUGINS_DIR for tests.
 */
export function claudePluginsRoot() {
  if (process.env.CLAUDE_PLUGINS_DIR) return process.env.CLAUDE_PLUGINS_DIR;
  return join(os.homedir(), '.claude', 'plugins');
}

/**
 * Count skills in a Claude Code skills directory.
 * Counts: nested `skills/<name>/SKILL.md` dirs + flat `skills/<name>.md` files.
 * Ignores READMEs and other non-skill .md files in nested dirs.
 */
function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        // Claude nested format: skills/<name>/SKILL.md
        if (existsSync(join(dir, e.name, 'SKILL.md'))) count++;
      } else if (e.name.endsWith('.md')) {
        // Flat format: skills/<name>.md
        count++;
      }
    }
  } catch { /* permission error, etc. */ }
  return count;
}

/**
 * Count commands: only flat .md files in commands/.
 */
function countCommands(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) count++;
    }
  } catch { /* permission error, etc. */ }
  return count;
}

/**
 * Parse installed_plugins.json and scan cache dirs for skill/command counts.
 * @param {string} [rootOverride] - Override root for tests
 * @returns {Array<{name: string, version: string, marketplace: string, installPath: string, skillCount: number, commandCount: number, installedAt: string|null}>}
 */
export function scanInstalled(rootOverride) {
  const root = rootOverride || claudePluginsRoot();
  const indexPath = join(root, 'installed_plugins.json');
  if (!existsSync(indexPath)) return [];

  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch { return []; }

  if (!index || typeof index.plugins !== 'object') return [];

  const results = [];
  for (const [key, entries] of Object.entries(index.plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const atIdx = key.lastIndexOf('@');
    const pluginName = atIdx > 0 ? key.slice(0, atIdx) : key;
    const marketplace = atIdx > 0 ? key.slice(atIdx + 1) : 'unknown';

    const entry = entries[entries.length - 1];
    const installPath = entry.installPath;
    if (!installPath || !existsSync(installPath)) continue;

    const skillCount = countSkills(join(installPath, 'skills'));
    const commandCount = countCommands(join(installPath, 'commands'));

    results.push({
      name: pluginName,
      version: entry.version || '0.0.0',
      marketplace,
      installPath,
      skillCount,
      commandCount,
      installedAt: entry.installedAt || null,
    });
  }
  return results;
}

/**
 * Scan Claude Code marketplace cache directories.
 * @param {string} [rootOverride] - Override root for tests
 * @returns {Array<{name: string, marketplace: string, description: string, hasSkills: boolean, hasCommands: boolean}>}
 */
export function scanMarketplace(rootOverride) {
  const root = rootOverride || claudePluginsRoot();
  const mpRoot = join(root, 'marketplaces');
  if (!existsSync(mpRoot)) return [];

  const results = [];
  let marketplaceDirs;
  try { marketplaceDirs = readdirSync(mpRoot, { withFileTypes: true }); }
  catch { return []; }

  for (const mpEntry of marketplaceDirs) {
    if (!mpEntry.isDirectory()) continue;
    const pluginsDir = join(mpRoot, mpEntry.name, 'plugins');
    if (!existsSync(pluginsDir)) continue;

    let pluginDirs;
    try { pluginDirs = readdirSync(pluginsDir, { withFileTypes: true }); }
    catch { continue; }

    for (const pEntry of pluginDirs) {
      if (!pEntry.isDirectory()) continue;
      const pDir = join(pluginsDir, pEntry.name);
      const hasSkills = existsSync(join(pDir, 'skills'));
      const hasCommands = existsSync(join(pDir, 'commands'));
      let description = '';
      const readmePath = join(pDir, 'README.md');
      if (existsSync(readmePath)) {
        try {
          const raw = readFileSync(readmePath, 'utf8');
          const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'));
          description = (lines[0] || '').trim().slice(0, 200);
        } catch { /* ignore */ }
      }
      results.push({
        name: pEntry.name,
        marketplace: mpEntry.name,
        description,
        hasSkills,
        hasCommands,
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Import a Claude Code plugin into Meet Notes' plugin directory.
 * @param {object} opts
 * @param {string} [opts.claudeRoot] - Override Claude plugins root
 * @param {string} [opts.meetnotesPluginDir] - Override MeetNotes plugin dir
 * @param {'installed'|'marketplace'} opts.source
 * @param {string} opts.name - Plugin name
 * @returns {{ ok: boolean, plugin?: object, error?: string }}
 */
export function importPlugin(opts) {
  const claudeRoot = opts.claudeRoot || claudePluginsRoot();
  const mnDir = opts.meetnotesPluginDir || defaultPluginDir();
  const { source, name } = opts;

  // Validate BEFORE any path join — `name` and `source` reach the
  // filesystem in findClaudePlugin/targetDir and an unvalidated name
  // ("../../etc") would traverse outside the plugin roots.
  if (source !== 'installed' && source !== 'marketplace') {
    return { ok: false, error: `source must be 'installed' or 'marketplace' (got ${JSON.stringify(source)})` };
  }
  if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) {
    return { ok: false, error: `name must match ${PLUGIN_NAME_RE} (got ${JSON.stringify(name)})` };
  }

  const sourceDir = findClaudePlugin(claudeRoot, source, name);
  if (!sourceDir) {
    return { ok: false, error: `Plugin '${name}' not found in Claude ${source} directory` };
  }

  const mnName = name.startsWith('claude-') ? name : `claude-${name}`;
  const targetDir = join(mnDir, mnName);

  let version = '0.0.0';
  const pkgPath = join(sourceDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.version === 'string') version = pkg.version;
    } catch { /* use default */ }
  }

  mkdirSync(targetDir, { recursive: true });
  const manifest = {
    name: mnName,
    version,
    displayName: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description: `Imported from Claude Code (${source})`,
    author: 'Claude Code',
    origin: 'claude',
    sourcePlugin: name,
    sourceMarketplace: source === 'marketplace' ? findMarketplaceName(claudeRoot, name) : null,
  };
  writeFileSync(join(targetDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');

  let skillCount = 0;
  const skillWarnings = [];
  const skillsDir = join(sourceDir, 'skills');
  if (existsSync(skillsDir)) {
    const targetSkills = join(targetDir, 'skills');
    mkdirSync(targetSkills, { recursive: true });
    const result = copySkills(skillsDir, targetSkills);
    skillCount = result.count;
    if (result.skipped.length > 0) {
      skillWarnings.push(...result.skipped.map(s => `Skill skipped (too large): ${s}`));
    }
  }

  let commandCount = 0;
  const cmdsDir = join(sourceDir, 'commands');
  if (existsSync(cmdsDir)) {
    const targetCmds = join(targetDir, 'commands');
    mkdirSync(targetCmds, { recursive: true });
    commandCount = copyCmds(cmdsDir, targetCmds);
  }

  return {
    ok: true,
    warnings: skillWarnings.length > 0 ? skillWarnings : undefined,
    plugin: {
      name: mnName,
      version,
      displayName: manifest.displayName,
      description: manifest.description,
      author: manifest.author,
      skillCount,
      commandCount,
      origin: 'claude',
    },
  };
}

function findClaudePlugin(root, source, name) {
  if (source === 'installed') {
    const cacheDir = join(root, 'cache');
    if (!existsSync(cacheDir)) return null;
    try {
      for (const mp of readdirSync(cacheDir, { withFileTypes: true })) {
        if (!mp.isDirectory()) continue;
        const pluginDir = join(cacheDir, mp.name, name);
        if (existsSync(pluginDir)) {
          const versions = readdirSync(pluginDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort()
            .reverse();
          if (versions.length > 0) return join(pluginDir, versions[0]);
          return pluginDir;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  if (source === 'marketplace') {
    const mpRoot = join(root, 'marketplaces');
    if (!existsSync(mpRoot)) return null;
    try {
      for (const mp of readdirSync(mpRoot, { withFileTypes: true })) {
        if (!mp.isDirectory()) continue;
        const pDir = join(mpRoot, mp.name, 'plugins', name);
        if (existsSync(pDir)) return pDir;
      }
    } catch { /* ignore */ }
    return null;
  }

  return null;
}

function findMarketplaceName(root, pluginName) {
  const mpRoot = join(root, 'marketplaces');
  if (!existsSync(mpRoot)) return null;
  try {
    for (const mp of readdirSync(mpRoot, { withFileTypes: true })) {
      if (!mp.isDirectory()) continue;
      if (existsSync(join(mpRoot, mp.name, 'plugins', pluginName))) return mp.name;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Copy and adapt Claude Code skills into MeetNotes format.
 * Claude Code skills may lack the `kind` and `name` fields that
 * MeetNotes' skill-loader requires. This function injects them
 * during import so the skills actually load at LLM runtime.
 *
 * - `kind` defaults to 'read' (Claude skills are contextual/informational)
 * - `name` is set from the output filename (minus .md extension)
 */
function copySkills(src, dst) {
  let count = 0;
  const skipped = [];
  const MAX_BYTES = 32_768;
  try {
    const sources = [];
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skillFile = join(src, entry.name, 'SKILL.md');
        if (existsSync(skillFile)) {
          const stat = statSync(skillFile);
          if (stat.size <= MAX_BYTES) {
            sources.push({ srcPath: skillFile, dstName: `${entry.name}.md` });
          } else {
            skipped.push(`${entry.name} (${Math.round(stat.size / 1024)}KB > 32KB limit)`);
          }
        }
      } else if (entry.name.endsWith('.md')) {
        const stat = statSync(join(src, entry.name));
        if (stat.size <= MAX_BYTES) {
          sources.push({ srcPath: join(src, entry.name), dstName: entry.name });
        } else {
          skipped.push(`${entry.name} (${Math.round(stat.size / 1024)}KB > 32KB limit)`);
        }
      }
    }

    for (const { srcPath, dstName } of sources) {
      const raw = readFileSync(srcPath, 'utf8');
      const adapted = adaptSkillFrontmatter(raw, dstName.replace(/\.md$/, ''));
      writeFileSync(join(dst, dstName), adapted, 'utf8');
      count++;
    }
  } catch { /* ignore */ }
  return { count, skipped };
}

/**
 * Ensure a Claude Code skill .md file has the frontmatter fields
 * required by MeetNotes' skill-loader: `name` and `kind`.
 * If frontmatter exists but lacks these, inject them.
 * If no frontmatter at all, wrap the content with a minimal one.
 */
function adaptSkillFrontmatter(raw, expectedName) {
  // Use multiline mode so `^---$` matches a line that is ONLY `---`,
  // preventing a `---` embedded in a YAML string value from closing
  // the frontmatter block prematurely.
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n^---\s*\n([\s\S]*)$/m);
  if (!fmMatch) {
    // No frontmatter — create one
    return `---\nname: ${expectedName}\nkind: read\ndescription: "Imported from Claude Code"\n---\n${raw}`;
  }

  let frontmatter = fmMatch[1];
  const body = fmMatch[2];
  let changed = false;

  // Inject `name` if missing or wrong
  if (!/^name:/m.test(frontmatter)) {
    frontmatter = `name: ${expectedName}\n${frontmatter}`;
    changed = true;
  } else {
    // Fix name to match expected filename
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    if (nameMatch && nameMatch[1].trim() !== expectedName) {
      frontmatter = frontmatter.replace(/^name:\s*.+$/m, `name: ${expectedName}`);
      changed = true;
    }
  }

  // Inject `kind` if missing — Claude Code skills default to 'read'
  if (!/^kind:/m.test(frontmatter)) {
    frontmatter = `${frontmatter}\nkind: read`;
    changed = true;
  }

  return `---\n${frontmatter}\n---\n${body}`;
}

function copyCmds(src, dst) {
  let count = 0;
  const MAX_BYTES = 16_384;
  try {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const stat = statSync(join(src, entry.name));
      if (stat.size <= MAX_BYTES) {
        copyFileSync(join(src, entry.name), join(dst, entry.name));
        count++;
      }
    }
  } catch { /* ignore */ }
  return count;
}

/**
 * Lightweight check: list MeetNotes plugin directory names (no full load).
 * Returns a Set of plugin folder names from the MeetNotes plugin dir.
 * @param {string} [mnDirOverride] - Override for tests
 * @returns {Set<string>}
 */
export function listImportedNames(mnDirOverride) {
  const dir = mnDirOverride || defaultPluginDir();
  if (!existsSync(dir)) return new Set();
  const names = new Set();
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip symlinks (same policy as loader.mjs)
      try { if (lstatSync(join(dir, entry.name)).isSymbolicLink()) continue; } catch { continue; }
      // Must have a plugin.json to be a real plugin
      if (existsSync(join(dir, entry.name, 'plugin.json'))) {
        names.add(entry.name);
      }
    }
  } catch { /* ignore */ }
  return names;
}

/**
 * Read the version from a MeetNotes-imported plugin's manifest.
 * @param {string} pluginName - MeetNotes plugin name (e.g., 'claude-code-review')
 * @param {string} [mnDirOverride] - Override for tests
 * @returns {string|null}
 */
export function getImportedVersion(pluginName, mnDirOverride) {
  const dir = mnDirOverride || defaultPluginDir();
  const manifestPath = join(dir, pluginName, 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return manifest.version || null;
  } catch { return null; }
}

/**
 * Check for updates: compare imported plugin versions against Claude source.
 * @param {object} [opts]
 * @param {string} [opts.claudeRoot] - Override Claude plugins root
 * @param {string} [opts.meetnotesPluginDir] - Override MeetNotes plugin dir
 * @returns {Array<{name: string, importedVersion: string, sourceVersion: string, source: string}>}
 */
export function checkForUpdates(opts = {}) {
  const claudeRoot = opts.claudeRoot || claudePluginsRoot();
  const mnDir = opts.meetnotesPluginDir || defaultPluginDir();

  const imported = listImportedNames(mnDir);
  const updates = [];

  for (const mnName of imported) {
    // Only check claude-originated plugins
    const manifestPath = join(mnDir, mnName, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
    if (manifest.origin !== 'claude') continue;

    const sourceName = manifest.sourcePlugin || mnName.replace(/^claude-/, '');
    const importedVersion = manifest.version || '0.0.0';

    // Check installed first, then marketplace
    for (const source of ['installed', 'marketplace']) {
      const sourceDir = findClaudePlugin(claudeRoot, source, sourceName);
      if (!sourceDir) continue;

      let sourceVersion = '0.0.0';
      const pkgPath = join(sourceDir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
          if (typeof pkg.version === 'string') sourceVersion = pkg.version;
        } catch { /* use default */ }
      }

      if (semverNewer(sourceVersion, importedVersion)) {
        updates.push({
          name: mnName,
          importedVersion,
          sourceVersion,
          source,
        });
      }
      break; // Found source, stop checking
    }
  }
  return updates;
}
