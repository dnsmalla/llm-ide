// What may enter the bundled core, and a verification pass over the staged tree.
//
// stage-core.mjs copies extension/ with a denylist for the top level, but a denylist
// only ever catches what someone thought of: a live `kb/data.db`, a `*.pre-move` DB
// backup, a `.bak`, `.dev-secrets*`, `server.log` or a `backups/` dir in a dev checkout
// would otherwise ship inside the .app. So:
//   - under `kb/` (the data-access layer, including `kb/migrations`) only source and
//     schema files are copied: .mjs .json .sql (an ALLOWLIST);
//   - the whole extension copy drops symlinks, and
//   - `verifyStagedCore` re-walks the finished stage and FAILS on anything that should
//     never ship, or any symlink that leaves the staged tree.
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export const KB_ALLOWED_EXT = /\.(mjs|json|sql)$/;

/** Secrets and local agent state (kept in step with the SKIP_SECRET rule in stage-core). */
const SECRET_NAME = /^(\.env(\..+)?|\.dev-secrets.*|\.claude|.+\.(pem|key))$/;
/** Names that must never be staged outside node_modules. */
const FORBIDDEN_NAME = /(\.db($|[-.])|\.db-(wal|shm|journal)|\.pre-move|\.bak$|\.bak\.|^\.dev-secrets|^server\.log|^backups$)/;

export const isSecretName = (name) => SECRET_NAME.test(name) && name !== '.env.example';

/**
 * A `cpSync` filter for copying `<repo>/extension` into the stage. `extRoot` is the
 * source `extension/` directory. Symlinks are dropped; files under `kb/` must match
 * the allowlist; secrets and live data files are dropped everywhere.
 */
export function makeCopyFilter(extRoot, { skipFile }) {
  const kbRoot = join(extRoot, 'kb') + sep;
  return (src) => {
    const name = basename(src);
    if (isSecretName(name) || skipFile.test(name)) return false;
    let st;
    try { st = lstatSync(src); } catch { return false; }
    if (st.isSymbolicLink()) return false;
    if (st.isFile() && src.startsWith(kbRoot)) return KB_ALLOWED_EXT.test(name) && !FORBIDDEN_NAME.test(name);
    if (st.isDirectory() && src.startsWith(kbRoot) && FORBIDDEN_NAME.test(name)) return false;
    return true;
  };
}

/** Problems found in a staged core directory (empty = clean). */
export function verifyStagedCore(coreDir) {
  const problems = [];
  if (!existsSync(coreDir)) return [`staged core missing: ${coreDir}`];
  const base = realpathSync(coreDir);
  const walk = (dir, inNodeModules) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(coreDir, p);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        let real = null;
        try { real = realpathSync(p); } catch { /* dangling */ }
        if (!real || (real !== base && !real.startsWith(base + sep))) problems.push(`symlink leaves the staged tree: ${rel}`);
        continue;
      }
      const nm = inNodeModules || name === 'node_modules';
      if (!nm && FORBIDDEN_NAME.test(name)) problems.push(`forbidden file in stage: ${rel}`);
      if (!nm && isSecretName(name)) problems.push(`secret or agent-state file in stage: ${rel}`);
      if (st.isDirectory()) { walk(p, nm); continue; }
      const parts = rel.split(sep);
      const i = parts.lastIndexOf('kb');
      if (!nm && i >= 0 && parts[i - 1] === 'extension' && !KB_ALLOWED_EXT.test(name)) problems.push(`non-source file under kb/: ${rel}`);
    }
  };
  walk(coreDir, false);
  return problems;
}
