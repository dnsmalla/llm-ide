import { join } from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { defaultPluginDir } from './loader.mjs';
import {
  PLUGIN_NAME_RE, semverNewer, copySkills, copyCmds, countSkills, countCommands,
  listImportedNames, getImportedVersion, copyPluginTree, findVendorManifestRel,
} from './vendor-import-shared.mjs';

export { listImportedNames, getImportedVersion };

/**
 * Root directory where Claude Code stores plugins.
 * Override via $CLAUDE_PLUGINS_DIR for tests.
 */
export function claudePluginsRoot() {
  if (process.env.CLAUDE_PLUGINS_DIR) return process.env.CLAUDE_PLUGINS_DIR;
  return join(os.homedir(), '.claude', 'plugins');
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
 * Import a Claude Code plugin into LLM-IDE' plugin directory.
 * @param {object} opts
 * @param {string} [opts.claudeRoot] - Override Claude plugins root
 * @param {string} [opts.llmidePluginDir] - Override LLM-IDE plugin dir
 * @param {'installed'|'marketplace'} opts.source
 * @param {string} opts.name - Plugin name
 * @returns {{ ok: boolean, plugin?: object, error?: string }}
 */
export function importPlugin(opts) {
  const claudeRoot = opts.claudeRoot || claudePluginsRoot();
  const mnDir = opts.llmidePluginDir || defaultPluginDir();
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
  if (!PLUGIN_NAME_RE.test(mnName)) {
    return { ok: false, error: `namespaced name '${mnName}' is too long to install` };
  }

  // Manifest-bearing source: copy the tree whole — llm-ide's loader reads the
  // vendor manifest natively, so there is no generated plugin.json and no
  // lossy flattening. agents/, hooks/ (catalogued only), and nested skill
  // directories all survive. Manifest-less sources keep the legacy adapted
  // path below.
  const vendorRel = findVendorManifestRel(sourceDir);
  if (vendorRel) {
    let vendorManifest;
    try { vendorManifest = JSON.parse(readFileSync(join(sourceDir, vendorRel), 'utf8')); }
    catch { return { ok: false, error: 'vendor plugin.json is not valid JSON' }; }
    if (typeof vendorManifest.name !== 'string' || !PLUGIN_NAME_RE.test(vendorManifest.name)) {
      return { ok: false, error: `vendor manifest name invalid (got ${JSON.stringify(vendorManifest.name)})` };
    }
    const vendorVersion = (typeof vendorManifest.version === 'string' && /^\d+\.\d+\.\d+/.test(vendorManifest.version))
      ? vendorManifest.version : '0.0.0';
    // Clean start — a stale file from an earlier lossy import must not linger
    // beside the whole-tree copy.
    rmSync(targetDir, { recursive: true, force: true });
    let copied;
    try { copied = copyPluginTree(sourceDir, targetDir); }
    catch (err) {
      rmSync(targetDir, { recursive: true, force: true });
      return { ok: false, error: `plugin tree not copied: ${err.message}` };
    }
    // Namespace the copy: rewrite ONLY the name field so the imported plugin's
    // identity matches its directory (claude-<name>) — enable state and
    // update-checking key off that identity. Everything else is preserved
    // verbatim; this is not a lossy regeneration.
    writeFileSync(join(targetDir, vendorRel),
      JSON.stringify({ ...vendorManifest, name: mnName, version: vendorVersion }, null, 2), 'utf8');
    return {
      ok: true,
      warnings: copied.skipped.length > 0 ? copied.skipped : undefined,
      plugin: {
        name: mnName,
        version: vendorVersion,
        displayName: vendorManifest.displayName || name,
        description: vendorManifest.description || `Imported from Claude Code (${source})`,
        author: typeof vendorManifest.author === 'string'
          ? vendorManifest.author
          : vendorManifest.author?.name || 'Claude Code',
        skillCount: countSkills(join(targetDir, 'skills')),
        commandCount: countCommands(join(targetDir, 'commands')),
        origin: 'claude',
      },
    };
  }

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
 * Check for updates: compare imported plugin versions against Claude source.
 * @param {object} [opts]
 * @param {string} [opts.claudeRoot] - Override Claude plugins root
 * @param {string} [opts.llmidePluginDir] - Override LLM-IDE plugin dir
 * @returns {Array<{name: string, importedVersion: string, sourceVersion: string, source: string}>}
 */
export function checkForUpdates(opts = {}) {
  const claudeRoot = opts.claudeRoot || claudePluginsRoot();
  const mnDir = opts.llmidePluginDir || defaultPluginDir();

  const imported = listImportedNames(mnDir);
  const updates = [];

  for (const mnName of imported) {
    // Own-format imports carry `origin` in their generated manifest; a
    // whole-tree vendor copy has no root manifest at all and IS claude-origin
    // by construction (only the import path creates one).
    const vendorRel = findVendorManifestRel(join(mnDir, mnName));
    let importedVersion;
    // A vendor copy keeps no `sourcePlugin` field, so the source name comes
    // from the directory — as-is first, then with the namespace prefix
    // stripped, since a plugin already called `claude-*` is never re-prefixed.
    let sourceNames;
    if (vendorRel) {
      try {
        importedVersion = JSON.parse(readFileSync(join(mnDir, mnName, vendorRel), 'utf8')).version || '0.0.0';
      } catch { continue; }
      sourceNames = [mnName, mnName.replace(/^claude-/, '')];
    } else {
      const manifestPath = join(mnDir, mnName, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
      if (manifest.origin !== 'claude') continue;
      importedVersion = manifest.version || '0.0.0';
      sourceNames = [manifest.sourcePlugin || mnName.replace(/^claude-/, '')];
    }

    // Check installed first, then marketplace
    let found = false;
    for (const source of ['installed', 'marketplace']) {
      for (const sourceName of sourceNames) {
        const sourceDir = findClaudePlugin(claudeRoot, source, sourceName);
        if (!sourceDir) continue;
        found = true;

        // A vendor manifest outranks package.json for the source version;
        // first present file wins.
        let sourceVersion = '0.0.0';
        for (const rel of [findVendorManifestRel(sourceDir), 'package.json']) {
          if (!rel) continue;
          const p = join(sourceDir, rel);
          if (!existsSync(p)) continue;
          try {
            const parsed = JSON.parse(readFileSync(p, 'utf8'));
            if (typeof parsed.version === 'string') sourceVersion = parsed.version;
          } catch { /* use default */ }
          break;
        }

        if (semverNewer(sourceVersion, importedVersion)) {
          updates.push({
            name: mnName,
            importedVersion,
            sourceVersion,
            source,
          });
        }
        break;
      }
      if (found) break; // Found source, stop checking
    }
  }
  return updates;
}
