// Build the Linux x64 hub bundle from the desktop's already-staged core.
//
// The bundle is the same pinned Node 22 + production deps the desktop ships, so the hub needs no
// Node, npm or compiler. Usage:
//   node desktop/scripts/stage-hub-core.mjs [--out <absolute dir>] [--version <x.y.z>]
//     [--workspace-helper <absolute file>] [--compat-sqlite <absolute file>]
// Output: <out>/llmide-core-<version>-linux-x64.tar.gz + .sha256 + VERSION + SHA256SUMS
// The default <out> is desktop/hub-dist (not desktop/dist, which every web build empties).
// With --compat-sqlite <absolute file>: the same bundle with the glibc 2.28 better-sqlite3 module in place
// of the prebuild, named llmide-core-<version>-linux-x64-compat.tar.gz (+ .sha256 only; see sqlite-compat.mjs).
// Both bundles carry core/bin/llmide-workspace, the static Linux helper the Explorer runs over SSH. Without
// --workspace-helper it is built with cargo for x86_64-unknown-linux-musl (needs that rustup target).
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, devNull } from 'node:os';
import { compatBundleName, readCompatModule } from './sqlite-compat.mjs';
import { resolveHubOut } from './hub-out.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, '..');
const REPO = resolve(DESKTOP, '..');
export const HELPER_TARGET = 'x86_64-unknown-linux-musl';
export const HELPER_BINARY = 'llmide-workspace';
const HELPER_CRATE = join(DESKTOP, 'workspace-helper');
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

