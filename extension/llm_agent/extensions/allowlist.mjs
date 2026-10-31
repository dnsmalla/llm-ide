// The install allowlist, per user (migration 0057).
//
//   effective(user) = operator list (LLMIDE_EXT_ALLOWED_SOURCES, or the default)
//                   + the user's own additions that still fit under the operator's CEILING.
//
// A per-user list can only ADD, never remove or widen the operator's list for anyone else, and it is only read
// for that user. The ceiling (LLMIDE_EXT_ALLOWED_SOURCES_CEILING, comma list of globs) is the operator's hard
// limit on what a user may add. With no ceiling a user may add any `owner/repo` or `owner/*` (one owner, any
// repository), but never an owner wildcard or any other glob: `*/*`, `a*/b` and the like need the operator's
// ceiling to cover them. The ceiling is re-applied when the list is READ, so tightening it takes effect at once
// for lists saved earlier (those entries are reported as `ignored`, not deleted).
import { getUserAllowlist, setUserAllowlist } from '../../kb/ext-allowlist.mjs';
import { DEFAULT_ALLOWED_SOURCES, parsePatterns, globMatches, sourceAllowed } from './sources/github.mjs';

export const MAX_USER_SOURCES = 50;
const PLAIN = /^[a-z0-9][a-z0-9._-]{0,99}\/(?:[a-z0-9][a-z0-9._-]{0,99}|\*)$/;
const GLOBBY = /^[a-z0-9*][a-z0-9._*-]{0,99}\/[a-z0-9._*-]{1,100}$/;

export class AllowlistError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'AllowlistError'; this.code = code; this.extra = extra; }
}

export function operatorPatterns(spec = process.env.LLMIDE_EXT_ALLOWED_SOURCES) {
  const l = parsePatterns(spec);
  return l.length ? l : DEFAULT_ALLOWED_SOURCES.split(',');
}

/** @returns {string[]|null} null when the operator set no ceiling */
export function ceilingPatterns(spec = process.env.LLMIDE_EXT_ALLOWED_SOURCES_CEILING) {
  const l = parsePatterns(spec);
  return l.length ? l : null;
}

/** `https://github.com/Owner/Repo.git/` and `Owner/Repo` are the same entry: lower-case `owner/repo`. */
export function normalizeEntry(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return s || null;
}

const coveredByCeiling = (entry, ceiling) => ceiling.some((c) => globMatches(c, entry));

/** Whether one normalized entry may be on a user's list under `ceiling` (null = none). */
export function entryAllowed(entry, ceiling) {
  if (ceiling) return GLOBBY.test(entry) && coveredByCeiling(entry, ceiling);
  return PLAIN.test(entry);
}

/** Validate a replacement list. @throws {AllowlistError} invalid_source | source_exceeds_ceiling | too_many_sources */
export function validateUserSources(list, ceiling = ceilingPatterns()) {
  if (!Array.isArray(list)) throw new AllowlistError('invalid_source', 'sources must be an array of owner/repo patterns');
  const out = [];
  for (const raw of list) {
    const e = normalizeEntry(raw);
    if (!e || !(PLAIN.test(e) || GLOBBY.test(e))) throw new AllowlistError('invalid_source', 'each source must look like owner/repo or owner/*', { entry: String(raw).slice(0, 120) });
    if (!entryAllowed(e, ceiling)) {
      throw new AllowlistError('source_exceeds_ceiling',
        ceiling ? 'that source is outside what the operator allows users to add' : 'only owner/repo or owner/* can be added; wider patterns need the operator to allow them',
        { entry: e });
    }
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > MAX_USER_SOURCES) throw new AllowlistError('too_many_sources', `at most ${MAX_USER_SOURCES} sources`, { max: MAX_USER_SOURCES });
  return out;
}

/** What GET returns: the operator list, the ceiling, the user's list and the merged result. */
export function allowlistView(userId) {
  const operator = operatorPatterns();
  const ceiling = ceilingPatterns();
  const stored = getUserAllowlist(userId);
  const user = stored.filter((e) => entryAllowed(e, ceiling));
  const ignored = stored.filter((e) => !entryAllowed(e, ceiling));
  return { operator, ceiling, user: stored, ignored, effective: [...new Set([...operator, ...user])] };
}

export function setAllowlist(userId, sources) {
  setUserAllowlist(userId, validateUserSources(sources));
  return allowlistView(userId);
}

/** Install gate for one user: the operator's list, or a user addition that fits under the ceiling. */
export function sourceAllowedFor(userId, owner, repo) {
  if (sourceAllowed(owner, repo)) return true;
  if (typeof userId !== 'string' || !userId) return false;
  let stored;
  try { stored = getUserAllowlist(userId); } catch { return false; }
  const ceiling = ceilingPatterns();
  const name = `${owner}/${repo}`;
  return stored.some((e) => entryAllowed(e, ceiling) && globMatches(e, name));
}
