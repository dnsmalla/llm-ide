// Directory migration: move legacy memory/graph directories into the canonical
// `.llm-ide/` structure.
//
// Migration is graceful — missing legacy paths are reported as skipped, not
// errors, so calling migrateToLLMIdeStructure on a fresh repo is a no-op.
// Each file is moved with fs.rename (atomic on a single filesystem) so a crash
// mid-migration can never lose data: a file is either at the old path or the
// new one, never deleted-and-not-yet-recreated. After moving every entry the
// now-empty legacy leaf directory is removed; if it is non-empty (e.g. a
// concurrent writer added a file) it is left in place.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Value imports use .ts extensions (not .js) because these modules run under
// Node's built-in type-stripping, which does NOT rewrite .js -> .ts for
// relative value imports the way a bundler/tsc emit would. The .js imports in
// the sibling storage files are all `import type` and erased at runtime; this
// module needs the actual functions, so it must resolve to the on-disk .ts
// path. tsconfig sets allowImportingTsExtensions + moduleResolution "bundler".
import { getMemoryDir } from './memory-storage.ts';
import { getGraphDir } from './graph-storage.ts';

export interface MigrationStep {
  from: string;
  to: string;
}

export interface MigrationResult {
  migrated: MigrationStep[];
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ step: MigrationStep; error: string }>;
}

/**
 * Best-effort message extraction for an unknown caught value. Mirrors the
 * helper in graph-storage.ts so catch blocks stay lint-clean (no `any`).
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Resolve a path to a boolean without throwing — true iff it exists.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate legacy memory/graph directories to the canonical `.llm-ide/`
 * structure. Moves `graphify-out/memory` -> `.llm-ide/memory` and
 * `system/graph` -> `.llm-ide/graph`. Missing legacy paths are skipped; per-step
 * failures are captured in `errors` and do not abort the remaining steps.
 */
export async function migrateToLLMIdeStructure(repoRoot: URL): Promise<MigrationResult> {
  // fileURLToPath decodes percent-encoding (e.g. %20 -> space) so repo roots
  // containing spaces resolve to the real filesystem path. Using
  // repoRoot.pathname directly would keep the raw %20 and silently target a
  // non-existent directory — the same bug getMemoryDir/getGraphDir guard
  // against. Decode once here so both legacy `from` and canonical `to` agree.
  const repoPath = fileURLToPath(repoRoot);

  const migrations: MigrationStep[] = [
    {
      from: path.join(repoPath, 'graphify-out', 'memory'),
      to: getMemoryDir(repoRoot)
    },
    {
      from: path.join(repoPath, 'system', 'graph'),
      to: getGraphDir(repoRoot)
    }
  ];

  const result: MigrationResult = {
    migrated: [],
    skipped: [],
    errors: []
  };

  for (const step of migrations) {
    try {
      const exists = await pathExists(step.from);

      if (!exists) {
        result.skipped.push({ path: step.from, reason: 'not_found' });
        continue;
      }

      // Ensure the canonical target directory exists before moving into it.
      await fs.mkdir(step.to, { recursive: true });

      // Move every entry (file or subdirectory) with rename, which is atomic
      // on a single filesystem — no copy+delete window where data could be
      // lost. A same-named entry at the destination is overwritten.
      const entries = await fs.readdir(step.from, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(step.from, entry.name);
        const destPath = path.join(step.to, entry.name);
        await fs.rename(srcPath, destPath);
      }

      // Best-effort: remove the now-empty legacy leaf directory. If it is not
      // empty (a concurrent writer added a file between readdir and rmdir), or
      // otherwise busy, leave it in place rather than forcing removal.
      try {
        await fs.rmdir(step.from);
      } catch {
        /* directory not empty or busy; leave it */
      }

      result.migrated.push(step);
    } catch (err) {
      result.errors.push({ step, error: errorMessage(err) });
    }
  }

  return result;
}

/**
 * Check if migration is needed — true if any legacy path exists on disk.
 */
export async function needsMigration(repoRoot: URL): Promise<boolean> {
  const repoPath = fileURLToPath(repoRoot);
  const legacyPaths = [
    path.join(repoPath, 'graphify-out', 'memory'),
    path.join(repoPath, 'system', 'graph')
  ];

  for (const legacyPath of legacyPaths) {
    if (await pathExists(legacyPath)) {
      return true;
    }
  }

  return false;
}
