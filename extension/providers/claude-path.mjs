// The single resolver for "where is the `claude` executable?".
//
// Part of the Claude linker (docs/explanation/claude-linker.md): the packaged
// desktop app does NOT bundle the Agent SDK's platform `claude` binary
// (desktop/PACKAGING.md), so the server must find the user's installed Claude
// Code and hand it to the SDK as `pathToClaudeCodeExecutable`. Both the SDK
// engine (llm_agent/sdk/engine.mjs) and the CLI-spawn provider path
// (providers.mjs, claude-plugin-cli.mjs) ask here — nothing else guesses.
//
// Order depends on the caller (`purpose`):
//   sdk : LLMIDE_CLAUDE_PATH -> SDK's bundled binary -> PATH + well-known dirs
//         (dev behaviour unchanged: the bundled binary wins when present)
//   cli : LLMIDE_CLAUDE_PATH -> PATH + well-known dirs -> bundled binary
//         (dev behaviour unchanged: the user's `claude` on PATH wins)
//
// Every candidate found by search (and the env override) is validated: a
// regular executable file, not inside a world-writable directory (a planted
// binary), and `--version` exits 0 — spawned with an args array, a minimal
// env and a short timeout, never through a shell. Results are memoised with a
// TTL (short for failures, so installing Claude Code is picked up without a
// restart) and `invalidateClaudePath()` forces a re-resolve after a failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { logger } from '../core/logger.mjs';

const log = logger.child({ component: 'claude-path' });

export const CLAUDE_NOT_FOUND = 'CLAUDE_NOT_FOUND';
export const CLAUDE_INSTALL_MESSAGE =
  'Claude Code was not found on this computer. Install Claude Code (https://claude.com/claude-code), '
  + 'run `claude login`, then try again — or set LLMIDE_CLAUDE_PATH to the claude executable.';

export class ClaudeNotFoundError extends Error {
  constructor(message = CLAUDE_INSTALL_MESSAGE, { tried = [] } = {}) {
    super(message);
    this.name = 'ClaudeNotFoundError';
    this.code = CLAUDE_NOT_FOUND;
    this.tried = tried; // for logs only; never put absolute paths in `message`
  }
}

const IS_WIN = process.platform === 'win32';
const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 15_000;
const VERSION_TIMEOUT_MS = 3_000;

const memo = new Map(); // key -> { at, result }

export function invalidateClaudePath() { memo.clear(); }

function exeNames() { return IS_WIN ? ['claude.exe'] : ['claude']; }

function versionEnv() {
  const env = {};
  for (const k of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'SystemRoot', 'LANG']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

function worldWritableDir(dir) {
  if (IS_WIN) return false;
  try { return (fs.statSync(dir).mode & 0o002) !== 0; } catch { return true; }
}

/** True when `file` is a regular executable that answers `--version`. */
export function validateClaudeExecutable(file) {
  try {
    if (!path.isAbsolute(file)) return false;
    const real = fs.realpathSync(file);
    const st = fs.statSync(real);
    if (!st.isFile()) return false;
    if (!IS_WIN) fs.accessSync(real, fs.constants.X_OK);
    // The directory the user's PATH entry lives in AND the one the real file
    // sits in must not be writable by everyone.
    if (worldWritableDir(path.dirname(file)) || worldWritableDir(path.dirname(real))) return false;
    const r = spawnSync(file, ['--version'], {
      env: versionEnv(), timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function platformPackages() {
  const arch = process.arch;
  if (process.platform === 'linux') return [`linux-${arch}`, `linux-${arch}-musl`];
  return [`${process.platform}-${arch}`];
}

/** The Agent SDK's bundled binary, when that package is installed. */
export function bundledClaudePath() {
  const require = createRequire(import.meta.url);
  for (const plat of platformPackages()) {
    try {
      const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${plat}/package.json`);
      for (const name of exeNames()) {
        const p = path.join(path.dirname(pkg), name);
        if (fs.existsSync(p)) return p;
      }
    } catch { /* not installed */ }
  }
  return null;
}

function nvmDirs(home) {
  const base = path.join(home, '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(base).sort().reverse().map((v) => path.join(base, v, 'bin'));
  } catch { return []; }
}

export function wellKnownDirs(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (IS_WIN) {
    return [
      env.APPDATA && path.join(env.APPDATA, 'npm'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'claude'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
      path.join(home, '.local', 'bin'),
    ].filter(Boolean);
  }
  const dirs = [path.join(home, '.claude', 'local'), path.join(home, '.local', 'bin')];
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin');
  dirs.push('/usr/local/bin', path.join(home, '.npm-global', 'bin'), ...nvmDirs(home));
  return dirs;
}

function searchDirs(env = process.env) {
  const pathDirs = String(env.PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  return [...new Set([...pathDirs, ...wellKnownDirs(env)])];
}

function findInstalled(tried) {
  for (const dir of searchDirs()) {
    for (const name of exeNames()) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      if (validateClaudeExecutable(file)) return file;
      tried.push(file);
    }
  }
  return null;
}

function compute(purpose) {
  const tried = [];
  if (process.env.LLMIDE_CLAUDE_BIN_DISABLED === '1') return { path: null, source: 'none', tried };

  const override = process.env.LLMIDE_CLAUDE_PATH;
  if (override) {
    if (validateClaudeExecutable(override)) return { path: override, source: 'env', tried };
    tried.push(override);
    return { path: null, source: 'none', tried }; // an explicit override that is broken must not silently fall through
  }
  const bundled = () => {
    const b = bundledClaudePath();
    return b ? { path: b, source: 'bundled', tried } : null;
  };
  const installed = () => {
    const f = findInstalled(tried);
    return f ? { path: f, source: 'installed', tried } : null;
  };
  const order = purpose === 'sdk' ? [bundled, installed] : [installed, bundled];
  for (const step of order) {
    const hit = step();
    if (hit) return hit;
  }
  return { path: null, source: 'none', tried };
}

/**
 * Resolve the `claude` executable. Returns `{ path, source, tried }` where
 * source is 'env' | 'bundled' | 'installed' | 'none' (path null). Never throws.
 */
export function resolveClaudeExecutable({ purpose = 'cli', now = Date.now() } = {}) {
  const key = [purpose, process.env.LLMIDE_CLAUDE_PATH || '', process.env.PATH || '', process.env.HOME || '',
    process.env.LLMIDE_CLAUDE_BIN_DISABLED || ''].join('\0');
  const hit = memo.get(key);
  if (hit && now - hit.at < (hit.result.path ? OK_TTL_MS : FAIL_TTL_MS)) return hit.result;
  const result = compute(purpose);
  memo.set(key, { at: now, result });
  if (result.path) log.info('claude_path_resolved', { purpose, source: result.source, path: result.path });
  else log.warn('claude_path_unresolved', { purpose, tried: result.tried.length });
  return result;
}

/** Like resolveClaudeExecutable but throws ClaudeNotFoundError when nothing usable exists. */
export function requireClaudeExecutable(opts) {
  const r = resolveClaudeExecutable(opts);
  if (!r.path) throw new ClaudeNotFoundError(undefined, { tried: r.tried });
  return r;
}
