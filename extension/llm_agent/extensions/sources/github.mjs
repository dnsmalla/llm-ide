// GitHub as a source: resolve a repo + ref to a 40-hex commit, then download
// the archive AT THAT COMMIT. The caller supplies `fetch` (the SSRF-pinned one
// in production, a fixture in tests); nothing here opens a socket itself.
//
// Only two hosts are ever contacted, over https, with no credentials and no
// redirects followed:
//   api.github.com     commit resolution
//   codeload.github.com the archive
// A user-initiated install is the only caller (plan decision: every download is
// the user's click).

import { ArchiveError, ARCHIVE_LIMITS } from './tar.mjs';

export const GITHUB_API_HOST = 'api.github.com';
export const GITHUB_CODELOAD_HOST = 'codeload.github.com';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_API_BYTES = 4096;

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}

/** `https://github.com/<owner>/<repo>[.git][/]` only: no other host, path, query, fragment or credentials. */
export function parseRepoUrl(url) {
  if (typeof url !== 'string' || url.length > 200 || /[\s\u0000-\u001f]/.test(url)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com' || u.username || u.password
      || u.port || u.search || u.hash) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export const isCommitSha = (v) => typeof v === 'string' && SHA_RE.test(v);

export function validRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.startsWith('-') && !ref.startsWith('/') && !ref.endsWith('/')
    && !ref.split('/').some((s) => s === '' || s === '.' || s === '..');
}

async function readCapped(res, max) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) { try { await res.body?.cancel?.(); } catch { /* ignore */ } throw new ArchiveError('too_large', 'the download is too large'); }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new ArchiveError('too_large', 'the download is too large'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new ArchiveError('too_large', 'the download is too large');
  return buf;
}

function guarded(fetchImpl, host) {
  return async (path, init = {}) => {
    const url = `https://${host}${path}`;
    const res = await fetchImpl(url, { ...init, redirect: 'manual', headers: { 'user-agent': 'llm-ide-extensions', ...(init.headers || {}) } });
    if (res.status >= 300 && res.status < 400) throw new SourceError('redirect_refused', 'GitHub answered with a redirect');
    return res;
  };
}

/**
 * The commit a user's choice stands for. A 40-hex commit is used as given (the
 * pin); a ref (branch, tag) or nothing (the default branch) is resolved once,
 * now, and the result is what is recorded.
 */
export async function resolveCommit({ owner, repo, ref, commit }, { fetch: fetchImpl, signal } = {}) {
  if (commit !== undefined && commit !== null && commit !== '') {
    if (!isCommitSha(commit)) throw new SourceError('invalid_commit', 'commit must be 40 hex characters');
    return commit;
  }
  if (ref !== undefined && ref !== null && ref !== '' && !validRef(ref)) throw new SourceError('invalid_ref', 'invalid ref');
  const seg = (ref ? String(ref) : 'HEAD').split('/').map(encodeURIComponent).join('/');
  const res = await guarded(fetchImpl, GITHUB_API_HOST)(`/repos/${owner}/${repo}/commits/${seg}`,
    { signal, headers: { accept: 'application/vnd.github.sha' } });
  if (res.status === 404 || res.status === 422) throw new SourceError('not_found', 'repository or ref not found');
  if (!res.ok) throw new SourceError('upstream', `GitHub answered ${res.status}`);
  const text = (await readCapped(res, MAX_API_BYTES)).toString('utf8').trim();
  if (!SHA_RE.test(text)) throw new SourceError('upstream', 'GitHub did not return a commit');
  return text;
}

/** The gzip'd tar of the repo AT the commit. */
export async function downloadArchive({ owner, repo, commit }, { fetch: fetchImpl, signal, maxBytes = ARCHIVE_LIMITS.compressedBytes } = {}) {
  if (!isCommitSha(commit)) throw new SourceError('invalid_commit', 'commit must be 40 hex characters');
  const res = await guarded(fetchImpl, GITHUB_CODELOAD_HOST)(`/${owner}/${repo}/tar.gz/${commit}`, { signal, headers: { accept: 'application/gzip' } });
  if (res.status === 404) throw new SourceError('not_found', 'that commit was not found');
  if (!res.ok) throw new SourceError('upstream', `GitHub answered ${res.status}`);
  return readCapped(res, maxBytes);
}

/** What an install may come from when the operator has not set `LLMIDE_EXT_ALLOWED_SOURCES`. a `star/star` pattern in the variable opens it to any repository. */
export const DEFAULT_ALLOWED_SOURCES = 'anthropics/*,modelcontextprotocol/*';

/** Operator allowlist (`LLMIDE_EXT_ALLOWED_SOURCES`, comma list of `owner/repo` globs). Unset or blank: {@link DEFAULT_ALLOWED_SOURCES}. */
export function sourceAllowed(owner, repo, spec = process.env.LLMIDE_EXT_ALLOWED_SOURCES) {
  let list = String(spec ?? '').split(',').map((s) => s.trim().replace(/^github\.com\//, '')).filter(Boolean);
  if (!list.length) list = DEFAULT_ALLOWED_SOURCES.split(',');
  const name = `${owner}/${repo}`.toLowerCase();
  return list.some((pat) => {
    const re = new RegExp(`^${pat.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
    return re.test(name);
  });
}
