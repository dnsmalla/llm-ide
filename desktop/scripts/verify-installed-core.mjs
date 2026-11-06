// Re-checks an INSTALLED/packaged core folder for the SDK's claude binary (verifyNoSdkBinary).
//   node scripts/verify-installed-core.mjs <core dir>   (the folder holding node + root/)
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyNoSdkBinary } from './sdk-binary.mjs';

/** Problems for an installed core dir; a missing root/ means the path is wrong, not clean. */
export function installedCoreProblems(dir) {
  if (!existsSync(join(dir, 'root'))) return [`not a core folder (no root/): ${dir}`];
  return verifyNoSdkBinary(dir);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const p = installedCoreProblems(resolve(process.argv[2] ?? ''));
  for (const x of p) console.error(`::error::${x}`);
  process.exit(p.length ? 1 : 0);
}
