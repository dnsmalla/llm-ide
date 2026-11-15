// Helpers for the glibc 2.28 better-sqlite3 module that SSH mode uploads in its own bundle.
// The bundled prebuild needs glibc 2.34, which Ubuntu 20.04 servers do not have, so the module is
// built against manylinux_2_28 (see .github/workflows/sqlite-linux-compat.yml) and accepted here only
// when its SHA-256 matches the one published next to it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// NOTE: The compat bundle gets its own name so the Rust side can prefer it and fall back to the hub
// bundle name when it is absent, without either side guessing from the other's file.
export function compatBundleName(version) {
  return `llmide-core-${version}-linux-x64-compat.tar.gz`;
}

// NOTE: Compares digests in lowercase hex. The `.sha256` file comes from `shasum -a 256`, which is lowercase,
// but a hand-edited file may not be, and a case difference alone must not reject a correct module.
export function verifyCompatModule(bytes, expectedSha256) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256.trim().toLowerCase()) {
    throw new Error('compat sqlite checksum mismatch');
  }
}

// NOTE: Reads the module and checks it against its sibling `<file>.sha256` in one place, so the staging
// script can fail before any staging work and tests can exercise the same rule without a network.
export function readCompatModule(file) {
  const shaFile = `${file}.sha256`;
  if (!existsSync(shaFile)) throw new Error(`compat sqlite checksum file missing: ${shaFile}`);
  const bytes = readFileSync(file);
  try {
    verifyCompatModule(bytes, readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0]);
  } catch (err) {
    throw new Error(`${err.message}: ${file}`);
  }
  return bytes;
}

// NOTE: The npm registry's `integrity` field is sha512 over the tarball bytes, so a tarball fetched by
// `npm pack` must hash to the lockfile value or the module was built from something other than the pinned package.
export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// NOTE: Returns the lockfile entry for a package; a missing entry is an error because building without a
// pinned version would silently pick whatever semver range resolves to on the day the job runs.
export function lockedPackage(lock, packagePath) {
  const entry = lock?.packages?.[packagePath];
  if (!entry?.version || !entry?.integrity) throw new Error(`lockfile has no pinned version for ${packagePath}`);
  return { version: entry.version, integrity: entry.integrity };
}

// NOTE: Versions are compared numerically per component. A string compare would rank GLIBC_2.4 above
// GLIBC_2.34, which would let a module that needs 2.34 pass the 2.28 ceiling.
export function maxGlibc(symbols) {
  let best = '0';
  for (const text of symbols) {
    for (const match of text.matchAll(/GLIBC_(\d+(?:\.\d+)*)/g)) {
      if (compareVersions(match[1], best) > 0) best = match[1];
    }
  }
  return best;
}

// NOTE: Ubuntu 20.04 ships libstdc++ 3.4.28 and CXXABI 1.3.12. A dynamic link against anything newer
// passes on the build container and then fails at dlopen on the server, so the limits are the server's.
export const SYMBOL_CEILINGS = Object.freeze({ GLIBC: '2.28', GLIBCXX: '3.4.28', CXXABI: '1.3.12' });

// NOTE: The lookbehind keeps `GLIBC_` from matching inside `GLIBCXX_`-style names on the same line.
// Tags with no digits (GLIBC_PRIVATE) match no family and are skipped on purpose: they are not versions.
export function symbolCeilings(objdumpText) {
  return {
    glibc: highestVersion(objdumpText, 'GLIBC'),
    glibcxx: highestVersion(objdumpText, 'GLIBCXX'),
    cxxabi: highestVersion(objdumpText, 'CXXABI'),
  };
}

// NOTE: Returns one problem per family above its ceiling. The caller decides the exit code, so the rule
// stays testable without spawning a process.
export function checkCeilings(objdumpText) {
  const found = symbolCeilings(objdumpText);
  const problems = [];
  for (const [key, family] of [['glibc', 'GLIBC'], ['glibcxx', 'GLIBCXX'], ['cxxabi', 'CXXABI']]) {
    const limit = SYMBOL_CEILINGS[family];
    if (compareVersions(found[key], limit) > 0) {
      problems.push(`${family}_${found[key]} is above the ${family}_${limit} ceiling (Ubuntu 20.04 limit)`);
    }
  }
  return problems;
}

function highestVersion(text, family) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${family}_(\\d+(?:\\.\\d+)*)`, 'g');
  let best = '0';
  for (const match of text.matchAll(pattern)) {
    if (compareVersions(match[1], best) > 0) best = match[1];
  }
  return best;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
