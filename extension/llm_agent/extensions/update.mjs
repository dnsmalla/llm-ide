// Updates, rollback and repair of installed catalog items (plan section 9a).
//
// Every step is the user's: nothing here runs on a timer and nothing installs
// by itself. `checkUpdates` only RESOLVES a ref to a commit (one small API call
// per item); `previewUpdate` downloads the candidate into memory and diffs it
// against the bytes on disk without writing anything; `applyUpdate` writes the
// new commit beside the current one.
//
// The rules that matter:
//  - a consent is per commit. An update to a new commit that declares an
//    executable kind (hook, mcp, lsp, bin) is NOT covered by the old consent:
//    the item keeps its prior on/off state only when the request carries a
//    consent for every kind the new commit declares; otherwise it is switched
//    off, with a reason the UI can show;
//  - the previous version's bytes stay on disk (exactly one) so rollback is
//    instant and offline; an older one is removed when a newer update lands;
//  - rollback restores the previous record with ITS consents (valid for that
//    commit) and the same enabled rule;
//  - repair re-fetches the pinned commit (never a newer one) when the bytes are
//    missing or differ from the recorded fingerprint, and refuses bytes that do
//    not match it: a commit's content does not change upstream.
// Nothing fetched is executed; the same pinned fetch, caps and tar rules as install.

import { mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';
import { makePinnedFetch } from '../../server/pinned-fetch.mjs';
import { parseRepoUrl, resolveCommit, downloadArchive, sourceAllowed, isCommitSha, validRef } from './sources/github.mjs';
import { extractTarGz } from './sources/tar.mjs';
import { inspectTree } from './inspect.mjs';
import { scanTree, summarizeFindings } from './scan.mjs';
import { validateSource } from '../../plugins/source-store.mjs';
import { catalogEnabled, scanEnabled } from './flags.mjs';
import { removeViewsFor } from './view.mjs';
import { parseItemId } from './model.mjs';
import { readOverlay, setItemEnabled } from './store.mjs';
import { readInstalled, putInstalled, itemStoreDir, baseDir } from './installed.mjs';
import { missingConsents, clearInstalledRuntimeCache } from './installed-runtime.mjs';
import { treeHash, readTreeFromDisk, verifyDir, diffTrees } from './integrity.mjs';
import { InstallError, mapFetchError, writeTree, removeStore, validSubpath, busy, view, MAX_FINDINGS_KEPT } from './install.mjs';

const MAX_CHECK_ITEMS = 100;
const SNAPSHOT_FIELDS = ['source', 'pinnedCommit', 'storeDir', 'version', 'description', 'members', 'declared', 'permissions', 'scan', 'consents', 'integrity', 'installedAt'];

function need(userId, id) {
  const installed = readInstalled(userId);
  if (installed.corrupt || readOverlay(userId).corrupt) throw new InstallError('state_unreadable', 'the extensions state cannot be read');
  const rec = installed.items.get(id);
  if (!parseItemId(id) || !rec) throw new InstallError('not_found', 'not installed');
  return rec;
}

function snapshot(rec) {
  const out = {};
  for (const k of SNAPSHOT_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
  return out;
}

const sourceOf = (rec) => (rec.source?.kind === 'git' ? parseRepoUrl(rec.source.url) : null);

function lockFor(userId, id) {
  const key = `${userId}\u0000${id}`;
  if (busy.has(key)) throw new InstallError('busy', 'this item is being changed');
  busy.add(key);
  return () => busy.delete(key);
}

/** Download `commit` of the item's repository and read it like an install does. Nothing is written. */
async function loadCandidate(rec, commit, { fetch: f, signal }) {
  const repo = sourceOf(rec);
  if (!repo) throw new InstallError('invalid_url', 'this item has no GitHub source');
  if (!sourceAllowed(repo.owner, repo.repo)) throw new InstallError('source_not_allowed', 'this source is not on the allowed list');
  const subpath = validSubpath(rec.subpath);
  let archive; let tree;
  try {
    archive = await downloadArchive({ owner: repo.owner, repo: repo.repo, commit }, { fetch: f, signal });
    tree = extractTarGz(archive);
  } catch (err) { throw mapFetchError(err); }
  let files = tree.files;
  if (subpath) {
    files = new Map();
    for (const [p, b] of tree.files) if (p.startsWith(`${subpath}/`)) files.set(p.slice(subpath.length + 1), b);
    if (!files.size) throw new InstallError('not_found', 'the item is no longer at that path in this commit');
  }
  const fallbackName = (subpath ? subpath.split('/').pop() : repo.repo).toLowerCase();
  const info = inspectTree(files, { publisher: repo.owner.toLowerCase(), fallbackName });
  if (!info.ok) throw new InstallError('nothing_installable', 'this commit holds nothing installable');
  if (info.id !== rec.id) throw new InstallError('identity_changed', 'this commit describes a different item; install it separately', { id: rec.id, found: info.id });
  return { repo, files, skipped: tree.skipped, info };
}

function pinnedFetch(deps) { return deps.fetch ?? makePinnedFetch({ allowPrivate: false }); }

function requireCatalog() {
  if (!catalogEnabled()) throw new InstallError('catalog_disabled', 'the extensions catalog is switched off');
}

/** The commit to move to: an explicit 40-hex one, else the one a check found, else resolve the ref now. */
async function targetCommit(rec, commit, deps, { resolveIfMissing }) {
  if (commit !== undefined && commit !== null && commit !== '') {
    if (!isCommitSha(commit)) throw new InstallError('invalid_commit', 'commit must be 40 hex characters');
    return commit;
  }
  if (isCommitSha(rec.update?.latest)) return rec.update.latest;
  if (!resolveIfMissing) throw new InstallError('not_found', 'no update has been found; check for updates first');
  const repo = sourceOf(rec);
  try { return await resolveCommit({ owner: repo.owner, repo: repo.repo, ref: rec.source.ref }, { fetch: pinnedFetch(deps), signal: deps.signal }); }
  catch (err) { throw mapFetchError(err); }
}

/**
 * Resolve each installed item's ref to a commit and remember what was found.
 * One item failing never stops the others. User-initiated.
 * @returns {{ checkedAt: string, results: Array<{ id: string, current: string, latest?: string, updateAvailable: boolean, error?: string }> }}
 */
export async function checkUpdates(userId, { id, fetch: fetchImpl, signal } = {}) {
  requireCatalog();
  const installed = readInstalled(userId);
  if (installed.corrupt) throw new InstallError('state_unreadable', 'the installed-extensions record cannot be read');
  let ids = [...installed.items.keys()].sort();
  if (id !== undefined) { if (!installed.items.has(id)) throw new InstallError('not_found', 'not installed'); ids = [id]; }
  const f = fetchImpl ?? makePinnedFetch({ allowPrivate: false });
  const checkedAt = new Date().toISOString();
  const results = [];
  for (const itemId of ids.slice(0, MAX_CHECK_ITEMS)) {
    const rec = installed.items.get(itemId);
    const repo = sourceOf(rec);
    if (!repo) { results.push({ id: itemId, current: rec.pinnedCommit, updateAvailable: false, error: 'no_source' }); continue; }
    if (rec.source.ref !== undefined && !validRef(rec.source.ref)) { results.push({ id: itemId, current: rec.pinnedCommit, updateAvailable: false, error: 'invalid_ref' }); continue; }
    try {
      const latest = await resolveCommit({ owner: repo.owner, repo: repo.repo, ref: rec.source.ref }, { fetch: f, signal });
      const available = latest !== rec.pinnedCommit;
      // Re-read: another request may have changed the record while we waited on the network.
      const fresh = readInstalled(userId).items.get(itemId);
      if (fresh) {
        const next = { ...fresh };
        if (available) next.update = { latest, checkedAt }; else delete next.update;
        putInstalled(userId, itemId, next);
      }
      results.push({ id: itemId, current: rec.pinnedCommit, latest, updateAvailable: available });
    } catch (err) {
      results.push({ id: itemId, current: rec.pinnedCommit, updateAvailable: false, error: mapFetchError(err).code });
    }
  }
  return { checkedAt, results };
}

/** What a check found, from the records only (no network). */
export function listUpdates(userId) {
  const installed = readInstalled(userId);
  const items = [];
  for (const id of [...installed.items.keys()].sort()) {
    const rec = installed.items.get(id);
    if (isCommitSha(rec.update?.latest) && rec.update.latest !== rec.pinnedCommit) {
      items.push({ id, name: rec.name, kind: rec.kind, current: rec.pinnedCommit, latest: rec.update.latest, checkedAt: rec.update.checkedAt ?? null, ...(rec.source?.ref ? { ref: rec.source.ref } : {}), hasPrevious: !!rec.previous });
    }
  }
  return { corrupt: installed.corrupt, items };
}

const findingKey = (f) => `${f.rule}|${f.file}|${f.detail}|${f.excerpt ?? ''}`;
const NOT_COMPARABLE = new Set(['link_skipped', 'large_file_skipped']);

/**
 * What an update would change, computed in memory. Writes nothing.
 * Flags what needs a new consent and what happens to the item's on/off state.
 */
export async function previewUpdate(userId, id, { commit, fetch: fetchImpl, signal } = {}) {
  requireCatalog();
  const rec = need(userId, id);
  const to = await targetCommit(rec, commit, { fetch: fetchImpl, signal }, { resolveIfMissing: true });
  if (to === rec.pinnedCommit) throw new InstallError('already_current', 'already at this commit', { commit: to });
  const f = pinnedFetch({ fetch: fetchImpl });
  const cand = await loadCandidate(rec, to, { fetch: f, signal });
  const cur = readTreeFromDisk(join(itemStoreDir(userId, id), rec.pinnedCommit));
  if (cur.error) throw new InstallError('bytes_missing', 'the installed files are missing or damaged; repair first', { status: cur.error, use: '/auth/me/extensions/repair' });

  const files = diffTrees(cur.files, cand.files);
  const beforeF = scanEnabled() ? scanTree(cur.files) : [];
  const afterF = scanEnabled() ? scanTree(cand.files, { skipped: cand.skipped }) : [];
  const seen = new Set(beforeF.map(findingKey));
  const fresh = afterF.filter((x) => !NOT_COMPARABLE.has(x.rule) && !seen.has(findingKey(x)));
  const gone = new Set(afterF.map(findingKey));
  const resolved = beforeF.filter((x) => !NOT_COMPARABLE.has(x.rule) && !gone.has(findingKey(x)));

  const oldKinds = new Set(Array.isArray(rec.declared?.executableKinds) ? rec.declared.executableKinds : []);
  const oldMembers = new Set((rec.members ?? []).map((m) => m.memberId));
  const newKinds = cand.info.executableKinds.filter((k) => !oldKinds.has(k));
  const newExecutableMembers = cand.info.members.filter((m) => m.executable && !oldMembers.has(m.memberId)).map((m) => ({ memberId: m.memberId, type: m.type, name: m.name }));
  const wasEnabled = readOverlay(userId).items.get(id)?.enabled === true;
  const consentKinds = cand.info.executableKinds;
  return {
    id, from: rec.pinnedCommit, to,
    version: { from: rec.version ?? null, to: cand.info.version },
    files,
    scan: { before: summarizeFindings(beforeF), after: summarizeFindings(afterF), newFindings: fresh.slice(0, MAX_FINDINGS_KEPT), resolvedCount: resolved.length },
    executable: { newKinds, newMembers: newExecutableMembers, kinds: consentKinds },
    members: { added: cand.info.members.filter((m) => !oldMembers.has(m.memberId)).map((m) => m.memberId), removed: [...oldMembers].filter((m) => !cand.info.members.some((n) => n.memberId === m)) },
    consent: { required: consentKinds.length > 0, kinds: consentKinds },
    wasEnabled,
    // With no executable kinds the old state carries over; otherwise only a consent for every kind keeps it on.
    staysEnabledWithoutConsent: wasEnabled && consentKinds.length === 0,
    flags: [
      ...(newKinds.length ? ['new_executable_kind'] : []),
      ...(newExecutableMembers.length ? ['new_executable_member'] : []),
      ...(fresh.length ? ['new_findings'] : []),
      ...(consentKinds.length ? ['consent_required'] : []),
    ],
  };
}

function swapIn(userId, itemDir, files, sha) {
  const finalDir = join(itemDir, sha);
  const staging = join(itemDir, `.staging-${randomBytes(6).toString('hex')}`);
  try {
    mkdirSync(itemDir, { recursive: true, mode: 0o700 });
    writeTree(files, staging);
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err instanceof InstallError ? err : new InstallError('write_failed', 'could not store the item');
  }
  return finalDir;
}

/** After the record moved to `next`: keep the prior on/off state only while every consent covers the new commit. */
function settleEnabled(userId, id, next, wasEnabled) {
  const missing = missingConsents(next);
  if (!wasEnabled) return { enabled: false, wasEnabled, kinds: [] };
  if (missing.length === 0) return { enabled: true, wasEnabled, kinds: [] };
  setItemEnabled(userId, id, false);
  return { enabled: false, wasEnabled, reason: 'consent_required', kinds: missing };
}

const grants = (kinds, given, sha) => {
  const g = new Set((Array.isArray(given) ? given : []).filter((c) => typeof c === 'string'));
  const at = new Date().toISOString();
  return Object.fromEntries(kinds.filter((k) => g.has(k)).map((k) => [k, { grantedAt: at, commit: sha }]));
};

/** Move an item to a new commit. The previous version stays on disk for rollback. */
export async function applyUpdate(userId, id, { commit, consents = [], fetch: fetchImpl, signal } = {}) {
  requireCatalog();
  const rec = need(userId, id);
  const to = await targetCommit(rec, commit, { fetch: fetchImpl, signal }, { resolveIfMissing: false });
  if (to === rec.pinnedCommit) throw new InstallError('already_current', 'already at this commit', { commit: to });
  const unlock = lockFor(userId, id);
  try {
    const cand = await loadCandidate(rec, to, { fetch: pinnedFetch({ fetch: fetchImpl }), signal });
    const findings = scanEnabled() ? scanTree(cand.files, { skipped: cand.skipped }) : [];
    const src = validateSource({ kind: 'git', url: cand.repo.url, commit: to, ...(rec.source.ref ? { ref: rec.source.ref } : {}) });
    if (!src.ok) throw new InstallError('invalid_url', `source: ${src.error}`);
    const itemDir = itemStoreDir(userId, id);
    const finalDir = swapIn(userId, itemDir, cand.files, to);
    const wasEnabled = readOverlay(userId).items.get(id)?.enabled === true;
    const { previous: olderPrevious, update: _drop, ...base } = rec;
    const next = {
      ...base,
      description: cand.info.description, version: cand.info.version, members: cand.info.members,
      declared: { executableKinds: cand.info.executableKinds }, permissions: cand.info.permissions,
      source: src.source, pinnedCommit: to, updatedAt: new Date().toISOString(),
      scan: { ...summarizeFindings(findings), findings: findings.slice(0, MAX_FINDINGS_KEPT) },
      consents: grants(cand.info.executableKinds, consents, to),
      integrity: treeHash(cand.files),
      storeDir: relative(baseDir(), finalDir),
      previous: snapshot(rec),
    };
    if (!putInstalled(userId, id, next)) {
      rmSync(finalDir, { recursive: true, force: true });
      throw new InstallError('state_unreadable', 'the extensions state file cannot be written');
    }
    // Exactly one older version is kept: drop the one before the one we just kept.
    const dropSha = olderPrevious?.pinnedCommit;
    if (isCommitSha(dropSha) && dropSha !== to && dropSha !== rec.pinnedCommit) removeStore(join(itemDir, dropSha), userId);
    if (parseItemId(id).kind === 'plugin') removeViewsFor(userId, parseItemId(id).name);
    clearInstalledRuntimeCache();
    const settled = settleEnabled(userId, id, next, wasEnabled);
    return { ok: true, item: view(userId, id), update: { from: rec.pinnedCommit, to, ...settled } };
  } finally { unlock(); }
}

/** Go back to the version kept from before the last update (or forward again: the two swap). Offline. */
export function rollback(userId, id) {
  requireCatalog();
  const rec = need(userId, id);
  const prev = rec.previous;
  if (!prev || typeof prev !== 'object' || !isCommitSha(prev.pinnedCommit)) throw new InstallError('no_previous', 'there is no earlier version to go back to');
  const unlock = lockFor(userId, id);
  try {
    const dir = join(itemStoreDir(userId, id), prev.pinnedCommit);
    const v = verifyDir(dir, prev.integrity);
    if (v.status === 'missing' || v.status === 'corrupt') throw new InstallError('previous_unavailable', 'the earlier version is missing or damaged; update again instead', { status: v.status });
    const wasEnabled = readOverlay(userId).items.get(id)?.enabled === true;
    const { previous: _p, update: _u, ...base } = rec;
    const next = { ...base, ...prev, previous: snapshot(rec), updatedAt: new Date().toISOString() };
    if (!putInstalled(userId, id, next)) throw new InstallError('state_unreadable', 'the extensions state file cannot be written');
    if (parseItemId(id).kind === 'plugin') removeViewsFor(userId, parseItemId(id).name);
    clearInstalledRuntimeCache();
    const settled = settleEnabled(userId, id, next, wasEnabled);
    return { ok: true, item: view(userId, id), rollback: { from: rec.pinnedCommit, to: prev.pinnedCommit, ...settled } };
  } finally { unlock(); }
}

/**
 * Check the item's bytes against the recorded fingerprint and, when they are
 * missing or differ, re-fetch THE PINNED COMMIT and put them back. Bytes that
 * do not match the fingerprint recorded at install are refused.
 */
export async function repair(userId, id, { fetch: fetchImpl, signal } = {}) {
  requireCatalog();
  const rec = need(userId, id);
  if (!isCommitSha(rec.pinnedCommit)) throw new InstallError('invalid_commit', 'the record has no pinned commit');
  const dir = join(itemStoreDir(userId, id), rec.pinnedCommit);
  const before = verifyDir(dir, rec.integrity);
  if (before.status === 'ok') return { ok: true, repaired: false, status: 'ok', item: view(userId, id) };
  const unlock = lockFor(userId, id);
  try {
    const cand = await loadCandidate(rec, rec.pinnedCommit, { fetch: pinnedFetch({ fetch: fetchImpl }), signal });
    const hash = treeHash(cand.files);
    if (rec.integrity && hash !== rec.integrity) throw new InstallError('integrity_mismatch', 'the downloaded files differ from what was installed; not restoring them', { commit: rec.pinnedCommit });
    let repaired = false;
    if (before.status === 'unverified' && before.hash === hash) { /* the bytes on disk are the pinned commit's: only record the fingerprint */ }
    else { swapIn(userId, itemStoreDir(userId, id), cand.files, rec.pinnedCommit); repaired = true; }
    const fresh = readInstalled(userId).items.get(id) ?? rec;
    if (!putInstalled(userId, id, { ...fresh, integrity: hash })) throw new InstallError('state_unreadable', 'the extensions state file cannot be written');
    clearInstalledRuntimeCache();
    return { ok: true, repaired, status: repaired ? 'restored' : 'verified', was: before.status, item: view(userId, id) };
  } finally { unlock(); }
}
