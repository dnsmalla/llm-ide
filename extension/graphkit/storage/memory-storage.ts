// Memory storage layer: typed file I/O for the `.llm-ide/memory/` directory.
//
// All writes are atomic (temp-file + rename in the same directory, matching
// graphkit/memory-writer.mjs). All failures surface as MemoryStorageError with
// a specific code so callers (migration, service layer) can branch on cause.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMemoryFact } from '../types/memory.js';

/**
 * Typed error for memory storage operations.
 *
 * NOTE: fields are declared explicitly (not as constructor parameter
 * properties) so the file runs under Node's default type-stripping
 * (strip-only mode), which does not support TS parameter properties.
 */
export class MemoryStorageError extends Error {
  public readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED' | 'MIGRATION_FAILED';
  public readonly path?: string;

  constructor(
    code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED' | 'MIGRATION_FAILED',
    message: string,
    path?: string
  ) {
    super(message);
    this.name = 'MemoryStorageError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Get the canonical memory directory for a repo.
 */
export function getMemoryDir(repoRoot: URL): string {
  // fileURLToPath decodes percent-encoding (e.g. %20 -> space) so that repo
  // roots containing spaces (or other chars encoded in a file: URL) resolve to
  // the real filesystem path. Using repoRoot.pathname directly would keep the
  // raw %20 and silently point at a non-existent directory.
  return path.join(fileURLToPath(repoRoot), '.llm-ide', 'memory');
}

/**
 * Read a memory file.
 */
export async function readMemoryFile(
  repoRoot: URL,
  filename: string
): Promise<string> {
  const memDir = getMemoryDir(repoRoot);
  const filePath = path.join(memDir, filename);

  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new MemoryStorageError('NOT_FOUND', `Memory file not found: ${filename}`, filePath);
    }
    if (err.code === 'EACCES') {
      throw new MemoryStorageError('PERMISSION_DENIED', `Cannot read memory file: ${filename}`, filePath);
    }
    throw new MemoryStorageError('CORRUPTED', `Failed to read memory file: ${err.message}`, filePath);
  }
}

/**
 * Write a memory file atomically (temp file + rename).
 */
export async function writeMemoryFile(
  repoRoot: URL,
  filename: string,
  content: string
): Promise<void> {
  const memDir = getMemoryDir(repoRoot);
  await fs.mkdir(memDir, { recursive: true });

  const filePath = path.join(memDir, filename);
  const tempPath = `${filePath}.${process.pid}.tmp`;

  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err: any) {
    // Clean up temp file if write failed
    try {
      await fs.unlink(tempPath);
    } catch {
      /* already gone */
    }

    if (err.code === 'EACCES') {
      throw new MemoryStorageError('PERMISSION_DENIED', `Cannot write memory file: ${filename}`, filePath);
    }
    throw new MemoryStorageError('CORRUPTED', `Failed to write memory file: ${err.message}`, filePath);
  }
}

/**
 * Read repo.md file.
 */
export async function readRepoMD(repoRoot: URL): Promise<string> {
  try {
    return await readMemoryFile(repoRoot, 'repo.md');
  } catch (err) {
    if (err instanceof MemoryStorageError && err.code === 'NOT_FOUND') {
      return ''; // Empty if not found
    }
    throw err;
  }
}

/**
 * Parse chat-memory.md into facts.
 */
export async function readChatMemory(repoRoot: URL): Promise<ChatMemoryFact[]> {
  try {
    const content = await readMemoryFile(repoRoot, 'chat-memory.md');
    // Simple line-by-line parser for MVP
    return content
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => ({
        text: line.slice(2),
        category: 'convention' as const,
        timestamp: Date.now(),
        source: 'agent' as const
      }));
  } catch (err) {
    if (err instanceof MemoryStorageError && err.code === 'NOT_FOUND') {
      return [];
    }
    throw err;
  }
}

/**
 * Write facts to chat-memory.md.
 */
export async function writeChatMemory(
  repoRoot: URL,
  facts: ChatMemoryFact[]
): Promise<void> {
  const header = `# Chat memory
_Auto-captured by the Code Assistant from prior chats about this project._
_Recalled automatically next session. View or clear these in the app._

`;
  const content = header + facts.map((f) => `- ${f.text}`).join('\n') + '\n';
  await writeMemoryFile(repoRoot, 'chat-memory.md', content);
}
