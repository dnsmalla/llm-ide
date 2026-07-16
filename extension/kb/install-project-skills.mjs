// Install the central skills kit into a LLM IDE project folder.
//
// Called from POST /kb/project/install-skills when the Mac app creates a
// project or rebuilds its folders. Runs the kit's manifest-driven
// `scripts/install.sh` so Claude / Cursor / Codex / .agents / Gemini all
// get the same SKILL.md catalogue as relative symlinks (one physical copy:
// the pinned `.skills` submodule or resolved central clone).
//
// Security: only installs into directories that already carry the LLM IDE
// project marker (`system/project.json`). Never creates that marker and
// never writes outside the resolved realpath of the given folder.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCentralSkillsRepo } from '../llm_agent/skills/skill-library.mjs';

const TOOLS = ['claude', 'cursor', 'codex', 'agents', 'gemini'];
const DEFAULT_STACKS = 'typescript,swift';
const INSTALL_TIMEOUT_MS = 60_000;

/**
 * Map a project language code to install.sh --stacks.
 * Unknown / empty → stack-agnostic defaults used by llm-ide itself.
 */
export function stacksForLanguage(language) {
  const lang = String(language || '').trim().toLowerCase();
  if (!lang || lang === 'en' || lang === 'ja' || lang === 'auto') {
    return DEFAULT_STACKS;
  }
  // Project settings.language is UI locale today; if a real stack id is
  // ever stored (python, typescript, …), pass it through.
  const known = new Set([
    'typescript', 'javascript', 'python', 'swift', 'kotlin', 'java', 'go', 'rust',
  ]);
  if (known.has(lang)) {
    // Always include typescript+swift so the llm-ide agent kit stays available
    // alongside the project's primary stack.
    const set = new Set([lang, 'typescript', 'swift']);
    return [...set].join(',');
  }
  return DEFAULT_STACKS;
}

/**
 * Validate that `projectPath` is an absolute existing directory containing
 * `system/project.json`. Returns the resolved realpath, or throws Error
 * with a `.code` property the router maps to HTTP status.
 */
export function assertInstallableProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    const err = new Error('path is required');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const raw = projectPath.trim();
  if (!isAbsolute(raw)) {
    const err = new Error('path must be an absolute directory');
    err.code = 'INVALID_PATH';
    throw err;
  }
  // Reject NUL and control chars early.
  if (/[\0-\x1f]/.test(raw)) {
    const err = new Error('path contains invalid characters');
    err.code = 'INVALID_PATH';
    throw err;
  }
  let resolved;
  try {
    resolved = realpathSync(resolve(raw));
  } catch {
    const err = new Error('path does not exist');
    err.code = 'PATH_NOT_FOUND';
    throw err;
  }
  let st;
  try {
    st = statSync(resolved);
  } catch {
    const err = new Error('path is not accessible');
    err.code = 'PATH_NOT_FOUND';
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error('path must be a directory');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const marker = join(resolved, 'system', 'project.json');
  if (!existsSync(marker)) {
    const err = new Error(
      'path is not a LLM IDE project (missing system/project.json)');
    err.code = 'NOT_A_PROJECT';
    throw err;
  }
  return resolved;
}

/**
 * Run the central kit installer into `projectPath`.
 *
 * @param {{ path: string, stacks?: string, language?: string }} opts
 * @returns {{ ok: true, path: string, kit: string, stacks: string, tools: string[], stdout: string }}
 */
export function installProjectSkills(opts = {}) {
  const projectPath = assertInstallableProjectPath(opts.path);
  const kit = resolveCentralSkillsRepo();
  if (!kit) {
    const err = new Error(
      'central skills kit not found (.skills submodule, ~/skills, or cache)');
    err.code = 'KIT_MISSING';
    throw err;
  }
  const installSh = join(kit, 'scripts', 'install.sh');
  if (!existsSync(installSh)) {
    const err = new Error(`install.sh missing in kit at ${kit}`);
    err.code = 'KIT_MISSING';
    throw err;
  }

  const stacks = (typeof opts.stacks === 'string' && opts.stacks.trim())
    ? opts.stacks.trim()
    : stacksForLanguage(opts.language);

  // No --force: preserve real files the scaffolder already wrote
  // (.claude/settings.json, project.md). Skills/rules dirs get fresh links.
  const args = [installSh, projectPath, '--stacks', stacks, '--prune'];
  for (const t of TOOLS) {
    args.push('--tool', t);
  }

  const result = spawnSync('bash', args, {
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
    env: { ...process.env, PATH: process.env.PATH },
  });

  if (result.error) {
    const err = new Error(`skills install failed to start: ${result.error.message}`);
    err.code = 'INSTALL_FAILED';
    throw err;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 800);
    const err = new Error(
      `skills install exited ${result.status}${detail ? `: ${detail}` : ''}`);
    err.code = 'INSTALL_FAILED';
    throw err;
  }

  return {
    ok: true,
    path: projectPath,
    kit,
    stacks,
    tools: TOOLS,
    stdout: (result.stdout || '').trim().slice(0, 2000),
  };
}
