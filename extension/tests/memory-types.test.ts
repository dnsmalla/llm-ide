// Test memory type definitions
// This file validates that the types are properly defined and can be used

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import the types via the barrel - this actually loads the barrel and
// catches broken re-exports (e.g. referencing not-yet-created modules)
import {
  ChatMemoryFact,
  MemoryData,
  BugReport,
  QAEntry,
  ValidationResult,
  ValidationReport,
  FactCategory,
  FactSource
} from '../graphkit/index.js';

test('memory types - ChatMemoryFact structure', () => {
  // Create a sample fact to verify type structure
  const fact: ChatMemoryFact = {
    text: 'Use spaces for indentation',
    category: 'convention',
    timestamp: Date.now(),
    source: 'agent',
    metadata: {
      files: ['src/app.ts'],
      relatedModules: ['formatter']
    }
  };

  assert.strictEqual(typeof fact.text, 'string');
  assert.strictEqual(fact.category, 'convention');
  assert.strictEqual(typeof fact.timestamp, 'number');
  assert.strictEqual(fact.source, 'agent');
  assert(fact.metadata !== undefined);
  assert(Array.isArray(fact.metadata.files));
});

test('memory types - MemoryData structure', () => {
  const memoryData: MemoryData = {
    facts: [],
    bugs: [],
    qa: []
  };

  assert(Array.isArray(memoryData.facts));
  assert(Array.isArray(memoryData.bugs));
  assert(Array.isArray(memoryData.qa));
});

test('memory types - BugReport structure', () => {
  const bug: BugReport = {
    id: '2026-07-07-auth-flow-bug',
    severity: 'major',
    prompt: 'User cannot login',
    response: 'Authentication fails with 500 error',
    reportedAt: '2026-07-07T12:00:00Z',
    gitHead: 'abc123',
    appVersion: '1.0.0',
    agent: 'claude',
    status: 'open',
    tags: ['auth', 'critical'],
    body: '# Bug Report\n\nLogin fails when...'
  };

  assert.strictEqual(typeof bug.id, 'string');
  assert.strictEqual(bug.severity, 'major');
  assert.strictEqual(typeof bug.reportedAt, 'string');
  assert.strictEqual(bug.status, 'open');
  assert(Array.isArray(bug.tags));
});

test('memory types - QAEntry structure', () => {
  const qa: QAEntry = {
    id: 'how-to-run-tests',
    question: 'How do I run tests?',
    answer: 'Run `npm test` to execute all tests',
    savedAt: '2026-07-07T12:00:00Z',
    askCount: 5,
    agent: 'claude',
    body: '# Additional Notes\n\nTests run in Node.js...'
  };

  assert.strictEqual(typeof qa.id, 'string');
  assert.strictEqual(typeof qa.question, 'string');
  assert.strictEqual(typeof qa.askCount, 'number');
  assert.strictEqual(qa.agent, 'claude');
});

test('memory types - ValidationResult structure', () => {
  const validResult: ValidationResult = {
    valid: true
  };

  const invalidResult: ValidationResult = {
    valid: false,
    reason: 'file_not_found',
    details: 'The file src/app.ts does not exist'
  };

  assert.strictEqual(validResult.valid, true);
  assert.strictEqual(invalidResult.valid, false);
  assert.strictEqual(invalidResult.reason, 'file_not_found');
});

test('memory types - ValidationReport structure', () => {
  const report: ValidationReport = {
    valid: 10,
    invalid: 2,
    errors: [
      {
        fact: {
          text: 'Invalid fact',
          category: 'convention',
          timestamp: Date.now(),
          source: 'agent'
        },
        reason: 'file_not_found'
      }
    ]
  };

  assert.strictEqual(report.valid, 10);
  assert.strictEqual(report.invalid, 2);
  assert(Array.isArray(report.errors));
  assert.strictEqual(report.errors[0].reason, 'file_not_found');
});

test('memory types - FactCategory type alias', () => {
  const category1: FactCategory = 'convention';
  const category2: FactCategory = 'architecture';
  const category3: FactCategory = 'tooling';
  const category4: FactCategory = 'command';
  const category5: FactCategory = 'preference';

  assert.strictEqual(category1, 'convention');
  assert.strictEqual(category2, 'architecture');
});

test('memory types - FactSource type alias', () => {
  const source1: FactSource = 'agent';
  const source2: FactSource = 'ui';
  const source3: FactSource = 'manual';

  assert.strictEqual(source1, 'agent');
  assert.strictEqual(source2, 'ui');
});

test('memory types - ChatMemoryFact with all categories', () => {
  const categories: FactCategory[] = [
    'convention',
    'architecture',
    'tooling',
    'command',
    'preference'
  ];

  categories.forEach((category) => {
    const fact: ChatMemoryFact = {
      text: `Test fact for ${category}`,
      category,
      timestamp: Date.now(),
      source: 'agent'
    };
    assert.strictEqual(fact.category, category);
  });
});

test('memory types - ChatMemoryFact with all sources', () => {
  const sources: FactSource[] = ['agent', 'ui', 'manual'];

  sources.forEach((source) => {
    const fact: ChatMemoryFact = {
      text: `Test fact from ${source}`,
      category: 'convention',
      timestamp: Date.now(),
      source
    };
    assert.strictEqual(fact.source, source);
  });
});

test('memory types - BugReport with all severities', () => {
  const severities: BugReport['severity'][] = [
    'info',
    'minor',
    'major',
    'critical'
  ];

  severities.forEach((severity) => {
    const bug: BugReport = {
      id: `2026-07-07-test-${severity}`,
      severity,
      prompt: 'Test',
      response: 'Test response',
      reportedAt: '2026-07-07T12:00:00Z',
      gitHead: 'abc123',
      appVersion: '1.0.0',
      agent: 'claude',
      status: 'open',
      tags: [],
      body: 'Test body'
    };
    assert.strictEqual(bug.severity, severity);
  });
});

test('memory types - BugReport with all statuses', () => {
  const statuses: BugReport['status'][] = [
    'open',
    'acknowledged',
    'fixed',
    'wont_fix'
  ];

  statuses.forEach((status) => {
    const bug: BugReport = {
      id: `2026-07-07-test-${status}`,
      severity: 'minor',
      prompt: 'Test',
      response: 'Test response',
      reportedAt: '2026-07-07T12:00:00Z',
      gitHead: 'abc123',
      appVersion: '1.0.0',
      agent: 'claude',
      status,
      tags: [],
      body: 'Test body'
    };
    assert.strictEqual(bug.status, status);
  });
});

test('memory types - ValidationResult with all reasons', () => {
  const reasons: ValidationResult['reason'][] = [
    'file_not_found',
    'contradiction',
    'invalid_command',
    'syntax_error'
  ];

  reasons.forEach((reason) => {
    const result: ValidationResult = {
      valid: false,
      reason,
      details: `Test details for ${reason}`
    };
    assert.strictEqual(result.reason, reason);
  });
});
