// Claude linker: the ONLY place that knows `claude plugin …` argv and the
// shape of its --json output (docs/explanation/claude-linker.md). Callers get
// plain data; a CLI release that changes the format is fixed here alone.
import { execFile } from 'node:child_process';
import { minimalCliEnv } from './providers.mjs';

const TIMEOUT_MS = 120_000;

export const marketplaceUpdateArgs = (name) => ['plugin', 'marketplace', 'update', ...(name ? [name] : [])];
export const listArgs = () => ['plugin', 'list', '--available', '--json'];

// `-y` is deliberately absent: a marketplace-declared command must be shown to
// a person and accepted by its sha256 (--accept-command), never blanket-accepted.
export function updateArgs(pluginId, { scope, acceptCommand } = {}) {
  return ['plugin', 'update', pluginId, '--json',
    ...(scope ? ['--scope', scope] : []),
    ...(acceptCommand ? ['--accept-command', acceptCommand] : [])];
}

export function parseList(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { throw new Error('claude plugin list: unrecognised output'); }
  if (!j || !Array.isArray(j.installed) || !Array.isArray(j.available)) {
    throw new Error('claude plugin list: unrecognised output');
  }
  return {
    installed: j.installed.filter((e) => e && typeof e.id === 'string')
      .map(({ id, version, scope, installPath }) => ({ id, version, scope, installPath })),
    available: j.available.filter((e) => e && typeof e.pluginId === 'string')
      .map(({ pluginId, version, source }) => ({ pluginId, ...(version !== undefined ? { version } : {}), source })),
  };
}

// --json prints "one machine-readable result line" — the last JSON line on stdout.
function lastJsonLine(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean).reverse();
  for (const l of lines) {
    if (!l.startsWith('{')) continue;
    try { return JSON.parse(l); } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Classify `claude plugin update --json` output. A failure's `detail` is the
 * tail of stdout + stderr: the CLI writes its error text to stderr, so stdout
 * alone is often empty.
 */
export function parseUpdateResult(stdout, exitCode, stderr = '') {
  const r = lastJsonLine(stdout);
  const sha = r?.shownCommand?.sha256;
  if (typeof sha === 'string' && sha) {
    return { status: 'needs-confirmation', command: String(r.shownCommand.command ?? ''), sha256: sha };
  }
  if (exitCode === 0 && r && r.ok !== false) {
    return { status: r.from !== undefined && r.from === r.to ? 'already-latest' : 'updated' };
  }
  return { status: 'failed', detail: [String(stdout ?? ''), String(stderr ?? '')].filter(Boolean).join('\n').slice(-2000) };
}

export const defaultExec = (bin, args, opts) => new Promise((resolve, reject) => {
  // Test-only switch: when LLMIDE_CLAUDE_BIN_DISABLED is set, reject with ENOENT
  // without spawning. This routes tests away from the real claude CLI, which would
  // change ~/.claude. Route tests must use injected fakes.
  if (process.env.LLMIDE_CLAUDE_BIN_DISABLED === '1') {
    const err = new Error('ENOENT: no such file or directory, spawn claude');
    err.code = 'ENOENT';
    reject(err);
    return;
  }
  const child = execFile(bin, args, opts, (err, stdout, stderr) => {
    if (err && err.code === 'ENOENT') { reject(err); return; }
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
  });
  // Everything goes via argv. An open stdin pipe lets a CLI that waits for
  // input hang until the timeout (same as runClaude in providers.mjs).
  child.stdin?.end();
});

export function runClaudePluginCli(args, { exec = defaultExec, timeoutMs = TIMEOUT_MS } = {}) {
  return exec('claude', args, { env: minimalCliEnv(), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}
