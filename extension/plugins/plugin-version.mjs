// Version comparison for plugins: semver when both sides parse (numeric),
// otherwise SHA-prefix matching for marketplace commits. A SHA is never
// "newer", only "different".

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;
const HEX = /^[0-9a-f]{7,40}$/i;

/**
 * Parse semantic version into [major, minor, patch, prerelease|null].
 * @param {string} v
 * @returns {number[]|null}
 */
export function parseSemver(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
}

/**
 * Returns true if `a` is strictly newer than `b` using numeric semver comparison.
 * Both must parse as valid semver; returns false if either does not.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isNewer(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  if (x[3] === y[3]) return false;
  if (x[3] === null) return true; // release > prerelease
  if (y[3] === null) return false; // prerelease < release
  return x[3] > y[3];
}

/**
 * Returns true if `a` and `b` represent different versions.
 * For SHA hex strings (7-40 chars): prefixes match means same, otherwise differ.
 * For semver or other strings: string inequality after trim.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function versionsDiffer(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (HEX.test(x) && HEX.test(y)) return !(x.startsWith(y) || y.startsWith(x));
  return x !== y;
}

/**
 * Determines if an upstream plugin has a newer version available.
 * Returns 'upstream' if update available, null otherwise.
 *
 * Rules (in order):
 * 1. If available.version exists: compare as semver if both parse,
 *    else use versionsDiffer; return 'upstream' if newer/differs
 * 2. If available.source.sha exists: use versionsDiffer; return 'upstream' if differs
 * 3. Otherwise return null
 *
 * @param {{installedVersion: string, available: {version?: string, source?: {sha?: string}}}} opts
 * @returns {'upstream'|null}
 */
export function upstreamTier({ installedVersion, available }) {
  if (!available) return null;

  if (typeof available.version === 'string' && available.version) {
    const both = parseSemver(installedVersion) && parseSemver(available.version);
    if (both) return isNewer(available.version, installedVersion) ? 'upstream' : null;
    return versionsDiffer(installedVersion, available.version) ? 'upstream' : null;
  }

  const sha = available.source && typeof available.source === 'object' ? available.source.sha : null;
  if (typeof sha === 'string' && sha) {
    return versionsDiffer(installedVersion, sha) ? 'upstream' : null;
  }

  return null;
}

/**
 * Pick an installed plugin entry by id and scope preference.
 * Scope matching: exact match first, then 'user', then first.
 * @param {Array} installed - array of {id, scope, ...}
 * @param {string} pluginId
 * @param {string} [scope] - preferred scope
 * @returns {Object|null}
 */
export function pickInstalledEntry(installed, pluginId, scope) {
  const all = (installed || []).filter((e) => e.id === pluginId);
  return all.find((e) => scope && e.scope === scope) || all.find((e) => e.scope === 'user') || all[0] || null;
}
