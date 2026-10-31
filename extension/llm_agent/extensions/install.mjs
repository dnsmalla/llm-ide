// Install an item from GitHub into the user's catalog store (plan section 5.3).
//
// A user's click is the only caller. The sequence, none of which executes
// anything from the fetched tree:
//
//   1. validate the URL (github.com/<owner>/<repo> only) and the operator allowlist
//   2. resolve the choice to a 40-hex commit (a supplied commit is the pin)
//   3. download the archive AT that commit (pinned fetch, size caps, no redirects)
//   4. read it in memory (tar.mjs: traversal, links, size and count refused)
//   5. inspect it (kind, members, what it declares) and scan it (warn-only)
//   6. write it to <store>/<user>/<item>/<commit>/ via a staging dir and a rename
//   7. record it, switched OFF: enabling is a separate, per-user step, and an
//      item that declares anything executable needs consent first
//
// Nothing here loads the item into a turn; that is the active set's job.

import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep, relative } from 'node:path';
import { makePinnedFetch } from '../../server/pinned-fetch.mjs';
import { sourceAllowedFor } from './allowlist.mjs';
import { parseRepoUrl, resolveCommit, downloadArchive, SourceError, validRef, isCommitSha } from './sources/github.mjs';
import { extractTarGz, ArchiveError } from './sources/tar.mjs';
import { inspectTree } from './inspect.mjs';
import { scanTree, summarizeFindings } from './scan.mjs';
import { validateSource } from '../../plugins/source-store.mjs';
import { publisherFromSource, parseItemId, parseMemberId } from './model.mjs';
import { catalogEnabled, scanEnabled } from './flags.mjs';
import { removeViewsFor, removeAllViewsFor } from './view.mjs';
import { readOverlay, setItemEnabled, setMembersEnabled, clearItem, forgetUser } from './store.mjs';
import { treeHash } from './integrity.mjs';
import { readInstalled, putInstalled, removeInstalled, forgetInstalledUser, itemStoreDir, userStoreDir, baseDir } from './installed.mjs';

export class InstallError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'InstallError'; this.code = code; this.extra = extra; }
}

export const MAX_FINDINGS_KEPT = 50;
export const busy = new Set();

export function validSubpath(p) {
  if (p === undefined || p === null || p === '') return '';
  if (typeof p !== 'string' || p.length > 200 || /[\u0000-\u001f\u007f\\]/.test(p) || p.startsWith('/')) throw new InstallError('invalid_path', 'invalid path');
  const segs = p.replace(/\/+$/, '').split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new InstallError('invalid_path', 'invalid path');
  return segs.join('/');
}

export function writeTree(files, dest) {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const root = resolve(dest);
  for (const [rel, buf] of files) {
    const target = resolve(root, rel);
    if (!target.startsWith(root + sep)) throw new InstallError('unsafe_path', 'refusing to write outside the store');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // 'wx': never overwrite, never follow a link that is already there. Not executable: nothing runs from here at install.
    writeFileSync(target, buf, { flag: 'wx', mode: 0o644 });
  }
}

export const mapFetchError = (err) => {
  if (err instanceof InstallError) return err;
  if (err instanceof SourceError || err instanceof ArchiveError) return new InstallError(err.code, err.message);
  if (err?.code === 'SSRF_BLOCKED') return new InstallError('blocked', 'that address is not allowed');
  if (err?.name === 'AbortError') return new InstallError('aborted', 'cancelled');
  return new InstallError('upstream', 'could not reach GitHub');
};

/**
 * @param {{ userId: string, url: string, ref?: string, commit?: string, path?: string }} req
 * @param {{ fetch?: typeof fetch, signal?: AbortSignal }} [deps]
 */
