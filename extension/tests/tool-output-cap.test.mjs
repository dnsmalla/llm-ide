// Every hop of an agent turn re-reads the whole context, so one huge tool
// result is paid for again on every later hop (measured: a work turn re-read
// 147k–895k cached tokens). A PostToolUse hook now trims native tool output
// past a cap BEFORE the model sees it, and says how to get the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capToolOutput, toolOutputCapHook, READ_CAP_CHARS, BASH_CAP_CHARS } from '../llm_agent/sdk/tool-output-cap.mjs';

const lines = (n, w = 60) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5)} ${'x'.repeat(w)}`).join('\n');

test('Read: a big file keeps its HEAD whole lines only, so line numbers stay right, and is marked truncated', () => {
  const content = lines(2000);
  const out = capToolOutput('Read', { type: 'text', file: { filePath: '/r/a.ts', content, numLines: 2000, startLine: 1, totalLines: 2000 } });
  assert.ok(out.file.content.length <= READ_CAP_CHARS);
  assert.ok(content.startsWith(out.file.content), 'a prefix of the original — nothing in the middle removed');
  assert.ok(out.file.content.endsWith('x'), 'cut on a line boundary');
  assert.equal(out.file.numLines, out.file.content.split('\n').length);
  assert.equal(out.file.truncatedByTokenCap, true, 'the SDK then tells the model to Read on with offset/limit');
  assert.equal(out.file.totalLines, 2000);
});

test('Read: a file under the cap, an image, and a non-object pass through untouched', () => {
  const small = { type: 'text', file: { filePath: '/r/b.ts', content: 'hi', numLines: 1, startLine: 1, totalLines: 1 } };
  assert.equal(capToolOutput('Read', small), null);
  assert.equal(capToolOutput('Read', { type: 'image', file: { base64: 'x'.repeat(100_000) } }), null);
  assert.equal(capToolOutput('Read', 'oops'), null);
});

test('Bash: long stdout keeps head and tail with a note in between', () => {
  const stdout = `${'a'.repeat(BASH_CAP_CHARS)}MIDDLE${'z'.repeat(BASH_CAP_CHARS)}`;
  const out = capToolOutput('Bash', { stdout, stderr: '', interrupted: false });
  assert.ok(out.stdout.length < stdout.length / 1.5);
  assert.ok(out.stdout.startsWith('aaaa') && out.stdout.endsWith('zzzz'), 'the start and the end (where errors and summaries are) survive');
  assert.match(out.stdout, /omitted by LLM-IDE/);
  assert.doesNotMatch(out.stdout, /MIDDLE/);
  assert.equal(capToolOutput('Bash', { stdout: 'ok', stderr: '', interrupted: false }), null);
});

test('Grep: long content-mode output keeps whole leading lines and counts the rest', () => {
  const content = lines(3000, 40);
  const out = capToolOutput('Grep', { mode: 'content', numFiles: 9, filenames: [], content, numLines: 3000 });
  assert.ok(out.content.length < content.length);
  assert.match(out.content, /more lines omitted by LLM-IDE/);
  assert.equal(capToolOutput('Grep', { mode: 'files_with_matches', numFiles: 1, filenames: ['a'] }), null);
});

test('the hook returns updatedToolOutput only when it trimmed something', async () => {
  const big = { tool_name: 'Bash', tool_response: { stdout: 'q'.repeat(BASH_CAP_CHARS * 3), stderr: '', interrupted: false } };
  const res = await toolOutputCapHook({ hook_event_name: 'PostToolUse', ...big });
  assert.equal(res.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(res.hookSpecificOutput.updatedToolOutput.stdout.length < BASH_CAP_CHARS * 3);
  assert.deepEqual(await toolOutputCapHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'ok', stderr: '' } }), {});
});
