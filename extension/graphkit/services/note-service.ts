// Unified note service — manages generated notes from raw data sources.
//
// Architecture:
// - Raw data stays in source folders (meetings/, EmailInbox/, Documents/)
// - Generated notes go to unified notes/ folder (notes/meetings/, notes/emails/, notes/documents/)
// - Each generated note tracks its source file
//
// This service provides a unified interface for:
// - Saving generated notes
// - Querying notes by type/date
// - Building and maintaining note index
// - Tracking which raw file generated which note

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Types
// ============================================================================

export type NoteType = 'meeting' | 'email' | 'document';

export interface NoteMetadata {
  id: string;                    // Unique note ID
  type: NoteType;                // meeting, email, or document
  source: string;                // Source system (email, google-meet, box, etc.)
  title: string;                 // Note title
  date: string;                  // ISO date string
  path: string;                  // Relative path from project root
  rawFile?: string;              // Path to raw source file
  sourceHash?: string;           // Hash of raw source file (deduplication)
  generatedAt: string;           // When note was generated
  tags: string[];                // Tags for filtering
  participants?: string[];       // For meetings
  fileSize: number;              // File size in bytes
}

export interface NoteFilter {
  type?: NoteType;
  source?: string;
  startDate?: string;
  endDate?: string;
  tags?: string[];
  limit?: number;
}

export interface NoteIndex {
  version: number;
  updated: string;
  notes: NoteMetadata[];
}

// ============================================================================
// Note Service
// ============================================================================

export class NoteService {
  private repoRoot: URL;

  constructor(repoRoot: URL) {
    this.repoRoot = repoRoot;
  }

  // ============================================================================
  // Paths
  // ============================================================================

  /** Root directory for all generated notes: <repoRoot>/notes/ */
  get notesRoot(): URL {
    return new URL('notes/', this.repoRoot);
  }

  /** Directory for generated meeting notes: notesRoot/meetings/ */
  get meetingsDir(): URL {
    return new URL('meetings/', this.notesRoot);
  }

  /** Directory for generated email notes: notesRoot/emails/ */
  get emailsDir(): URL {
    return new URL('emails/', this.notesRoot);
  }

  /** Directory for generated document notes: notesRoot/documents/ */
  get documentsDir(): URL {
    return new URL('documents/', this.notesRoot);
  }

  /** Path to unified note index: notesRoot/index.json */
  get indexPath(): URL {
    return new URL('index.json', this.notesRoot);
  }

  /** Get the appropriate subdirectory for a note type */
  getDirForType(type: NoteType): URL {
    switch (type) {
      case 'meeting': return this.meetingsDir;
      case 'email': return this.emailsDir;
      case 'document': return this.documentsDir;
    }
  }

  // ============================================================================
  // Month folder helper (consistent with existing pattern)
  // ============================================================================

