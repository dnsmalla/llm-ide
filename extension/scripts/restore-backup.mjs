// Restore a data.db (+ agent.db) backup written by the server's backup path.
//
//   node scripts/restore-backup.mjs --backup <data-backup.db> --yes
//   node scripts/restore-backup.mjs --backup <data.db> --agent <data.agent.db> --yes
//
// Stop the server / desktop core first: this replaces the live files, and the
// single-writer rule forbids doing that under a running core. Without --yes it
// only verifies both backups and prints what it WOULD replace (exit 2).
//
// Verification happens before anything live moves: integrity_check +
// quick_check, tables, and the applied schema_migrations version. The live
// files are then snapshotted to *.pre-restore-<stamp>.db, the staged backup is
// verified again, and only then renamed in. A failure at any point puts the old
// files back (both halves of the pair).
//
//   --db <path>        live data.db (default: config.dbPath)
//   --agent-db <path>  live agent.db (default: config.agentDbPath)
//   --agent <path>     agent.db backup to restore with it
//   --json             one JSON report on stdout
//   --yes              actually restore; without it this is a dry run

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../core/config.mjs';
import { inspectBackup, restoreBackup } from '../kb/restore-backup.mjs';

function parseArgs(argv) {
  const out = { backup: null, agent: null, db: config.dbPath, agentDb: config.agentDbPath, yes: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--backup') out.backup = argv[++i] ?? '';
    else if (a === '--agent') out.agent = argv[++i] ?? '';
    else if (a === '--db') out.db = argv[++i] ?? '';
    else if (a === '--agent-db') out.agentDb = argv[++i] ?? '';
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function humanPlan(args, data, agent) {
  const rows = [
    'LLM-IDE restore backup',
    `Data backup:  ${args.backup}`,
    `  ${data.ok ? `verified: ${data.totalRows} rows, schema v${data.migration}, ${data.sizeBytes} bytes` : `NOT USABLE: ${data.message ?? data.reason}`}`,
    `Live data.db: ${args.db}${fs.existsSync(args.db) ? ` (${fs.statSync(args.db).size} bytes; a pre-restore copy will be kept)` : ' (does not exist yet)'}`,
  ];
  if (args.agent) {
    rows.push(`Agent backup: ${args.agent}`);
    rows.push(`  ${agent.ok ? `verified: ${agent.totalRows} rows, schema v${agent.migration ?? '?'}` : `NOT USABLE: ${agent.message ?? agent.reason}`}`);
    rows.push(`Live agent.db: ${args.agentDb}`);
  }
  rows.push(args.yes ? 'Restoring...' : 'Dry run: nothing was changed. Re-run with --yes to restore.');
  return rows.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (err) { console.error(err.message); return 2; }
  if (args.help) {
    process.stdout.write([
      'Usage: node scripts/restore-backup.mjs --backup <data.db> [--agent <agent.db>] [--db <live data.db>] [--agent-db <live agent.db>] [--yes] [--json]',
      '',
      'Stop the server/desktop core first. Without --yes this is a verified dry run.',
      '',
    ].join('\n'));
    return 0;
  }
  if (!args.backup) { console.error('--backup is required'); return 2; }

  // Always verify first, even for the dry run: the report must not claim a bad
  // file is restorable.
  const data = inspectBackup(args.backup, 'data');
  const agent = args.agent ? inspectBackup(args.agent, 'agent') : null;
  if (!data.ok || (agent && !agent.ok)) {
    if (args.json) console.log(JSON.stringify({ status: 'refused', reason: data.ok ? 'agent-backup-invalid' : 'backup-invalid', data, agent }));
    else console.error(humanPlan(args, data, agent ?? { ok: true }));
    return 2;
  }
  if (!args.yes) {
    if (args.json) console.log(JSON.stringify({ status: 'dry-run', data, agent }));
    else console.log(humanPlan(args, data, agent));
    return 2;
  }
  const report = restoreBackup({
    backupPath: path.resolve(args.backup), dbPath: path.resolve(args.db),
    agentBackupPath: args.agent ? path.resolve(args.agent) : null,
    agentDbPath: path.resolve(args.agentDb),
  });
  if (args.json) console.log(JSON.stringify(report));
  else {
    console.log(`status=${report.status}${report.reason ? ` reason=${report.reason}` : ''}`);
    if (report.preRestore?.length) console.log(`pre-restore=${report.preRestore.join(',')}`);
    for (const n of report.notes ?? []) console.log(`Note: ${n}`);
  }
  return report.status === 'completed' ? 0 : 1;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = await main();
}
