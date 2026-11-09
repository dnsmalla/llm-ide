import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { config } from '../core/config.mjs';

function isoStamp() {
  return new Date().toISOString().replace(/:/g, '-');
}

function defaultBackupPath(dbPath) {
  return `${dbPath}.bak-${isoStamp()}.db`;
}

function agentOutPath(outPath) {
  const p = String(outPath);
  return p.endsWith('.db') ? `${p.slice(0, -3)}.agent.db` : `${p}.agent.db`;
}

function parseArgs(argv) {
  const args = Array.from(argv);
  let dbPath = config.dbPath;
  let outPath = null;
  let agentDbPath = null;
  let includeAgent = true;
  let force = false;
  let keep = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--db') {
      dbPath = args[i + 1];
      i += 1;
    } else if (arg === '--out') {
      outPath = args[i + 1];
      i += 1;
    } else if (arg === '--agent-db') {
      agentDbPath = args[i + 1];
      i += 1;
    } else if (arg === '--no-agent') {
      includeAgent = false;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--keep') {
      keep = Number(args[i + 1]);
      i += 1;
      if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep requires a whole number of at least 1');
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!dbPath) throw new Error('--db requires a value');
  if (args.includes('--out') && !outPath) throw new Error('--out requires a value');
  if (args.includes('--agent-db') && !agentDbPath) throw new Error('--agent-db requires a value');

  return {
    dbPath,
    outPath: outPath || defaultBackupPath(dbPath),
    // The server's companion file beside data.db. An explicit --db (a fixture,
    // a mounted copy) gets the sibling in its own directory, never the live one.
    agentDbPath: agentDbPath ?? (path.resolve(dbPath) === path.resolve(config.dbPath)
      ? config.agentDbPath
      : path.join(path.dirname(path.resolve(dbPath)), 'agent.db')),
    includeAgent,
    force,
    keep,
  };
}

/**
 * R-034 #16: keep the newest `keep` default-named backups of `dbPath` (`<db>.bak-<iso>.db` and its
 * `.agent.db`) in the DB's own directory. ISO stamps sort by name; nothing else is touched.
 */
export async function pruneSiblingBackups(dbPath, keep) {
  const dir = path.dirname(path.resolve(dbPath));
  const prefix = `${path.basename(dbPath)}.bak-`;
  const mains = (await readdir(dir))
    .filter((n) => n.startsWith(prefix) && n.endsWith('.db') && !n.endsWith('.agent.db'))
    .sort()
    .reverse();
  const deleted = [];
  for (const name of mains.slice(keep)) {
    for (const f of [name, `${name.slice(0, -3)}.agent.db`]) {
      await rm(path.join(dir, f), { force: true });
      deleted.push(f);
    }
  }
  return deleted;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * R-034 #16: optional off-host copy. `LLMIDE_BACKUP_REMOTE` is an rsync destination
 * (`user@host:/path` or a mounted path), configured by the operator; no shell is involved.
 * A failed off-host copy is reported but never loses the local backup.
 */
async function defaultOffHostCopy(files, target) {
  await new Promise((resolve, reject) => {
    const child = spawn('rsync', ['-a', '--', ...files, target], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`rsync exited ${code}`))));
  });
}

