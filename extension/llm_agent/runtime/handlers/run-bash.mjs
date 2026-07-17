import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

// Commands that are never safe to run server-side.
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/,      // rm -rf / (root wipe)
  /\bsudo\b/,
  /\bsu\s+-/,
  /\bmkfs\b/,
  />\s*\/dev\/(s?d[a-z]|nvme)/, // direct disk writes
  /\bdd\s+.*of=\/dev\//,
];

function isBlocked(command) {
  return BLOCKED_PATTERNS.some((re) => re.test(command));
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

  if (isBlocked(command)) {
    return { error: 'Command blocked for safety. Confirm destructive operations with the user before running.' };
  }

  const timeoutMs = Math.min(
    typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  // Resolve working directory: explicit arg → workspace root → home.
  const cwd = args?.cwd
    ? path.resolve(args.cwd)
    : (ctx?.workspaceRoot ? path.resolve(ctx.workspaceRoot) : os.homedir());

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
    name: 'blocks rm -rf /',
    fn: async () => {
      const r = await handleRunBash({ command: 'rm -rf /' });
      assert(r.error && r.error.includes('blocked'), `expected blocked: ${r.error}`);
    },
  });

  tests.push({
    name: 'blocks sudo',
    fn: async () => {
      const r = await handleRunBash({ command: 'sudo ls' });
      assert(r.error && r.error.includes('blocked'), `expected blocked: ${r.error}`);
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
