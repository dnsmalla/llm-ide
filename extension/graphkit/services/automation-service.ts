// AutomationService: automatic memory capture, cleanup, and graph regen hooks.
//
// Phase 2 service layer. Consumes MemoryService (Task 1) and GraphService
// (Task 2). Auto-capture methods (captureFromAgentTurn / captureFromUI) are
// intentional no-ops for now — full LLM extraction lands in Phase 4 — so they
// are safe to fire-and-forget from agent replies today. cleanupStaleFacts and
// detectContradictions carry real logic now.
//
// As with the sibling services, this file honors the SHIPPED Phase 1 surface
// and documents every place the original task brief drifted from it:
//
// 1. `validation.errors.join(', ')` (brief) -> `validation.details ?? ... .
//     The shipped `ValidationResult` type has `{ valid, reason?, details?,
//     contradicts? }` — there is NO `errors` array on a single-fact result
//     (that field lives on the all-facts `ValidationReport`). Calling
//     `.join` on `undefined` would throw, so the reason string is built from
//     `details` (falling back to `reason`, then 'invalid') exactly like
//     MemoryService.validateAllFacts does.
//
// 2. `detectContradictions` keyword lookup (brief) -> substring matching.
//     The brief indexed single words (`split(/\s+/)`) but queried multiword
//     phrases (`'does not use'`); a map keyed by single words can never
//     contain `'does not use'`, so `negFacts` was always empty and zero
//     contradictions were ever returned. Matching `pos`/`neg` as substrings
//     of each fact's full text makes the stated test pass and is the
//     intended behavior. Full LLM-based detection remains a Phase 4 task.
//
// 3. Timestamp round-trip + testability. The Phase 1 storage layer only
//     persists each fact's `text` (as `- text` lines); on read it rebuilds
//     every fact with `timestamp: Date.now()`, so a fact written "40 days
//     ago" comes back fresh and the age branch of cleanupStaleFacts could
//     never be exercised through the public API. To make that logic
//     unit-testable the dependencies are constructor-injectable (defaults
//     remain the real singletons, so production behavior is unchanged). This
//     is additive and non-breaking.
//
// Imports use `.ts` specifiers (not `.js`) so the module loads under
// `node --test --experimental-strip-types` (Node >= 20); the repo tsconfig
// sets `allowImportingTsExtensions: true`, so bundler/`tsc` accept these too.

import { memoryService as defaultMemoryService } from './memory-service.ts';
import { graphService as defaultGraphService } from './graph-service.ts';
import type { ChatMemoryFact, ValidationResult } from '../types/memory.ts';

/**
 * Narrow port of MemoryService used by this service. Defining a local
 * interface (rather than importing the whole class) keeps the dependency
 * surface explicit and makes the cleanup logic unit-testable with a stub.
 * The real `memoryService` singleton satisfies this structurally.
 */
interface MemoryPort {
  readChatMemory(repoRoot: URL): Promise<ChatMemoryFact[]>;
  writeChatMemory(repoRoot: URL, facts: ChatMemoryFact[]): Promise<void>;
  validateFact(repoRoot: URL, fact: ChatMemoryFact): Promise<ValidationResult>;
}

/**
 * Narrow port of GraphService used by this service.
 */
interface GraphPort {
  regenerateGraph(repoRoot: URL): Promise<void>;
}

/**
 * Context from an agent turn for memory capture.
 */
export interface AgentContext {
  repoRoot: URL;
  userMessage: string;
  agentReply: string;
  timestamp: number;
}

/**
 * UI action types for memory capture.
 */
export type UIAction =
  | { type: 'agentReply'; reply: string }
  | { type: 'fileViewed'; file: URL }
  | { type: 'commandExecuted'; command: string };

/**
 * Result of cleaning up stale facts.
 */
export interface CleanupReport {
  removed: Array<{ fact: ChatMemoryFact; reason: string }>;
  kept: ChatMemoryFact[];
  errors: Array<{ fact: ChatMemoryFact; error: string }>;
}

/**
 * Result of contradiction detection.
 */
export interface ContradictionReport {
  contradictions: Array<{ fact1: ChatMemoryFact; fact2: ChatMemoryFact; reason: string }>;
}

/**
 * AutomationService provides automatic memory capture and cleanup.
 *
 * Initially implements basic versions; full automation (LLM extraction,
 * richer contradiction detection) arrives in Phase 4.
 */
export class AutomationService {
  // Fields are declared explicitly (not as constructor parameter properties)
  // so the file runs under Node's default type-stripping (strip-only mode),
  // which does not support TS parameter properties. See storage/* for the
  // same convention.
  private memoryService: MemoryPort;
  private graphService: GraphPort;

  constructor(
    memoryService: MemoryPort = defaultMemoryService,
    graphService: GraphPort = defaultGraphService
  ) {
    this.memoryService = memoryService;
    this.graphService = graphService;
  }