// Probes with an empty archive so the answer is about this tar binary, not about the host OS.
function tarAcceptsNoXattrs() {
  try {
    execFileSync('tar', ['--no-xattrs', '-cf', devNull, '--files-from', devNull], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the value of `--workspace-helper`, or null when the flag is absent.
 *
 * @param {string[]} args Command-line arguments after the script path.
 * @returns {string | null} The absolute helper path, or null when the option is not given.
 */
export function workspaceHelperOption(args) {
  const index = args.indexOf('--workspace-helper');
  if (index < 0) return null;
  const value = args[index + 1];
  // NOTE: Relative paths are refused because the staging run changes directory, so a relative path
  // would name a different file than the one the user typed.
  if (!value || value.startsWith('-') || !isAbsolute(value)) {
    throw new Error('--workspace-helper needs an absolute file path');
  }
  return value;
}

/**
 * Checks that a helper file exists and is a Linux (ELF) program, and returns its path.
 *
 * @param {string} file Absolute path of the helper binary.
 * @returns {string} The same path, once it passed the checks.
 * @throws {Error} When the file is missing, not a regular file, or not an ELF program.
 */
export function readWorkspaceHelper(file) {
  // NOTE: A Mac Mach-O helper would be copied into the bundle and only fail on the server, so the magic
  // bytes are checked here, before any staging work.
  const isRegularFile = existsSync(file) && statSync(file).isFile();
  if (!isRegularFile || !readFileSync(file).subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC)) {
    throw new Error(`--workspace-helper is not a Linux program: ${file}`);
  }
  return file;
}

/**
 * Tells whether `rustup target list --installed` output names the given target.
 *
 * @param {string} rustupOutput Raw stdout of `rustup target list --installed`.
 * @param {string} [target] Target triple to look for.
 * @returns {boolean} True when one whole line equals the target.
 */
export function hasInstalledTarget(rustupOutput, target = HELPER_TARGET) {
  return rustupOutput.split('\n').some((line) => line.trim() === target);
}

// The real tools; tests pass a fake probe instead of running cargo or rustup.
const defaultToolchainProbe = {
  hasCargo() {
    try {
      execFileSync('cargo', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  installedTargets() {
    return execFileSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
  },
};

/**
 * Fails before any staging when the default helper build cannot run.
 *
 * @param {{ hasCargo: () => boolean, installedTargets: () => string }} [probe] Tool checks; defaults to cargo and rustup.
 * @throws {Error} With the message the user needs to fix the toolchain or pass a prebuilt helper.
 */
export function ensureHelperToolchain(probe = defaultToolchainProbe) {
  if (!probe.hasCargo()) {
    throw new Error('cargo is not installed; pass --workspace-helper <file> with a prebuilt helper.');
  }
  let targets;
  try {
    targets = probe.installedTargets();
  } catch {
    throw new Error('rustup is not installed; pass --workspace-helper <file> with a prebuilt helper.');
  }
  if (!hasInstalledTarget(targets)) {
    throw new Error(`install the target: rustup target add ${HELPER_TARGET}`);
  }
}

/**
 * Builds the release helper for the Linux musl target and returns the binary's path.
 *
 * @param {Function} [run] Runs a command like execFileSync; a seam for tests.
 * @returns {string} Absolute path of the built binary.
 */
export function buildWorkspaceHelper(run = execFileSync) {
  // NOTE: cargo reads .cargo/config.toml from the working directory upwards, not from --manifest-path, so the
  // crate's own config (rust-lld, static CRT) only applies when the build runs inside the crate folder.
  // NOTE: desktop/.cargo/config.toml shares one target dir across the desktop crates; pin it here so the
  // output path below cannot drift from where cargo writes.
  const targetDir = process.env.CARGO_TARGET_DIR || join(DESKTOP, 'src-tauri', 'target');
  run('cargo', ['build', '--release', '--target', HELPER_TARGET, '--manifest-path', join(HELPER_CRATE, 'Cargo.toml')], {
    cwd: HELPER_CRATE,
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  const built = join(targetDir, HELPER_TARGET, 'release', HELPER_BINARY);
  if (!existsSync(built)) throw new Error(`cargo did not produce ${built}`);
  return built;
}

/**
 * Resolves the helper binary to ship: the given file, or a fresh build after the toolchain check.
 *
 * @param {string[]} args Command-line arguments after the script path.
 * @param {{ hasCargo: () => boolean, installedTargets: () => string }} [probe] Toolchain probe seam.
 * @param {() => string} [build] Build seam; returns the built path.
 * @returns {string} Absolute path of a checked Linux helper.
 */
export function resolveHelperFile(args, probe = defaultToolchainProbe, build = buildWorkspaceHelper) {
  const given = workspaceHelperOption(args);
  if (given) return readWorkspaceHelper(given);
  ensureHelperToolchain(probe);
  return readWorkspaceHelper(build());
}

/**
 * Copies the helper into the staged core as core/bin/llmide-workspace with mode 0755.
 *
 * @param {string} core Staged core folder (the one that becomes `core/` in the tarball).
 * @param {string} helperFile Checked Linux helper binary.
 * @returns {string} Path of the staged helper.
 */
export function stageWorkspaceHelper(core, helperFile) {
  const binDir = join(core, 'bin');
  mkdirSync(binDir, { recursive: true });
  const staged = join(binDir, HELPER_BINARY);
  copyFileSync(helperFile, staged);
  // NOTE: chmod is explicit because copyFileSync keeps the source mode, which a 0644 download or a umask would break.
  chmodSync(staged, 0o755);
  return staged;
}

function runStaging(args) {
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : fallback;
  };
  // Default output is outside Vite's dist folder (see hub-out.mjs).
  const out = resolve(resolveHubOut(args, DESKTOP));
  if (!out.startsWith('/')) { console.error('--out must be absolute'); process.exit(2); }
  const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
  const version = arg('--version', pkg.version || '0.0.0');

  // The module is checked against its sibling .sha256 before any staging work, so a bad file fails in seconds.
  const compatIndex = args.indexOf('--compat-sqlite');
  const compatFile = compatIndex >= 0 ? args[compatIndex + 1] : null;
  if (compatIndex >= 0 && (!compatFile || !isAbsolute(compatFile))) {
    console.error('--compat-sqlite needs an absolute file path');
    process.exit(2);
  }
  let compatBytes = null;
  if (compatFile) {
    try {
      compatBytes = readCompatModule(compatFile);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // The helper is found or built before the stage folder exists, so a missing target fails with nothing staged.
  let helperFile;
  try {
    helperFile = resolveHelperFile(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const stage = join(tmpdir(), `llmide-hub-stage-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    const core = join(stage, 'core');
    mkdirSync(core, { recursive: true });
    execFileSync(process.execPath, [join(HERE, 'stage-core.mjs'), '--target', 'linux-x64', '--out', core], { cwd: REPO, stdio: 'inherit' });
    if (compatBytes) {
      // Replaces the linux-x64 prebuild that stage-core keeps; the path is the one stage-core writes and checks.
      const prebuild = join(core, 'root', 'extension', 'node_modules', 'better-sqlite3', 'prebuilds', 'linux-x64.node');
      if (!existsSync(prebuild)) throw new Error(`staging failed: no better-sqlite3 prebuild to replace at ${prebuild}`);
      writeFileSync(prebuild, compatBytes);
    }
    // The hub's on-demand backup service runs this script from the staged extension.
    for (const f of ['backup.mjs', 'restore-backup.mjs']) {
      const src = join(REPO, 'extension', 'scripts', f);
      if (existsSync(src)) {
        const dst = join(stage, 'core', 'root', 'extension', 'scripts');
        mkdirSync(dst, { recursive: true });
        cpSync(src, join(dst, f));
      }
    }
    // The server runs the helper as $HOME/.llmide-server/current/core/bin/llmide-workspace.
    stageWorkspaceHelper(core, helperFile);
    // Optional PWA served at /app/ by the hub's nginx.
    if (existsSync(join(REPO, 'web', 'dist'))) cpSync(join(REPO, 'web', 'dist'), join(stage, 'core', 'root', 'web'), { recursive: true });
    writeFileSync(join(stage, 'VERSION'), `${version}\n`);
    const tar = join(out, compatBytes ? compatBundleName(version) : `llmide-core-${version}-linux-x64.tar.gz`);
    mkdirSync(out, { recursive: true });
    // macOS tar writes ._* AppleDouble files and xattr headers unless told not to; GNU tar on the server
    // then warns and the core finds the junk files. --no-xattrs is probed, not assumed: GNU tar builds may lack it.
    const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
    const xattrFlags = tarAcceptsNoXattrs() ? ['--no-xattrs'] : [];
    // The tarball and its checksum are built under temporary names and renamed into place only when both
    // exist: an interrupted run must not leave a bundle under the name the app prefers (the -compat one).
    const partial = join(out, `.${basename(tar)}.partial-${process.pid}`);
    const partialSha = `${partial}.sha256`;
    try {
      execFileSync('tar', [...xattrFlags, '-czf', partial, '-C', stage, '.'], { stdio: 'inherit', env: tarEnv });
      const sha = createHash('sha256').update(readFileSync(partial)).digest('hex');
      writeFileSync(partialSha, `${sha}  ${basename(tar)}\n`);
      renameSync(partialSha, `${tar}.sha256`);
      renameSync(partial, tar);
      // The compat run writes only its own checksum: SHA256SUMS and VERSION here would describe the hub bundle
      // and overwrite it when both are staged into the same --out directory.
      if (!compatBytes) {
        writeFileSync(join(out, 'SHA256SUMS'), `${sha}  ${basename(tar)}\n`);
        writeFileSync(join(out, 'VERSION'), `${version}\n`);
      }
    } catch (err) {
      rmSync(partial, { force: true });
      rmSync(partialSha, { force: true });
      throw err;
    }
    console.log(tar);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// NOTE: Runs only when this file is the entry point, so the tests can import the helpers without a staging run.
const IS_ENTRY = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_ENTRY) runStaging(process.argv.slice(2));
