#!/usr/bin/env node
// Stub for the Claude CLI used by the live HTTP contract test (LLMIDE_ANTHROPIC_CLI).
// Prints one canned `--output-format json` result, so no model is called.
// Ignores its arguments; stdin is closed by the caller.
const text = 'Stub reply (no model call).';
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {},
}) + '\n');