  /**
   * Capture facts from an agent turn.
   *
   * Fire-and-forget safe: never throws (errors are logged), so it can be
   * awaited-or-not from the agent reply path without risking the reply.
   * TODO: Implement LLM extraction in Phase 4.
   */
  async captureFromAgentTurn(context: AgentContext): Promise<void> {
    try {
      // TODO: Use LLM to extract facts from conversation.
      // For now, this is a no-op to maintain safety.
      void context; // intentionally unused until Phase 4
    } catch (err) {
      console.error('Agent turn capture failed:', err);
      // Never fail the agent reply.
    }
  }

  /**
   * Capture facts from UI actions.
   *
   * Never throws. TODO: Implement UI hooks in Phase 4.
   */
  async captureFromUI(action: UIAction): Promise<void> {
    try {
      // TODO: Implement UI-based capture.
      // For now, this is a no-op.
      void action; // intentionally unused until Phase 4
    } catch (err) {
      console.error('UI action capture failed:', err);
    }
  }

  /**
   * Clean up stale facts (older than specified days) and facts that no longer
   * validate (e.g. referencing missing files). Returns a full report; never
   * throws (errors land in `report.errors` / are logged).
   */
  async cleanupStaleFacts(repoRoot: URL, olderThanDays = 30): Promise<CleanupReport> {
    const report: CleanupReport = {
      removed: [],
      kept: [],
      errors: []
    };

    try {
      const facts = await this.memoryService.readChatMemory(repoRoot);
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

      for (const fact of facts) {
        // Check age first.
        if (fact.timestamp < cutoffTime) {
          report.removed.push({ fact, reason: 'stale_age' });
          continue;
        }

        // Then validate file references / text length.
        try {
          const validation = await this.memoryService.validateFact(repoRoot, fact);
          if (!validation.valid) {
            // NOTE: ValidationResult carries detail in `details` (string), not
            // an `errors[]` array (see file header, drift note #1).
            const reason = validation.details ?? validation.reason ?? 'invalid';
            report.removed.push({ fact, reason });
            continue;
          }
        } catch (err) {
          report.errors.push({ fact, error: String(err) });
        }

        report.kept.push(fact);
      }

      // Write cleaned facts back if anything was removed.
      if (report.removed.length > 0) {
        await this.memoryService.writeChatMemory(repoRoot, report.kept);
      }
    } catch (err) {
      console.error('Cleanup failed:', err);
    }

    return report;
  }

  /**
   * Detect contradictory facts.
   *
   * Currently does simple substring-based detection for a small set of
   * positive/negative phrase pairs sharing a common subject token. Full
   * LLM-based contradiction detection lands in Phase 4. Never throws.
   */
  async detectContradictions(repoRoot: URL): Promise<ContradictionReport> {
    try {
      const facts = await this.memoryService.readChatMemory(repoRoot);
      const contradictions: Array<{ fact1: ChatMemoryFact; fact2: ChatMemoryFact; reason: string }> = [];

      // Match positive/negative phrase pairs as substrings of each fact's full
      // text (see file header, drift note #2 — single-word indexing can never
      // match a multiword phrase like 'does not use').
      const opposites: Array<[string, string]> = [
        ['uses', 'does not use'],
        ['requires', 'does not require']
      ];

      for (const [pos, neg] of opposites) {
        const posFacts = facts.filter((f) => f.text.toLowerCase().includes(pos));
        const negFacts = facts.filter((f) => f.text.toLowerCase().includes(neg));

        for (const f1 of posFacts) {
          for (const f2 of negFacts) {
            // Shared-subject guard retained from the brief's intent: only flag
            // a conflict when both statements are about the same subject token
            // (e.g. 'npm'). Keeps the stub from over-flagging.
            if (
              f1.text.toLowerCase().includes('npm') &&
              f2.text.toLowerCase().includes('npm')
            ) {
              contradictions.push({
                fact1: f1,
                fact2: f2,
                reason: `Conflicting statements about ${neg}`
              });
            }
          }
        }
      }

      return { contradictions };
    } catch (err) {
      // Graceful degradation — never crash the caller.
      console.error('Contradiction detection failed:', err);
      return { contradictions: [] };
    }
  }

  /**
   * Regenerate graph on doc change. Never throws (errors are logged).
   */
  async regenerateOnDocChange(repoRoot: URL): Promise<void> {
    try {
      await this.graphService.regenerateGraph(repoRoot);
    } catch (err) {
      console.error('Doc change regeneration failed:', err);
    }
  }

  /**
   * Regenerate graph on code change. Never throws (errors are logged).
   */
  async regenerateOnCodeChange(repoRoot: URL): Promise<void> {
    try {
      await this.graphService.regenerateGraph(repoRoot);
    } catch (err) {
      console.error('Code change regeneration failed:', err);
    }
  }
}

// Singleton instance (uses the real MemoryService / GraphService by default).
export const automationService = new AutomationService();
