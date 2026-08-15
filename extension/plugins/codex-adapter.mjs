// Bridges OpenAI Codex CLI's plugin system into llm-ide, mirroring
// claude-adapter.mjs's shape (scanInstalled/scanMarketplace/importPlugin/
// checkForUpdates) but adapted to Codex's actual on-disk layout, which
// differs from Claude Code's in two real ways:
//
//   1. The "is this installed" registry lives in `~/.codex/config.toml`'s
//      `[plugins."name@marketplace"]` table (parsed via core/toml-lite.mjs —
//      a narrow TOML subset, not a full parser; see that file for exactly
//      what it supports), not a JSON index file.
//   2. Each Codex plugin's own manifest (`.codex-plugin/plugin.json`) already
//      carries `version` and `description` directly — no package.json
//      fallback needed the way Claude Code plugins sometimes require.
//
// Skill FORMAT is identical between the two vendors (skills/<name>/SKILL.md,
// same frontmatter shape, no `kind` field) — see vendor-import-shared.mjs for
// the copy/adapt logic shared with claude-adapter.mjs. Neither Codex plugin
// examined during development (openai's own documents/spreadsheets/
// presentations/google-drive/browser bundles) had a `commands/` directory,
// so command import is best-effort/defensive rather than a documented Codex
// capability.
import { join } from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseTomlLite } from '../core/toml-lite.mjs';
import { defaultPluginDir } from './loader.mjs';
import {
  PLUGIN_NAME_RE, semverNewer, copySkills, copyCmds, countSkills, countCommands,
  listImportedNames, getImportedVersion,
} from './vendor-import-shared.mjs';

export { listImportedNames, getImportedVersion };

/**
 * Codex's own home directory. Override via $CODEX_HOME_DIR for tests.
 */
export function codexHome() {
  if (process.env.CODEX_HOME_DIR) return process.env.CODEX_HOME_DIR;
  return join(os.homedir(), '.codex');
}

function readConfigToml(home) {
  const p = join(home, 'config.toml');
  if (!existsSync(p)) return {};
  try { return parseTomlLite(readFileSync(p, 'utf8')); } catch { return {}; }
}

// `.codex-plugin/plugin.json` — version/description/name live here directly,
// unlike Claude Code plugins which sometimes need a package.json fallback.
function readCodexManifest(pluginVersionDir) {
  const p = join(pluginVersionDir, '.codex-plugin', 'plugin.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    return (m && typeof m === 'object') ? m : null;
  } catch { return null; }
}

/**
 * Parse config.toml's installed-plugins table + scan the cache dirs for
 * skill/command counts.
 * @param {string} [rootOverride] - Override $CODEX_HOME_DIR-equivalent root for tests
 * @returns {Array<{name, version, marketplace, installPath, skillCount, commandCount, enabled}>}
 */
export function scanInstalled(rootOverride) {
  const root = rootOverride || codexHome();
  const config = readConfigToml(root);
  const pluginsTable = (config.plugins && typeof config.plugins === 'object') ? config.plugins : {};

  const results = [];
  for (const [key, entry] of Object.entries(pluginsTable)) {
    const atIdx = key.lastIndexOf('@');
    const pluginName = atIdx > 0 ? key.slice(0, atIdx) : key;
    const marketplace = atIdx > 0 ? key.slice(atIdx + 1) : 'unknown';

    const installPath = findCodexPlugin(root, 'installed', pluginName, marketplace);
    if (!installPath) continue;

    const manifest = readCodexManifest(installPath);
    const skillCount = countSkills(join(installPath, 'skills'));
    const commandCount = countCommands(join(installPath, 'commands'));

    results.push({
      name: pluginName,
      version: manifest?.version || '0.0.0',
      marketplace,
      installPath,
      skillCount,
      commandCount,
      enabled: entry?.enabled !== false,
    });
  }
  return results;
}

/**
 * Scan Codex marketplace source directories registered in config.toml.
 * @param {string} [rootOverride] - Override for tests
 * @returns {Array<{name, marketplace, description, hasSkills, hasCommands}>}
 */
