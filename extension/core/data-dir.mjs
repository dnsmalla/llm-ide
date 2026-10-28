// Where the server's per-install (global, multi-tenant) data lives.
//
// Two layouts exist:
//   - repo kb (default, dev and tests): <repo>/kb/{data.db, agent.db, backups/,
//     agent-sdk/} and extension/kb/server.log.
//   - a data dir (LLMIDE_DATA_DIR, set by the Mac app to
//     ~/Library/Application Support/llm-ide/system): the same files under that
//     directory, so a packaged app works and the data is not tied to a checkout.
//
// Precedence for every location (first match wins):
//   1. the individual env var (LLMIDE_DB_PATH, LLMIDE_AGENT_DB_PATH,
//      LLMIDE_BACKUP_DIR, LLMIDE_LOG_FILE)
//   2. test isolation: under the Node test runner (NODE_TEST_CONTEXT) the main
//      DB is a per-process temp file and agent.db sits beside it; LLMIDE_DATA_DIR
//      is ignored, so a test can never touch a real data directory
//   3. LLMIDE_DATA_DIR (the boot migration may force the repo kb as a fallback)
//   4. the repo kb default
//
// Pure: no module-level side effects, so the precedence is unit-testable. The
// boot migration (kb/data-dir-migration.mjs) runs before config is read and
// records its decision here via setDataDirOverride().

import path from 'path';

// undefined = no decision recorded, read LLMIDE_DATA_DIR from the env.
// null      = the boot migration fell back to the repo kb for this run.
// string    = the migration settled on this directory.
let dataDirOverride;
let migrationReport = null;

export function setDataDirOverride(dir) { dataDirOverride = dir; }
export function getDataDirOverride() { return dataDirOverride; }
export function clearDataDirOverride() { dataDirOverride = undefined; }
export function setDataMigrationReport(report) { migrationReport = report ?? null; }
export function getDataMigrationReport() { return migrationReport; }

/**
 * Resolve every data location from the environment. Pure.
 *
 * @param {object} opts
 * @param {Record<string,string|undefined>} opts.env process environment
 * @param {string} opts.root repo root (the directory that holds `kb/`)
 * @param {string} opts.legacyLogFile default server.log path when no data dir
 * @param {string|null} opts.testDbPath per-process temp DB (test runs only)
 * @param {boolean} opts.isTest true under the Node test runner
 * @param {string|null|undefined} [opts.dataDirOverride] migration decision;
 *        undefined reads LLMIDE_DATA_DIR from env
 */
export function resolveDataLayout({
  env, root, legacyLogFile, testDbPath = null, isTest = false, dataDirOverride: override,
}) {
  const str = (name) => {
    const v = env[name];
    return (typeof v === 'string' && v.trim().length > 0) ? v : null;
  };
  let rawDataDir;
  if (override !== undefined) rawDataDir = override;
  else rawDataDir = str('LLMIDE_DATA_DIR');
  // Test runs never use a real data directory.
  const dataDir = isTest ? null : (rawDataDir ? path.resolve(rawDataDir) : null);
  const repoKb = path.join(root, 'kb');

  // Main DB.
  let dbPath;
  let dbSource;
  if (str('LLMIDE_DB_PATH')) { dbPath = str('LLMIDE_DB_PATH'); dbSource = 'env'; }
  else if (testDbPath) { dbPath = testDbPath; dbSource = 'test'; }
  else if (dataDir) { dbPath = path.join(dataDir, 'data.db'); dbSource = 'data-dir'; }
  else { dbPath = path.join(repoKb, 'data.db'); dbSource = 'default'; }

  // Where agent.db, backups/ and agent-sdk/ live. An explicit LLMIDE_DB_PATH
  // puts them beside that DB, so one custom DB never splits its companions
  // between the custom path and the data dir. Otherwise: the data dir, or the
  // repo kb beside the default DB.
  const base = dbSource === 'env'
    ? path.dirname(dbPath)
    : (dataDir ?? path.dirname(dbPath));

  // agent.db (agent history store). Under test: `<main test DB>.agent.db`.
  let agentDbPath;
  if (str('LLMIDE_AGENT_DB_PATH')) agentDbPath = str('LLMIDE_AGENT_DB_PATH');
  else if (isTest) agentDbPath = `${dbPath}.agent.db`;
  else agentDbPath = path.join(base, 'agent.db');

  const backupDir = str('LLMIDE_BACKUP_DIR') ?? path.join(base, 'backups');
  const agentSdkDir = path.join(base, 'agent-sdk');
  // LLMIDE_LOG_FILE set (even empty) is an explicit choice: '' or 'none' disables the file sink.
  let logFile;
  if (env.LLMIDE_LOG_FILE !== undefined) {
    const t = String(env.LLMIDE_LOG_FILE).trim();
    logFile = (t === '' || t.toLowerCase() === 'none') ? null : t;
  } else {
    logFile = dataDir ? path.join(dataDir, 'server.log') : legacyLogFile;
  }

  return {
    // The system data dir (dev secrets and logs follow it), or null.
    dataDir,
    // 'custom': an explicit LLMIDE_DB_PATH; 'system': the data dir; 'repo-kb': the checkout.
    location: dbSource === 'env' ? 'custom' : (dataDir ? 'system' : 'repo-kb'),
    dbPath,
    dbSource,
    agentDbPath,
    backupDir,
    agentSdkDir,
    logFile,
  };
}
