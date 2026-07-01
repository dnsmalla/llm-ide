// Plugin installer — takes a zip-encoded plugin bundle, validates it,
// and atomically moves it into the per-user plugins directory.
//
// Pipeline (all best-effort, every error returns an envelope rather
// than throwing into the route handler):
//
//   1. Write the uploaded bytes to a fresh temp file.
//   2. Reject if file size > MAX_ZIP_BYTES.
//   3. Reject if the zip listing (via `unzip -l`) reveals path
//      traversal entries (../, absolute paths, symlinks).
//   4. Extract via `unzip -o -qq` into a temp staging directory.
//   5. Locate `plugin.json` — at root, or inside a single top-level
//      subdirectory (the common shape when users zip a folder).
//   6. Re-parse the manifest with the same validator the runtime
//      uses; refuse on any error.
//   7. Move the staged folder atomically into
//      `<pluginDir>/<manifest.name>/`. If a folder with that name
//      already exists, the caller controls overwrite via `replace`.
//   8. Returns the validated plugin metadata so the caller can
//      surface it in the response.
//
// Security:
//
//   - No URL fetching server-side — clients upload the bytes. This
//     was a deliberate decision to avoid SSRF surface.
//   - Path-traversal check happens on the unzip listing BEFORE
//     extraction. Symlinks in zips are rejected (-s would create
//     them; we list first so we never invoke -s implicitly).
//   - The temp dir lives under os.tmpdir() — outside the plugin
//     dir until validation passes — so even a half-extracted bad
//     archive can't be observed by the runtime.
//   - Plugin name is derived from the validated manifest, not the
//     zip filename, so an attacker can't pick the install path.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, rename, stat, lstat, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultPluginDir, loadPlugins } from './loader.mjs';

const MAX_ZIP_BYTES = 5 * 1024 * 1024; // 5 MB
const UNZIP_TIMEOUT_MS = 30_000;

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    const timer = setTimeout(() => {
      if (done) return;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, UNZIP_TIMEOUT_MS);
    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function isUnsafePath(entry) {
  // Reject path traversal, absolute paths, and any entry whose
  // canonical form would escape the staging directory.
  if (entry.startsWith('/')) return true;
  if (entry.startsWith('\\')) return true;
  if (entry.includes('..')) return true;
  // Windows drive letters
  if (/^[a-zA-Z]:[\\/]/.test(entry)) return true;
  return false;
}

async function listZipEntries(zipPath) {
  // `unzip -Z1` outputs one entry per line, no archive header. We use
  // that mode because the default `unzip -l` adds counts + headers
  // we'd have to skip.
  const r = await runCmd('unzip', ['-Z1', '--', zipPath]);
  if (r.code !== 0) {
    return { error: `Could not read zip (unzip exited ${r.code}): ${r.stderr.slice(0, 200)}` };
  }
  const entries = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return { entries };
}

async function findManifest(stagingDir) {
  // The zip might contain plugin.json at root, OR a single top-level
  // dir containing plugin.json (which is how `Compress with Finder`
  // and `zip -r foo.zip my-plugin/` both produce archives). Prefer
  // root; fall back to single subdir.
  if (existsSync(join(stagingDir, 'plugin.json'))) {
    return { manifestDir: stagingDir };
  }
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && existsSync(join(stagingDir, dirs[0].name, 'plugin.json'))) {
    return { manifestDir: join(stagingDir, dirs[0].name) };
  }
  return { error: 'plugin.json not found at zip root or in a single top-level directory' };
}

/**
 * Walk `dir` recursively and return true if any entry is a symbolic
 * link.  Used after extraction to catch zip-slip-via-symlink attacks
 * that bypass the name-level `isUnsafePath` check (because `unzip -Z1`
 * lists filenames only, not symlink targets).
 */
async function hasSymlinks(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory()) stack.push(join(cur, e.name));
    }
  }
  return false;
}

/**
 * Install a plugin from raw zip bytes.
 *
 * @param {Buffer} zipBytes — the uploaded archive
 * @param {object} opts
 * @param {boolean} [opts.replace] — overwrite an existing plugin with the same name
 * @param {string} [opts.pluginDir] — install root, defaults to platform standard
 * @returns {Promise<{ok: true, plugin: {...}} | {error: string, status?: number}>}
 */