export function scanMarketplace(rootOverride) {
  const root = rootOverride || codexHome();
  const config = readConfigToml(root);
  const marketplaces = (config.marketplaces && typeof config.marketplaces === 'object') ? config.marketplaces : {};

  const results = [];
  for (const [mpName, mp] of Object.entries(marketplaces)) {
    const source = typeof mp?.source === 'string' ? mp.source : null;
    if (!source) continue;
    const pluginsDir = join(source, 'plugins');
    if (!existsSync(pluginsDir)) continue;

    let pluginDirs;
    try { pluginDirs = readdirSync(pluginsDir, { withFileTypes: true }); }
    catch { continue; }

    for (const pEntry of pluginDirs) {
      if (!pEntry.isDirectory()) continue;
      const pDir = join(pluginsDir, pEntry.name);
      const manifest = readCodexManifest(pDir);
      results.push({
        name: pEntry.name,
        marketplace: mpName,
        description: typeof manifest?.description === 'string' ? manifest.description.slice(0, 200) : '',
        hasSkills: existsSync(join(pDir, 'skills')),
        hasCommands: existsSync(join(pDir, 'commands')),
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Import a Codex plugin into llm-ide's plugin directory.
 * @param {object} opts
 * @param {string} [opts.codexRoot] - Override Codex home for tests
 * @param {string} [opts.llmidePluginDir] - Override llm-ide plugin dir
 * @param {'installed'|'marketplace'} opts.source
 * @param {string} opts.name - Plugin name
 * @returns {{ ok: boolean, plugin?: object, error?: string, warnings?: string[] }}
 */
export function importPlugin(opts) {
  const codexRoot = opts.codexRoot || codexHome();
  const mnDir = opts.llmidePluginDir || defaultPluginDir();
  const { source, name } = opts;

  if (source !== 'installed' && source !== 'marketplace') {
    return { ok: false, error: `source must be 'installed' or 'marketplace' (got ${JSON.stringify(source)})` };
  }
  if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) {
    return { ok: false, error: `name must match ${PLUGIN_NAME_RE} (got ${JSON.stringify(name)})` };
  }

  const sourceDir = findCodexPlugin(codexRoot, source, name);
  if (!sourceDir) {
    return { ok: false, error: `Plugin '${name}' not found in Codex ${source} directory` };
  }

  const mnName = name.startsWith('codex-') ? name : `codex-${name}`;
  const targetDir = join(mnDir, mnName);

  const sourceManifest = readCodexManifest(sourceDir) || {};
  const version = typeof sourceManifest.version === 'string' ? sourceManifest.version : '0.0.0';
  const description = typeof sourceManifest.description === 'string'
    ? sourceManifest.description.slice(0, 200)
    : `Imported from Codex (${source})`;

  mkdirSync(targetDir, { recursive: true });
  const manifest = {
    name: mnName,
    version,
    displayName: name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description,
    author: 'OpenAI Codex',
    origin: 'codex',
    sourcePlugin: name,
    sourceMarketplace: source === 'marketplace' ? findMarketplaceName(codexRoot, name) : null,
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
      skillWarnings.push(...result.skipped.map((s) => `Skill skipped (too large): ${s}`));
    }
  }

  // Defensive: no Codex plugin examined during development has one, but
  // nothing rules it out for a future/third-party marketplace plugin.
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
      origin: 'codex',
    },
  };
}

/**
 * Locate a Codex plugin's on-disk directory.
 * 'installed': `<root>/plugins/cache/<marketplace>/<name>/<version>/` —
 *   `marketplaceHint` (from config.toml's own "name@marketplace" key) is
 *   used when known; otherwise brute-forces every cached marketplace dir,
 *   same as Claude Code's adapter does for its own cache layout.
 * 'marketplace': `<marketplaces.X.source>/plugins/<name>/`, resolved from
 *   config.toml's marketplace table.
 */
function findCodexPlugin(root, source, name, marketplaceHint) {
  if (source === 'installed') {
    const cacheDir = join(root, 'plugins', 'cache');
    if (!existsSync(cacheDir)) return null;
    const tryMarketplace = (mpName) => {
      const pluginDir = join(cacheDir, mpName, name);
      if (!existsSync(pluginDir)) return null;
      let versions;
      try {
        versions = readdirSync(pluginDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
          .reverse();
      } catch { return null; }
      return versions.length > 0 ? join(pluginDir, versions[0]) : pluginDir;
    };
    if (marketplaceHint) {
      const hit = tryMarketplace(marketplaceHint);
      if (hit) return hit;
    }
    try {
      for (const mp of readdirSync(cacheDir, { withFileTypes: true })) {
        if (!mp.isDirectory()) continue;
        const hit = tryMarketplace(mp.name);
        if (hit) return hit;
      }
    } catch { /* ignore */ }
    return null;
  }

  if (source === 'marketplace') {
    const config = readConfigToml(root);
    const marketplaces = (config.marketplaces && typeof config.marketplaces === 'object') ? config.marketplaces : {};
    for (const mp of Object.values(marketplaces)) {
      const src = typeof mp?.source === 'string' ? mp.source : null;
      if (!src) continue;
      const pDir = join(src, 'plugins', name);
      if (existsSync(pDir)) return pDir;
    }
    return null;
  }

  return null;
}

function findMarketplaceName(root, pluginName) {
  const config = readConfigToml(root);
  const marketplaces = (config.marketplaces && typeof config.marketplaces === 'object') ? config.marketplaces : {};
  for (const [mpName, mp] of Object.entries(marketplaces)) {
    const src = typeof mp?.source === 'string' ? mp.source : null;
    if (src && existsSync(join(src, 'plugins', pluginName))) return mpName;
  }
  return null;
}

/**
 * Check for updates: compare imported plugin versions against Codex source.
 * @param {object} [opts]
 * @param {string} [opts.codexRoot] - Override for tests
 * @param {string} [opts.llmidePluginDir] - Override for tests
 * @returns {Array<{name, importedVersion, sourceVersion, source}>}
 */
export function checkForUpdates(opts = {}) {
  const codexRoot = opts.codexRoot || codexHome();
  const mnDir = opts.llmidePluginDir || defaultPluginDir();

  const imported = listImportedNames(mnDir);
  const updates = [];

  for (const mnName of imported) {
    const manifestPath = join(mnDir, mnName, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
    if (manifest.origin !== 'codex') continue;

    const sourceName = manifest.sourcePlugin || mnName.replace(/^codex-/, '');
    const importedVersion = manifest.version || '0.0.0';

    for (const source of ['installed', 'marketplace']) {
      const sourceDir = findCodexPlugin(codexRoot, source, sourceName);
      if (!sourceDir) continue;

      const sourceManifest = readCodexManifest(sourceDir);
      const sourceVersion = typeof sourceManifest?.version === 'string' ? sourceManifest.version : '0.0.0';

      if (semverNewer(sourceVersion, importedVersion)) {
        updates.push({ name: mnName, importedVersion, sourceVersion, source });
      }
      break;
    }
  }
  return updates;
}
