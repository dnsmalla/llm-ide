// Side-effect import: runs the data-dir migration at evaluation time.
// server.mjs imports this second (after core/env-compat.mjs), so it runs before
// core/config.mjs, core/logger.mjs and kb/db.mjs read any data location. ES
// modules evaluate imports in source order, depth-first, before a module body.
import path from 'path';
import { fileURLToPath } from 'url';
import { runDataDirMigration } from './data-dir-migration.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const dataDirMigration = runDataDirMigration({ root: REPO_ROOT });

// The repo kb was moved and this run would open it as fresh: stop, say why.
if (dataDirMigration.status === 'refused') {
  process.stderr.write(`${dataDirMigration.notes.join('\n')}\n`);
  process.exit(1);
}
