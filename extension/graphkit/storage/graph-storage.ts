// Graph storage layer: typed file I/O for the `.llm-ide/graph/` directory.
//
// All writes are atomic (temp-file + rename in the same directory, matching
// graphkit/storage/memory-storage.ts and memory-writer.mjs). All failures
// surface as GraphStorageError with a specific code so callers (migration,
// service layer) can branch on cause. A missing graph.json is not an error —
// readGraphFile returns an empty graph for graceful degradation.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphData } from '../types/graph.js';

/**
 * Narrow an unknown caught value to a NodeJS errno-style `.code` string.
 * Keeps catch blocks lint-clean (no `any`) while still branching on err.code.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Best-effort message extraction for an unknown caught value.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Typed error for graph storage operations.
 *
 * NOTE: fields are declared explicitly (not as constructor parameter
 * properties) so the file runs under Node's default type-stripping
 * (strip-only mode), which does not support TS parameter properties.
 */
export class GraphStorageError extends Error {
  public readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED';
  public readonly path?: string;

  constructor(
    code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED',
    message: string,
    path?: string
  ) {
    super(message);
    this.name = 'GraphStorageError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Get the canonical graph directory for a repo.
 */
export function getGraphDir(repoRoot: URL): string {
  // fileURLToPath decodes percent-encoding (e.g. %20 -> space) so that repo
  // roots containing spaces (or other chars encoded in a file: URL) resolve to
  // the real filesystem path. Using repoRoot.pathname directly would keep the
  // raw %20 and silently point at a non-existent directory.
  return path.join(fileURLToPath(repoRoot), '.llm-ide', 'graph');
}

/**
 * Read graph.json. Returns an empty graph when the file is absent so callers
 * can treat a fresh repo uniformly without a separate existence check.
 */
export async function readGraphFile(repoRoot: URL): Promise<GraphData> {
  const graphDir = getGraphDir(repoRoot);
  const filePath = path.join(graphDir, 'graph.json');

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as GraphData;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') {
      return { nodes: [], edges: [] }; // Empty graph if not found
    }
    if (code === 'EACCES') {
      throw new GraphStorageError('PERMISSION_DENIED', 'Cannot read graph file', filePath);
    }
    if (err instanceof SyntaxError) {
      throw new GraphStorageError(
        'CORRUPTED',
        `Invalid JSON in graph file: ${err.message}`,
        filePath
      );
    }
    throw new GraphStorageError('CORRUPTED', `Failed to read graph: ${errorMessage(err)}`, filePath);
  }
}

/**
 * Write graph.json atomically (temp file + rename).
 */
export async function writeGraphFile(repoRoot: URL, graph: GraphData): Promise<void> {
  const graphDir = getGraphDir(repoRoot);
  await fs.mkdir(graphDir, { recursive: true });

  const filePath = path.join(graphDir, 'graph.json');
  const tempPath = `${filePath}.${process.pid}.tmp`;

  try {
    const content = JSON.stringify(graph, null, 2);
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Clean up temp file if write/rename failed.
    try {
      await fs.unlink(tempPath);
    } catch {
      /* already gone */
    }

    if (errorCode(err) === 'EACCES') {
      throw new GraphStorageError('PERMISSION_DENIED', 'Cannot write graph file', filePath);
    }
    throw new GraphStorageError('CORRUPTED', `Failed to write graph: ${errorMessage(err)}`, filePath);
  }
}

/**
 * Read doc fingerprint for change detection. Returns null when absent so
 * callers can compare against the current fingerprint to decide whether a
 * re-index is needed.
 */
export async function readDocFingerprint(repoRoot: URL): Promise<string | null> {
  const graphDir = getGraphDir(repoRoot);
  const filePath = path.join(graphDir, 'doc-fingerprint.txt');

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Write doc fingerprint.
 */
export async function writeDocFingerprint(
  repoRoot: URL,
  fingerprint: string
): Promise<void> {
  const graphDir = getGraphDir(repoRoot);
  await fs.mkdir(graphDir, { recursive: true });

  const filePath = path.join(graphDir, 'doc-fingerprint.txt');
  await fs.writeFile(filePath, fingerprint, 'utf-8');
}