export async function installFromGithub({ userId, url, ref, commit, path: subpathIn }, { fetch: fetchImpl, signal } = {}) {
  if (!catalogEnabled()) throw new InstallError('catalog_disabled', 'the extensions catalog is switched off');
  if (typeof userId !== 'string' || !userId) throw new InstallError('invalid_user', 'no user');
  const repo = parseRepoUrl(url);
  if (!repo) throw new InstallError('invalid_url', 'use a https://github.com/<owner>/<repo> address');
  if (!sourceAllowedFor(userId, repo.owner, repo.repo)) throw new InstallError('source_not_allowed', 'this source is not on the allowed list');
  if (ref !== undefined && ref !== null && ref !== '' && !validRef(ref)) throw new InstallError('invalid_ref', 'invalid ref');
  if (commit !== undefined && commit !== null && commit !== '' && !isCommitSha(commit)) throw new InstallError('invalid_commit', 'commit must be 40 hex characters');
  const subpath = validSubpath(subpathIn);
  if (readInstalled(userId).corrupt) throw new InstallError('state_unreadable', 'the installed-extensions record cannot be read');

  const f = fetchImpl ?? makePinnedFetch({ allowPrivate: false });
  let sha; let archive; let tree;
  try {
    sha = await resolveCommit({ owner: repo.owner, repo: repo.repo, ref, commit }, { fetch: f, signal });
    archive = await downloadArchive({ owner: repo.owner, repo: repo.repo, commit: sha }, { fetch: f, signal });
    tree = extractTarGz(archive);
  } catch (err) { throw mapFetchError(err); }

  let files = tree.files;
  if (subpath) {
    files = new Map();
    for (const [p, b] of tree.files) if (p.startsWith(`${subpath}/`)) files.set(p.slice(subpath.length + 1), b);
    if (!files.size) throw new InstallError('not_found', 'that path is not in the repository');
  }
  const source = validateSource({ kind: 'git', url: repo.url, commit: sha, ...(ref ? { ref } : {}) });
  if (!source.ok) throw new InstallError('invalid_url', `source: ${source.error}`);
  const trust = publisherFromSource(source.source);
  const fallbackName = (subpath ? subpath.split('/').pop() : repo.repo).toLowerCase();
  const info = inspectTree(files, { publisher: repo.owner.toLowerCase(), fallbackName });
  if (!info.ok) {
    throw info.code === 'marketplace'
      ? new InstallError('marketplace', 'this repository is a marketplace; install one of its plugins by path', { entries: info.entries })
      : new InstallError('nothing_installable', 'no skill, plugin or MCP server found here');
  }
  const findings = scanEnabled() ? scanTree(files, { skipped: tree.skipped }) : [];

  const prior = readInstalled(userId).items.get(info.id);
  if (prior) {
    if (prior.pinnedCommit === sha) return { ok: true, alreadyInstalled: true, item: view(userId, info.id) };
    throw new InstallError('already_installed', 'this item is installed at another commit; use update', { id: info.id, installed: prior.pinnedCommit, requested: sha, use: '/auth/me/extensions/update' });
  }

  const lock = `${userId}\u0000${info.id}`;
  if (busy.has(lock)) throw new InstallError('busy', 'this item is being installed');
  busy.add(lock);
  const itemDir = itemStoreDir(userId, info.id);
  const finalDir = join(itemDir, sha);
  const staging = join(itemDir, `.staging-${randomBytes(6).toString('hex')}`);
  try {
    mkdirSync(itemDir, { recursive: true, mode: 0o700 });
    writeTree(files, staging);
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);
    const record = {
      id: info.id, kind: info.kind, name: info.name, description: info.description, version: info.version,
      publisher: { id: parseItemId(info.id).publisher, trust: trust.trust },
      source: source.source, ...(subpath ? { subpath } : {}),
      pinnedCommit: sha, installedAt: new Date().toISOString(),
      members: info.members, declared: { executableKinds: info.executableKinds }, permissions: info.permissions,
      scan: { ...summarizeFindings(findings), findings: findings.slice(0, MAX_FINDINGS_KEPT) },
      consents: {},
      integrity: treeHash(files),
      storeDir: relative(baseDir(), finalDir),
    };
    if (!putInstalled(userId, info.id, record) || !setItemEnabled(userId, info.id, false)) {
      rmSync(itemDir, { recursive: true, force: true });
      removeInstalled(userId, info.id);
      throw new InstallError('state_unreadable', 'the extensions state file cannot be written');
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err instanceof InstallError ? err : new InstallError('write_failed', 'could not store the item');
  } finally { busy.delete(lock); }
  return { ok: true, item: view(userId, info.id) };
}

