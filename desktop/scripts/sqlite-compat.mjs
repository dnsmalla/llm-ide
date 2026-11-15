// Helpers for the glibc 2.28 better-sqlite3 module that SSH mode uploads in its own bundle.
// The bundled prebuild needs glibc 2.34, which Ubuntu 20.04 servers do not have, so the module is
// built against manylinux_2_28 (see .github/workflows/sqlite-linux-compat.yml) and accepted here only
// when its SHA-256 matches the one published next to it.
import { createHash } from 'node:crypto';

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

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
