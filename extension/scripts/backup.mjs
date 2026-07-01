import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { config } from '../core/config.mjs';

function isoStamp() {
  return new Date().toISOString().replace(/:/g, '-');
}

export function defaultBackupPath(dbPath) {
  return `${dbPath}.bak-${isoStamp()}.db`;
}

export function parseArgs(argv) {
  const args = Array.from(argv);
  let dbPath = config.dbPath;
  let outPath = null;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--db') {
      dbPath = args[i + 1];
      i += 1;
    } else if (arg === '--out') {
      outPath = args[i + 1];
      i += 1;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!dbPath) throw new Error('--db requires a value');
  if (args.includes('--out') && !outPath) throw new Error('--out requires a value');

  return {
    dbPath,
    outPath: outPath || defaultBackupPath(dbPath),
    force,
  };
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function runBackup({ dbPath = config.dbPath, outPath = defaultBackupPath(dbPath), force = false } = {}) {
  const resolvedDb = path.resolve(dbPath);
  const resolvedOut = path.resolve(outPath);

  if (existsSync(resolvedOut) && !force) {
    const err = new Error(`Refusing to overwrite existing backup: ${resolvedOut}`);
    err.code = 'BACKUP_EXISTS';
    throw err;
  }
  if (existsSync(resolvedOut) && force) {
    await rm(resolvedOut, { force: true });
  }

  await mkdir(path.dirname(resolvedOut), { recursive: true });

  const db = new Database(resolvedDb, { fileMustExist: true });
  try {
    await db.backup(resolvedOut);
  } finally {
    db.close();
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
  return {
    dbPath: resolvedDb,
    outPath: resolvedOut,
    bytes: info.size,
    sha256,
  };
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/backup.mjs [--db <path>] [--out <path>] [--force]\n'
    + 'Defaults:\n'
    + `  --db  ${config.dbPath}\n`
    + '  --out <db>.bak-<iso-timestamp>.db\n',
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
    process.stdout.write(
      `backup=${result.outPath}\nbytes=${result.bytes}\nsha256=${result.sha256}\n`,
    );
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