export async function runBackup({
  dbPath = config.dbPath, outPath = defaultBackupPath(dbPath), agentDbPath = null,
  includeAgent = true, force = false,
  offHostTarget = process.env.LLMIDE_BACKUP_REMOTE || null,
  offHostCopy = defaultOffHostCopy,
} = {}) {
  const resolvedDb = path.resolve(dbPath);
  const resolvedOut = path.resolve(outPath);
  // An explicit --db (a fixture, a mounted copy) gets the sibling agent.db in
  // its own directory; only the configured live DB uses config.agentDbPath.
  const resolvedAgent = agentDbPath
    ? path.resolve(agentDbPath)
    : (resolvedDb === path.resolve(config.dbPath)
      ? path.resolve(config.agentDbPath)
      : path.join(path.dirname(resolvedDb), 'agent.db'));
  const agentEnabled = includeAgent && Boolean(resolvedAgent) && existsSync(resolvedAgent);
  const resolvedAgentOut = agentEnabled ? agentOutPath(resolvedOut) : null;

  for (const out of [resolvedOut, resolvedAgentOut].filter(Boolean)) {
    if (existsSync(out) && !force) {
      const err = new Error(`Refusing to overwrite existing backup: ${out}`);
      err.code = 'BACKUP_EXISTS';
      throw err;
    }
    if (existsSync(out) && force) {
      await rm(out, { force: true });
    }
  }

  await mkdir(path.dirname(resolvedOut), { recursive: true });

  const db = new Database(resolvedDb, { fileMustExist: true });
  try {
    await db.backup(resolvedOut);
  } finally {
    db.close();
  }
  let agentBytes = null;
  let agentSha256 = null;
  if (agentEnabled) {
    const adb = new Database(resolvedAgent, { fileMustExist: true });
    try {
      await adb.backup(resolvedAgentOut);
    } finally {
      adb.close();
    }
    try { await chmod(resolvedAgentOut, 0o600); } catch { /* non-POSIX FS */ }
    agentBytes = (await stat(resolvedAgentOut)).size;
    agentSha256 = await sha256File(resolvedAgentOut);
  }

  // The backup is a verbatim copy of the DB — it contains bcrypt password
  // hashes and the AES-GCM-encrypted credential vault. Lock it down to
  // owner-only (0600) so a permissive umask can't leave it group/world
  // readable. Best-effort: on filesystems without POSIX modes (e.g. some
  // Windows/network mounts) chmod is a no-op or throws EPERM, which must
  // not fail an otherwise-successful backup.
  try {
    await chmod(resolvedOut, 0o600);
  } catch { /* non-POSIX FS — best effort */ }

  const info = await stat(resolvedOut);
  const sha256 = await sha256File(resolvedOut);
  let offHost = null;
  if (offHostTarget) {
    try {
      await offHostCopy([resolvedOut, resolvedAgentOut].filter(Boolean), offHostTarget);
      offHost = { target: offHostTarget, ok: true };
    } catch (err) {
      offHost = { target: offHostTarget, ok: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  }
  return {
    dbPath: resolvedDb,
    // Which data location the DB came from: 'system' (LLMIDE_DATA_DIR),
    // 'repo-kb' (the checkout's kb/) or 'custom' (an explicit LLMIDE_DB_PATH or --db).
    location: resolvedDb === path.resolve(config.dbPath) ? config.dataLocation : 'custom',
    outPath: resolvedOut,
    bytes: info.size,
    sha256,
    agentPath: agentEnabled ? resolvedAgentOut : null,
    agentBytes,
    agentSha256,
    offHost,
  };
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/backup.mjs [--db <path>] [--out <path>] [--agent-db <path>] [--no-agent] [--force]\n'
    + 'Defaults:\n'
    + `  --db  ${config.dbPath}\n`
    + '  --out <db>.bak-<iso-timestamp>.db\n'
    + '  --agent-db <dir of --db>/agent.db (written as <out>.agent.db when it exists)\n',
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      printHelp();
      process.exit(0);
    }
    const result = await runBackup(parsed);
    if (parsed.keep) await pruneSiblingBackups(parsed.dbPath, parsed.keep);
    process.stdout.write(
      `source=${result.dbPath} (location: ${result.location})\n`
      + `backup=${result.outPath}\nbytes=${result.bytes}\nsha256=${result.sha256}\n`
      + (result.offHost ? `offhost=${result.offHost.ok ? result.offHost.target : `FAILED ${result.offHost.error}`}\n` : ''),
    );
    // The local copy is kept, but a failed off-host copy must fail the unit so the operator sees it.
    if (result.offHost && !result.offHost.ok) process.exit(2);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
