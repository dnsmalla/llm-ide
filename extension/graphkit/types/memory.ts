/**
 * A single fact captured from agent turns or UI actions.
 * Facts are durable project knowledge that should remain
 * true across sessions.
 */
export interface ChatMemoryFact {
  /** The fact text (280 chars max) */
  text: string;

  /** Fact category for tagging */
  category: 'convention' | 'architecture' | 'tooling' | 'command' | 'preference';

  /** When this fact was captured */
  timestamp: number;

  /** Source of this fact */
  source: 'agent' | 'ui' | 'manual';

  /** Optional metadata (e.g., file paths mentioned) */
  metadata?: {
    files?: string[];
    relatedModules?: string[];
  };
}

/**
 * In-memory representation of all memory data for a repo.
 */
export interface MemoryData {
  facts: ChatMemoryFact[];
  bugs: BugReport[];
  qa: QAEntry[];
}

/**
 * Bug report with YAML frontmatter + markdown body.
 */
export interface BugReport {
  /** ISO 8601 timestamp + slug for filename */
  id: string; // "2026-07-07-auth-flow-bug"

  /** YAML frontmatter fields */
  severity: 'info' | 'minor' | 'major' | 'critical';
  prompt: string;
  response: string;
  reportedAt: string; // ISO 8601
  gitHead: string;
  appVersion: string;
  agent: string;
  status: 'open' | 'acknowledged' | 'fixed' | 'wont_fix';
  tags: string[];

  /** Markdown body (user notes on what went wrong) */
  body: string;
}

/**
 * Saved Q&A entry from repeated-command detection.
 */
export interface QAEntry {
  /** Question slug for filename */
  id: string;

  /** YAML frontmatter */
  question: string;
  answer: string;
  savedAt: string; // ISO 8601
  askCount: number;
  agent: string;

  /** Optional markdown body (additional notes) */
  body?: string;
}

/**
 * Result of validating a single fact.
 */
export interface ValidationResult {
  valid: boolean;
  reason?: 'file_not_found' | 'contradiction' | 'invalid_command' | 'syntax_error';
  details?: string;
  contradicts?: ChatMemoryFact;
}

/**
 * Report from validating all facts.
 */
export interface ValidationReport {
  valid: number;
  invalid: number;
  errors: Array<{ fact: ChatMemoryFact; reason: string }>;
}

/**
 * Categories for filtering/tagging facts.
 */
export type FactCategory = ChatMemoryFact['category'];

/**
 * Fact source.
 */
export type FactSource = ChatMemoryFact['source'];
