// MemoryService: high-level memory operations with validation.
//
// This is the Phase 2 service layer. It uses the Phase 1 storage functions
// (storage/memory-storage.ts) internally for all file I/O while presenting a
// stable, validated API to callers. Reads degrade gracefully (never throw);
// writes surface failures so callers can react.
//
// NOTE on type parity: the service returns the Phase 1 `ValidationResult` and
// `ValidationReport` shapes verbatim (reason/details and valid/invalid/errors
// respectively). An earlier draft of this service planned richer
// `{ valid, errors: string[] }` / `{ total, valid, invalid, details }` shapes,
// but those do not match the shipped Phase 1 types; the implementation below
// honors the real types. Multi-message validation detail is carried in
// `ValidationResult.details` (joined by '; ').

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Imports use `.ts` specifiers (not `.js`) so the module loads under
// `node --test --experimental-strip-types` (Node >= 20). The repo tsconfig sets
// `allowImportingTsExtensions: true`, so the bundler / `tsc` accept these too.
import { writeMemoryFile, readChatMemory, writeChatMemory } from '../storage/memory-storage.ts';
import type {
  MemoryData,
  ChatMemoryFact,
  ValidationResult,
  ValidationReport
} from '../types/memory.ts';

/**
 * MemoryService provides high-level memory operations with validation.
 *
 * Initially built on top of the Phase 1 storage layer; repo.md/chat-memory.md
 * rendering still flows through the storage layer (the legacy memory.mjs
 * `renderRepoMemory` symbol referenced in some drafts does not exist in the
 * shipped module, so no delegation import is taken here).
 */
export class MemoryService {
  /**
   * Read all memory data for a repo.
   *
   * Reads degrade gracefully: if the memory directory or files are absent the
   * service returns an empty `MemoryData` rather than throwing.
   *
   * (repo.md is user-curated content with no field on `MemoryData`; bug/QA
   * reading is deferred to a later phase, so those arrays are returned empty.)
   */
  async readMemory(repoRoot: URL): Promise<MemoryData> {
    try {
      const chatMemory = await readChatMemory(repoRoot);
      return {
        facts: chatMemory,
        bugs: [], // TODO: implement bug reading in a later phase
        qa: []    // TODO: implement QA reading in a later phase
      };
    } catch (err) {
      // Graceful degradation — never crash the agent.
      console.error('Memory read failed:', err);
      return { facts: [], bugs: [], qa: [] };
    }
  }

  /**
   * Read chat memory facts only.
   */
  async readChatMemory(repoRoot: URL): Promise<ChatMemoryFact[]> {
    try {
      return await readChatMemory(repoRoot);
    } catch (err) {
      console.error('Chat memory read failed:', err);
      return [];
    }
  }

  /**
   * Write chat memory facts.
   *
   * Unlike reads, a failed write is re-thrown after logging so callers can
   * surface the failure (silently dropping a write would corrupt memory state).
   */
  async writeChatMemory(repoRoot: URL, facts: ChatMemoryFact[]): Promise<void> {
    try {
      await writeChatMemory(repoRoot, facts);
    } catch (err) {
      console.error('Chat memory write failed:', err);
      throw err;
    }
  }

  /**
   * Validate a single fact.
   *
   * Checks text length and that any referenced files exist beneath the repo
   * root. Problems are accumulated and returned in `details` (joined by '; ');
   * `reason` is set to the most specific applicable code (currently
   * 'file_not_found' when a referenced file is missing).
   */
  async validateFact(repoRoot: URL, fact: ChatMemoryFact): Promise<ValidationResult> {
    const problems: string[] = [];
    let reason: ValidationResult['reason'];

    // Check text length.
    if (fact.text.length > 280) {
      problems.push('Fact text exceeds 280 characters');
    }

    // Check file references exist beneath the repo root.
    const fileRefs = fact.metadata?.files;
    if (fileRefs && fileRefs.length > 0) {
      const repoPath = fileURLToPath(repoRoot);
      for (const fileRef of fileRefs) {
        const fullPath = path.join(repoPath, fileRef);
        try {
          await fs.access(fullPath);
        } catch {
          problems.push(`Referenced file does not exist: ${fileRef}`);
          reason = 'file_not_found';
        }
      }
    }

    return {
      valid: problems.length === 0,
      reason: problems.length === 0 ? undefined : reason,
      details: problems.length === 0 ? undefined : problems.join('; ')
    };
  }

  /**
   * Validate all facts currently stored in chat memory.
   */
  async validateAllFacts(repoRoot: URL): Promise<ValidationReport> {
    const facts = await this.readChatMemory(repoRoot);
    const results = await Promise.all(
      facts.map((fact) => this.validateFact(repoRoot, fact))
    );

    const errors: ValidationReport['errors'] = [];
    results.forEach((result, i) => {
      if (!result.valid) {
        errors.push({
          fact: facts[i],
          reason: result.details ?? result.reason ?? 'invalid'
        });
      }
    });

    return {
      valid: results.filter((r) => r.valid).length,
      invalid: results.filter((r) => !r.valid).length,
      errors
    };
  }

  /**
   * Update repo.md user-curated facts.
   *
   * Failures are re-thrown after logging (see writeChatMemory).
   */
  async updateRepoMD(repoRoot: URL, content: string): Promise<void> {
    try {
      await writeMemoryFile(repoRoot, 'repo.md', content);
    } catch (err) {
      console.error('Repo.md update failed:', err);
      throw err;
    }
  }
}

// Singleton instance.
export const memoryService = new MemoryService();