  /** Get month folder path (YYYY/MM/) for a given date */
  monthFolder(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}/${month}/`;
  }

  /** Get full month directory URL for a note type and date */
  getMonthDir(type: NoteType, date: Date): URL {
    const typeDir = this.getDirForType(type);
    const monthPath = this.monthFolder(date);
    return new URL(monthPath, typeDir);
  }

  // ============================================================================
  // Save operations
  // ============================================================================

  /**
   * Save a generated note to the appropriate location.
   *
   * @param type - Note type (meeting, email, document)
   * @param filename - Filename (without path)
   * @param content - Note content
   * @param metadata - Note metadata
   * @returns The saved note metadata with path
   */
  async saveNote(
    type: NoteType,
    filename: string,
    content: string | Buffer,
    metadata: Omit<NoteMetadata, 'id' | 'path' | 'fileSize' | 'generatedAt'>
  ): Promise<NoteMetadata> {
    const date = new Date(metadata.date);
    const dir = this.getMonthDir(type, date);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write file atomically
    const filePath = new URL(filename, dir);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
    await fs.writeFile(filePath, buffer, { flag: 'wx' }); // Fail if exists

    // Generate metadata
    const notePath = path.relative(
      fileURLToPath(this.repoRoot),
      fileURLToPath(filePath)
    );

    const noteMetadata: NoteMetadata = {
      id: this.generateId(type, filename, metadata.date),
      type,
      path: notePath,
      fileSize: buffer.length,
      generatedAt: new Date().toISOString(),
      ...metadata,
    };

    // Update index
    await this.addToIndex(noteMetadata);

    return noteMetadata;
  }

  /**
   * Delete a note by ID.
   * Removes the file and updates the index.
   */
  async deleteNote(id: string): Promise<void> {
    const index = await this.loadIndex();
    const note = index.notes.find(n => n.id === id);
    if (!note) {
      throw new Error(`Note not found: ${id}`);
    }

    // Delete file
    const filePath = new URL(note.path, this.repoRoot);
    await fs.unlink(filePath);

    // Remove from index
    index.notes = index.notes.filter(n => n.id !== id);
    await this.saveIndex(index);
  }

  // ============================================================================
  // Query operations
  // ============================================================================

  /**
   * Query notes with optional filtering.
   */
  async queryNotes(filter: NoteFilter = {}): Promise<NoteMetadata[]> {
    const index = await this.loadIndex();
    let notes = index.notes;

    // Filter by type
    if (filter.type) {
      notes = notes.filter(n => n.type === filter.type);
    }

    // Filter by source
    if (filter.source) {
      notes = notes.filter(n => n.source === filter.source);
    }

    // Filter by date range
    if (filter.startDate) {
      notes = notes.filter(n => n.date >= filter.startDate!);
    }
    if (filter.endDate) {
      notes = notes.filter(n => n.date <= filter.endDate!);
    }

    // Filter by tags (any match)
    if (filter.tags && filter.tags.length > 0) {
      notes = notes.filter(n =>
        filter.tags!.some(tag => n.tags.includes(tag))
      );
    }

    // Sort by date descending
    notes.sort((a, b) => b.date.localeCompare(a.date));

    // Apply limit
    if (filter.limit) {
      notes = notes.slice(0, filter.limit);
    }

    return notes;
  }

  /**
   * Get a single note by ID.
   */
  async getNote(id: string): Promise<{ metadata: NoteMetadata; content: Buffer } | null> {
    const metadata = (await this.queryNotes()).find(n => n.id === id);
    if (!metadata) {
      return null;
    }

    const filePath = new URL(metadata.path, this.repoRoot);
    const content = await fs.readFile(filePath);

    return { metadata, content };
  }

  // ============================================================================
  // Index operations
  // ============================================================================

  /**
   * Load the unified note index.
   */
  async loadIndex(): Promise<NoteIndex> {
    try {
      const data = await fs.readFile(this.indexPath, 'utf-8');
      return JSON.parse(data) as NoteIndex;
    } catch (error) {
      // Index doesn't exist yet, return empty
      return {
        version: 1,
        updated: new Date().toISOString(),
        notes: [],
      };
    }
  }

  /**
   * Save the unified note index.
   */
  private async saveIndex(index: NoteIndex): Promise<void> {
    // Ensure notes directory exists
    await fs.mkdir(this.notesRoot, { recursive: true });

    index.updated = new Date().toISOString();
    const data = JSON.stringify(index, null, 2);
    await fs.writeFile(this.indexPath, data, 'utf-8');
  }

  /**
   * Add a note to the index.
   */
  private async addToIndex(metadata: NoteMetadata): Promise<void> {
    const index = await this.loadIndex();

    // Remove existing note with same ID (if any)
    index.notes = index.notes.filter(n => n.id !== metadata.id);

    // Add new note
    index.notes.push(metadata);

    await this.saveIndex(index);
  }

  /**
   * Rebuild the entire index by scanning the notes directory.
   */
  async rebuildIndex(): Promise<NoteIndex> {
    const notes: NoteMetadata[] = [];

    // Scan all note types
    for (const type of ['meeting', 'email', 'document'] as NoteType[]) {
      const typeDir = this.getDirForType(type);
      const typeNotes = await this.scanTypeDirectory(type, typeDir);
      notes.push(...typeNotes);
    }

    const index: NoteIndex = {
      version: 1,
      updated: new Date().toISOString(),
      notes,
    };

    await this.saveIndex(index);
    return index;
  }

  /**
   * Scan a specific type directory for notes.
   */
  private async scanTypeDirectory(type: NoteType, dir: URL): Promise<NoteMetadata[]> {
    const notes: NoteMetadata[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const filePath = new URL(entry.name, dir);
        const relativePath = path.relative(
          fileURLToPath(this.notesRoot),
          fileURLToPath(filePath)
        );

        // Skip index.json
        if (entry.name === 'index.json') continue;

        // Try to read metadata from file (for .md files with frontmatter)
        // For now, create basic metadata from file stats
        const stats = await fs.stat(filePath);
        const metadata: NoteMetadata = {
          id: this.generateIdFromPath(type, relativePath),
          type,
          source: 'unknown',
          title: entry.name,
          date: stats.mtime.toISOString(),
          path: relativePath,
          fileSize: stats.size,
          generatedAt: stats.mtime.toISOString(),
          tags: [],
        };

        notes.push(metadata);
      }
    } catch (error) {
      // Directory doesn't exist or can't be read
      console.warn(`Cannot scan directory ${dir}:`, error);
    }

    return notes;
  }

  // ============================================================================
  // ID generation
  // ============================================================================

  /**
   * Generate a unique note ID.
   */
  private generateId(type: NoteType, filename: string, date: string): string {
    const slug = filename.replace(/\.[^.]+$/, ''); // Remove extension
    const dateStr = date.replace(/[^0-9T]/g, '').slice(0, 15); // YYYY-MM-DDTHHMMSS
    return `${type}-${dateStr}-${slug.slice(0, 20)}`;
  }

  /**
   * Generate ID from file path (for index rebuilding).
   */
  private generateIdFromPath(type: NoteType, relativePath: string): string {
    const filename = path.basename(relativePath);
    const stats = fs.statSync(new URL(relativePath, this.notesRoot));
    const date = stats.mtime.toISOString();
    return this.generateId(type, filename, date);
  }

  // ============================================================================
  // Migration from scattered storage
  // ============================================================================

  /**
   * Migrate notes from scattered locations to unified structure.
   * - notes/ → notes/meetings/
   * - Email/ → notes/emails/
   * - Database documents → notes/documents/
   */
  async migrateFromLegacy(): Promise<{ moved: number; errors: string[] }> {
    const errors: string[] = [];
    let moved = 0;

    // TODO: Implement migration logic
    // 1. Scan legacy notes/ directory
    // 2. Scan legacy Email/ directory
    // 3. Move files to new structure
    // 4. Update index

    return { moved, errors };
  }
}
