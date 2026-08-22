// Shared logic between the Claude Code and Codex plugin-import adapters
// (claude-adapter.mjs, codex-adapter.mjs) — both vendors ship skills in the
// SAME shape (skills/<name>/SKILL.md, YAML frontmatter with name+description,
// no `kind` field), so llm-ide's flatten-and-adapt step is identical either
// way. Plugin-registry layout (Claude's installed_plugins.json vs Codex's
// config.toml) and marketplace discovery differ per vendor and stay in each
// adapter.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPluginDir } from './loader.mjs';

// Plugin names are joined into filesystem paths, so they MUST be validated to
// prevent path traversal (e.g. "../../etc").
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

// Where a vendor package keeps its manifest. Claude Code and Codex use
// different dot-dirs for the same JSON shape, and llm-ide's loader reads
// either in place — so a manifest-bearing source is imported whole rather
// than flattened into the own format.
export const VENDOR_MANIFEST_RELS = Object.freeze([
  join('.claude-plugin', 'plugin.json'),
  join('.codex-plugin', 'plugin.json'),
]);

/** The vendor manifest inside `dir`, or null when there is none. */
export function findVendorManifestRel(dir) {
  return VENDOR_MANIFEST_RELS.find((rel) => existsSync(join(dir, rel))) || null;
}

// Tree-copy limits for whole-plugin imports. Deliberately more generous than
// the zip path (5 MB) because vendor trees can carry references/ and assets/
// alongside SKILL.md — but still bounded.
export const TREE_COPY_LIMITS = Object.freeze({
  maxFileBytes: 512 * 1024, maxTotalBytes: 10 * 1024 * 1024, maxFiles: 500,
});

/**
 * Copy a vendor plugin tree wholesale, layout preserved. Symlinks are skipped
 * (same policy as the loader), oversized files skipped, and the whole copy
 * aborts if the tree exceeds the total/file-count limits — callers delete the
 * partial target so a half-copied plugin is never left behind. Throws on a
 * limit breach.
 * @returns {{files: number, skipped: string[]}}
 */
export function copyPluginTree(src, dst) {
  let totalBytes = 0;
  let files = 0;
  const skipped = [];
  const walk = (from, to, prefix) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      const label = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { skipped.push(`${label}: symlink rejected`); continue; }
      const fromPath = join(from, e.name);
      const toPath = join(to, e.name);
      if (e.isDirectory()) { walk(fromPath, toPath, label); continue; }
      if (!e.isFile()) continue; // fifos, sockets, devices
      if (files >= TREE_COPY_LIMITS.maxFiles) throw new Error('plugin exceeds max file count');
      const size = statSync(fromPath).size;
      if (size > TREE_COPY_LIMITS.maxFileBytes) { skipped.push(`${label}: too large`); continue; }
      totalBytes += size;
      files += 1;
      if (totalBytes > TREE_COPY_LIMITS.maxTotalBytes) throw new Error('plugin exceeds max total bytes');
      copyFileSync(fromPath, toPath);
    }
  };
  walk(src, dst, '');
  return { files, skipped };
}

/**
 * Semver-aware version comparison. Returns true if `a` is strictly newer
 * than `b`. Falls back to string inequality for non-semver strings. Treats
 * '0.0.0' as "unknown" (never considered newer).
 */
export function semverNewer(a, b) {
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
 * Ensure an imported skill .md file has the frontmatter fields llm-ide's
 * skill-loader requires: `name` and `kind`. Neither Claude Code's nor
 * Codex's skill frontmatter carries `kind` at all, and a nested skill's
 * own `name:` (if present) may not match the flattened filename we're
 * writing it under — both get injected/corrected here.
 */
function adaptSkillFrontmatter(raw, expectedName) {
  // Multiline mode so `^---$` matches a line that is ONLY `---`, preventing a
  // `---` embedded in a YAML string value from closing the block prematurely.
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n^---\s*\n([\s\S]*)$/m);
  if (!fmMatch) {
    return `---\nname: ${expectedName}\nkind: read\ndescription: "Imported skill"\n---\n${raw}`;
  }

  let frontmatter = fmMatch[1];
  const body = fmMatch[2];

  if (!/^name:/m.test(frontmatter)) {
    frontmatter = `name: ${expectedName}\n${frontmatter}`;
  } else {
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    if (nameMatch && nameMatch[1].trim() !== expectedName) {
      frontmatter = frontmatter.replace(/^name:\s*.+$/m, `name: ${expectedName}`);
    }
  }

  if (!/^kind:/m.test(frontmatter)) {
    frontmatter = `${frontmatter}\nkind: read`;
  }

  return `---\n${frontmatter}\n---\n${body}`;
}

/**
 * Copy and adapt a vendor's nested `skills/<name>/SKILL.md` (or flat
 * `skills/<name>.md`) tree into llm-ide's flat `skills/<name>.md` shape,
 * injecting the frontmatter fields the loader requires.
 * @returns {{count: number, skipped: string[]}}
 */
export function copySkills(src, dst) {
  let count = 0;
  const skipped = [];
  // Real Codex office-suite skills (documents/presentations/spreadsheets/
  // browser) run 36-51KB — bigger than any Claude Code skill seen so far.
  // 64KB gives headroom above the largest observed (browser, ~51KB) while
  // staying a bounded per-skill-file cap, not unlimited.
  const MAX_BYTES = 65_536;
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

/** Copy flat `commands/*.md` files under a size cap. Neither vendor's every
 * plugin has one (Codex plugins so far never do), so this is a no-op when
 * `src` doesn't exist — callers already gate on existsSync(src) too. */
export function copyCmds(src, dst) {
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

/** Count skills in a vendor plugin dir: nested `skills/<name>/SKILL.md` dirs
 * plus flat `skills/<name>.md` files. Ignores READMEs/other non-skill .md. */
export function countSkills(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (existsSync(join(dir, e.name, 'SKILL.md'))) count++;
      } else if (e.name.endsWith('.md')) {
        count++;
      }
    }
  } catch { /* permission error, etc. */ }
  return count;
}

/** Count commands: flat .md files directly in commands/. */
export function countCommands(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) count++;
    }
  } catch { /* permission error, etc. */ }
  return count;
}

/**
 * Lightweight check: list llm-ide plugin directory names (no full load).
 * Vendor-agnostic — just scans llm-ide's own plugin dir for folders with a
 * plugin.json, regardless of which vendor (or none) they came from.
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
      // A whole-tree vendor copy has no root plugin.json — its manifest
      // stays where the vendor put it.
      if (existsSync(join(dir, entry.name, 'plugin.json'))
        || findVendorManifestRel(join(dir, entry.name))) names.add(entry.name);
    }
  } catch { /* ignore */ }
  return names;
}

/**
 * Read the version from an llm-ide-imported plugin's manifest.
 * @returns {string|null}
 */
export function getImportedVersion(pluginName, mnDirOverride) {
  const dir = mnDirOverride || defaultPluginDir();
  const pluginDir = join(dir, pluginName);
  const vendorRel = existsSync(join(pluginDir, 'plugin.json')) ? null : findVendorManifestRel(pluginDir);
  const manifestPath = join(pluginDir, vendorRel || 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return manifest.version || null;
  } catch { return null; }
}
