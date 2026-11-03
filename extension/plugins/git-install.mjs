// Server-side "Install plugin from Git URL": clone a public repository shallowly, package it as the zip
// bytes the existing installer validates, and keep the clone's HEAD commit for the provenance record.
//
// This is deliberately server-side: the desktop webview never runs git and never supplies a filesystem path.
// The URL/ref rules are the same ones the source record enforces; the zip is capped by installFromZip.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

const SCP = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;
const REF = /^[A-Za-z0-9._/-]{1,128}$/;

/** Public HTTPS or scp-style git URL, no credentials/query/fragment and no local/private host. */
export function validGitPluginUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512 || /[\s\u0000-\u001f\u007f]/.test(raw)) return false;
  if (SCP.test(raw)) {
    const host = raw.slice(4, raw.indexOf(':'));
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host.endsWith('.local')) return false;
    return !raw.includes('..');
  }
  if (raw.includes('?') || raw.includes('#')) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return false;
    if (u.hostname === 'localhost' || u.hostname.endsWith('.local')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return false;
    return true;
  } catch { return false; }
}

export function validGitPluginRef(raw) {
  return raw == null || raw === '' || (typeof raw === 'string' && REF.test(raw) && !raw.startsWith('-') && !raw.includes('..'));
}

/** Clone and zip one plugin. Caller owns cleanup via `cleanup()`. */
export async function clonePluginZip({ url, ref, runCommand = run } = {}) {
  if (!validGitPluginUrl(url)) throw Object.assign(new Error('invalid git URL'), { code: 'INVALID_URL', status: 400 });
  if (!validGitPluginRef(ref)) throw Object.assign(new Error('invalid git ref'), { code: 'INVALID_REF', status: 400 });
  const root = await mkdtemp(join(tmpdir(), 'llmide-plugin-git-'));
  const repo = join(root, 'repo');
  const zipPath = join(root, 'plugin.zip');
  try {
    const args = ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, repo];
    await runCommand('git', args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repo, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const commit = String(head.stdout || '').trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw Object.assign(new Error('could not read the cloned commit'), { code: 'GIT_FAILED', status: 502 });
    await runCommand('zip', ['-r', '-q', zipPath, '.', '-x', '.git/*'], { cwd: repo, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const bytes = await readFile(zipPath);
    if (bytes.length === 0) throw Object.assign(new Error('the cloned plugin is empty'), { code: 'EMPTY', status: 400 });
    if (bytes.length > MAX_ZIP_BYTES) throw Object.assign(new Error(`the cloned plugin is larger than ${MAX_ZIP_BYTES} bytes`), { code: 'TOO_LARGE', status: 413 });
    return { bytes, commit, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (e) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