/** A record merged with this user's switches. `enabled` is true only after an explicit enable. */
export function view(userId, id, installed = readInstalled(userId), overlay = readOverlay(userId)) {
  const full = installed.items.get(id);
  if (!full) return null;
  // The previous version's snapshot stays server side; the client sees what it needs to offer a rollback.
  const { previous, ...rec } = full;
  const o = overlay.items.get(id);
  return { ...rec,
    ...(previous && typeof previous === 'object' ? { previous: { pinnedCommit: previous.pinnedCommit, version: previous.version ?? null, installedAt: previous.installedAt ?? null } } : {}), state: { enabled: !overlay.corrupt && o?.enabled === true, disabledMembers: [...(o?.disabledMembers ?? [])].sort() } };
}

export function listInstalled(userId) {
  const installed = readInstalled(userId);
  const overlay = readOverlay(userId);
  return { corrupt: installed.corrupt || overlay.corrupt, items: [...installed.items.keys()].sort().map((id) => view(userId, id, installed, overlay)) };
}

/**
 * Switch an installed item on or off for this user. Turning on an item that
 * declares executable parts (hooks, MCP servers, bin, LSP) needs the user's
 * consent for each kind it declares, named in `consents`.
 */
export function setInstalledEnabled(userId, id, enabled, { consents = [] } = {}) {
  const installed = readInstalled(userId);
  const rec = installed.items.get(id);
  if (!rec) throw new InstallError('not_found', 'not installed');
  if (installed.corrupt || readOverlay(userId).corrupt) throw new InstallError('state_unreadable', 'extensions state cannot be read');
  if (enabled === true) {
    const need = Array.isArray(rec.declared?.executableKinds) ? rec.declared.executableKinds : [];
    const given = new Set((Array.isArray(consents) ? consents : []).filter((c) => typeof c === 'string'));
    const missing = need.filter((k) => !given.has(k));
    if (missing.length) throw new InstallError('consent_required', 'this item can run code; consent to each kind first', { kinds: missing });
    if (need.length) {
      const next = { ...rec, consents: { ...rec.consents, ...Object.fromEntries(need.map((k) => [k, { grantedAt: new Date().toISOString(), commit: rec.pinnedCommit }])) } };
      if (!putInstalled(userId, id, next)) throw new InstallError('state_unreadable', 'extensions state cannot be written');
    }
  }
  if (!setItemEnabled(userId, id, enabled === true)) throw new InstallError('state_unreadable', 'extensions state cannot be written');
  return view(userId, id);
}

/** Check or uncheck members of an installed item (the unchecked-set rule). */
export function setInstalledMembers(userId, id, memberIds, enabled) {
  const rec = readInstalled(userId).items.get(id);
  if (!rec) throw new InstallError('not_found', 'not installed');
  const known = new Set((rec.members ?? []).map((m) => m.memberId));
  const ids = (Array.isArray(memberIds) ? memberIds : []).filter((m) => typeof m === 'string' && parseMemberId(m) && known.has(m));
  if (!ids.length) throw new InstallError('invalid_member', 'no such member');
  if (!setMembersEnabled(userId, id, ids, enabled === true)) throw new InstallError('state_unreadable', 'extensions state cannot be written');
  return view(userId, id);
}

export function removeStore(dir, userId) {
  // Defence in depth: only ever delete inside this user's own store directory.
  const root = resolve(userStoreDir(userId));
  const target = resolve(dir);
  if (!target.startsWith(root + sep)) return;
  try { if (existsSync(root)) { const real = realpathSync(root); if (!realpathSync(dirname(target)).startsWith(real)) return; } } catch { return; }
  rmSync(target, { recursive: true, force: true });
}

export function uninstall(userId, id) {
  const installed = readInstalled(userId);
  if (!installed.items.has(id)) throw new InstallError('not_found', 'not installed');
  if (installed.corrupt) throw new InstallError('state_unreadable', 'the installed-extensions record cannot be read');
  removeStore(itemStoreDir(userId, id), userId);
  if (parseItemId(id)?.kind === 'plugin') removeViewsFor(userId, parseItemId(id).name);
  removeInstalled(userId, id);
  clearItem(userId, id);
  return { ok: true };
}

/** Account deletion: records, switches and bytes of one user. Best effort, never throws. */
export function forgetUserExtensions(userId) {
  try {
    if (typeof userId !== 'string' || !userId) return;
    forgetInstalledUser(userId);
    forgetUser(userId);
    rmSync(userStoreDir(userId), { recursive: true, force: true });
    removeAllViewsFor(userId);
  } catch { /* nothing to do */ }
}
