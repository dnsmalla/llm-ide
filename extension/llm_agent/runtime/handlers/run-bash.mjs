import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

// True when `target` is an existing directory at or below `root`, after
// resolving symlinks on both sides.
function isDirectoryWithinRoot(target, root) {
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(target);
    realRoot = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) return false;
  } catch {
    return false;
  }
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/**
 * Resolve the directory a run-bash call will execute in: explicit arg →
 * workspace root → home.
 *
 * A model-supplied `cwd` is resolved against the workspace and must be an
 * existing directory inside it (realpath containment, like writePathGate).
 * Without that, `{ cwd: "/Users/me/.aws", command: "cat credentials" }`
 * relocates a gate-approved command onto a file the gate never saw — so with
 * no workspace open there is nothing to contain it in, and it is refused
 * rather than resolved against $HOME. Exported so the gate judges the SAME
 * directory the command will actually run in.
 *
 * @returns {{ cwd: string } | { error: string }}
 */
export function resolveBashCwd(args, ctx = {}) {
  const workspaceRoot = ctx?.workspaceRoot ? path.resolve(ctx.workspaceRoot) : null;
  if (typeof args?.cwd !== 'string' || !args.cwd) {
    return { cwd: workspaceRoot ?? os.homedir() };
  }
  if (!workspaceRoot) {
    return { error: 'cwd requires an open project workspace; omit cwd or open a project folder first.' };
  }
  const cwd = path.resolve(workspaceRoot, args.cwd);
  if (!isDirectoryWithinRoot(cwd, workspaceRoot)) {
    return { error: `cwd must be an existing directory inside the project workspace (${workspaceRoot}).` };
  }
  return { cwd };
}

/**
 * Execute a shell command and return stdout + stderr.
 * @param {object} args
 * @param {string} args.command
 * @param {string} [args.cwd]
 * @param {number} [args.timeout]
 * @param {object} ctx
 * @param {string} [ctx.workspaceRoot]  — from agentContext, the active project root
 */
export async function handleRunBash(args, ctx = {}) {
  const command = (args?.command || '').trim();
  if (!command) return { error: 'Missing command argument.' };

  const timeoutMs = Math.min(
    typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  const resolved = resolveBashCwd(args, ctx);
  if (resolved.error) return { error: resolved.error };
  const { cwd } = resolved;

  try {
    const { stdout, stderr } = await execFileAsync(
      '/bin/sh', ['-c', command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env },
      },
    );

    const out = [stdout, stderr].filter(Boolean).join('\n').trimEnd();
    return {
      stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
      output: out.slice(0, MAX_OUTPUT_CHARS) || '(no output)',
      exitCode: 0,
    };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { error: `Command timed out after ${timeoutMs / 1000}s.`, exitCode: null };
    }
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trimEnd();
    return {
      error: `Command failed (exit ${err.code ?? '?'}): ${out.slice(0, 1000) || err.message}`,
      stdout: (err.stdout || '').slice(0, MAX_OUTPUT_CHARS),
      stderr: (err.stderr || '').slice(0, MAX_OUTPUT_CHARS),
      exitCode: err.code ?? 1,
    };
  }
}

// ──── Tests (run via: node llm_agent/runtime/handlers/run-bash.mjs)

export async function runTests() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const tests = [];

  tests.push({
    name: 'returns output for a simple command',
    fn: async () => {
      const r = await handleRunBash({ command: 'echo hello' });
      assert(!r.error, `unexpected error: ${r.error}`);
      assert(r.stdout.trim() === 'hello', `unexpected stdout: ${r.stdout}`);
    },
  });

  tests.push({
    name: 'returns error on missing command',
    fn: async () => {
      const r = await handleRunBash({});
      assert(r.error && r.error.includes('Missing'), 'expected missing error');
    },
  });

  tests.push({
    name: 'returns exitCode on failure',
    fn: async () => {
      const r = await handleRunBash({ command: 'exit 42' });
      assert(r.exitCode === 42 || r.error, 'expected failure');
    },
  });

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
    } catch (e) {
      console.log(`✗ ${t.name}: ${e.message}`);
      throw e;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runTests();
}