export async function installFromZip(zipBytes, { replace = false, pluginDir = defaultPluginDir() } = {}) {
  if (!Buffer.isBuffer(zipBytes)) {
    return { error: 'expected Buffer bytes', status: 400 };
  }
  if (zipBytes.length === 0) {
    return { error: 'empty zip', status: 400 };
  }
  if (zipBytes.length > MAX_ZIP_BYTES) {
    return { error: `zip exceeds ${MAX_ZIP_BYTES} bytes`, status: 413 };
  }

  // Stage 1: write to temp file so unzip can read it. We DON'T pipe
  // into unzip's stdin because unzip needs to seek the archive.
  const stageRoot = await mkdtemp(join(tmpdir(), 'plugin-install-'));
  const zipPath = join(stageRoot, 'plugin.zip');
  const extractDir = join(stageRoot, 'extracted');
  await mkdir(extractDir, { recursive: true });
  await writeFile(zipPath, zipBytes);

  try {
    // Stage 2: list entries, reject any unsafe ones BEFORE extracting.
    const listing = await listZipEntries(zipPath);
    if (listing.error) return { error: listing.error, status: 400 };
    if (listing.entries.length === 0) return { error: 'zip is empty', status: 400 };
    for (const entry of listing.entries) {
      if (isUnsafePath(entry)) {
        return { error: `unsafe path in zip: ${entry}`, status: 400 };
      }
    }

    // Stage 3: extract. -o = overwrite within staging (safe — fresh
    // dir), -qq = quiet.
    const ex = await runCmd('unzip', ['-o', '-qq', '--', zipPath, '-d', extractDir]);
    if (ex.code !== 0) {
      return { error: `unzip failed (${ex.code}): ${ex.stderr.slice(0, 200)}`, status: 400 };
    }

    // Stage 3b: post-extraction symlink scan.
    // `unzip -Z1` reports entry NAMES only, not symlink targets, so
    // isUnsafePath() cannot catch a safe-named symlink whose target
    // escapes the staging dir (e.g. `foo.js -> ../../../../etc/shadow`).
    // We walk the extracted tree with lstat and reject outright if any
    // symlink is found — plugins have no legitimate reason to include
    // them, and allowing them creates a confused-deputy read path
    // through the manifest loader.
    if (await hasSymlinks(extractDir)) {
      return { error: 'zip contains symbolic links — not permitted in plugins', status: 400 };
    }

    // Stage 4: locate the manifest.
    const located = await findManifest(extractDir);
    if (located.error) return { error: located.error, status: 400 };

    // Stage 5: validate manifest by trying to load JUST this dir
    // through the same code path the runtime uses. We point the
    // loader at a single-plugin staging tree.
    const validationRoot = await mkdtemp(join(tmpdir(), 'plugin-validate-'));
    try {
      // Move (rename) staged manifest dir to a clean root for the
      // loader. Move rather than copy — atomic and faster.
      const intoValidate = join(validationRoot, 'candidate');
      await rename(located.manifestDir, intoValidate);
      const loaded = loadPlugins({ pluginDir: validationRoot });
      if (loaded.warnings.length > 0) {
        return {
          error: `validation failed: ${loaded.warnings.join('; ')}`,
          status: 400,
        };
      }
      if (loaded.plugins.size === 0) {
        return { error: 'manifest did not produce a valid plugin', status: 400 };
      }
      const [plugin] = loaded.plugins.values();

      // Stage 6: move into the real plugin dir. If a plugin with the
      // same name exists, refuse unless `replace`.
      await mkdir(pluginDir, { recursive: true });
      const finalDir = join(pluginDir, plugin.name);
      if (existsSync(finalDir)) {
        if (!replace) {
          return {
            error: `plugin '${plugin.name}' is already installed; set replace=true to overwrite`,
            status: 409,
          };
        }
        // Rename existing to a backup first so we can roll back on
        // the subsequent rename failure.
        const backup = `${finalDir}.bak-${Date.now()}`;
        await rename(finalDir, backup);
        try {
          await rename(intoValidate, finalDir);
        } catch (err) {
          // Restore the old version
          await rename(backup, finalDir).catch(() => {});
          return { error: `move failed: ${err.message}`, status: 500 };
        }
        await rm(backup, { recursive: true, force: true });
      } else {
        await rename(intoValidate, finalDir);
      }

      // Returns the validated subset the routes layer will surface.
      return {
        ok: true,
        plugin: {
          name: plugin.name,
          version: plugin.version,
          displayName: plugin.displayName,
          description: plugin.description,
          author: plugin.author,
          skillCount: plugin.skillFiles.length,
          commandCount: Object.keys(plugin.commands).length,
          subagentCount: Object.keys(plugin.subagents || {}).length,
          replaced: existsSync(finalDir) && replace,
        },
      };
    } finally {
      await rm(validationRoot, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Remove an installed plugin by name. Returns ok:true even when the
 * folder didn't exist (idempotent — uninstall-something-not-there is
 * a fine outcome).
 */
export async function uninstall(pluginName, { pluginDir = defaultPluginDir() } = {}) {
  // Same validation regex as the manifest loader — defense against a
  // route handler that forgets to validate. Names that don't match
  // can never have been installed, so the operation is a no-op.
  if (typeof pluginName !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(pluginName)) {
    return { error: 'invalid plugin name', status: 400 };
  }
  const dir = join(pluginDir, pluginName);
  if (!existsSync(dir)) {
    return { ok: true, removed: false };
  }
  // lstat (not stat) so a symlink-to-directory doesn't pass the
  // isDirectory check and get its target removed instead of the link.
  // rm() on a symlink removes only the symlink leaf, which is safe,
  // but we want to reject that case explicitly to avoid confusing
  // outcomes (the "plugin" would reappear after the link is deleted).
  const lst = await lstat(dir);
  if (!lst.isDirectory()) return { error: 'not a directory (symlink rejected)', status: 400 };
  await rm(dir, { recursive: true, force: true });
  return { ok: true, removed: true };
}
