// One backup pass in a CHILD process (kb/backup-databases.mjs forks this): `VACUUM INTO` copies the whole database
// synchronously, so on the server's event loop it stalled every request for the duration (a 50 MB DB ~0.5 s, more on
// a slow disk). This process opens each DB READ-ONLY (the running server owns the writer) and writes the snapshots;
// the parent awaits our exit and then prunes. No secrets are needed or read here, and none are logged.
//
// Args: <dataDb> <dataTarget> [<agentDb> <agentTarget>] — empty agent args mean "no agent DB".
import fs from 'node:fs';
import Database from 'better-sqlite3';

const [dataDb, dataTarget, agentDb, agentTarget] = process.argv.slice(2);

function vacuumInto(source, target) {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(String(target));
  } finally {
    db.close();
  }
}

try {
  if (!dataDb || !dataTarget) throw new Error('usage: backup-worker.mjs <dataDb> <dataTarget> [<agentDb> <agentTarget>]');
  vacuumInto(dataDb, dataTarget);
  if (agentDb && agentTarget && fs.existsSync(agentDb)) vacuumInto(agentDb, agentTarget);
  process.exit(0);
} catch (err) {
  process.stderr.write(`backup worker: ${String(err?.message ?? err).slice(0, 500)}\n`);
  process.exit(1);
}
