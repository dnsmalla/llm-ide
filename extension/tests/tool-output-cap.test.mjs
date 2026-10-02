// Every hop of an agent turn re-reads the whole context, so one huge tool
// result is paid for again on every later hop (measured: a work turn re-read
// 147k–895k cached tokens). A PostToolUse hook now trims native tool output
// past a cap BEFORE the model sees it, and says how to get the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capToolOutput, toolOutputCapHook, BASH_CAP_CHARS, withToolOutputCap } from '../llm_agent/sdk/tool-output-cap.mjs';

const lines = (n, w = 60) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(5)} ${'x'.repeat(w)}`).join('\n');

// Read is deliberately NOT trimmed: the SDK records the ORIGINAL read as a full
// view, and its read-dedup answers a repeated plain Read with "unchanged —
// refer to your earlier result" — which would be the trimmed head, so the
// model could never get the rest that way. The SDK's own Read cap still applies.
test('Read is passed through untouched, however large', () => {
  const content = lines(2000);
  assert.equal(capToolOutput('Read', { type: 'text', file: { filePath: '/r/a.ts', content, numLines: 2000, startLine: 1, totalLines: 2000 } }), null);
});

test('Bash: image output (a data URI) and structured content are never trimmed', () => {
  const uri = `data:image/png;base64,${'A'.repeat(BASH_CAP_CHARS * 3)}`;
  assert.equal(capToolOutput('Bash', { stdout: uri, stderr: '', interrupted: false, isImage: true }), null);
  assert.equal(capToolOutput('Bash', { stdout: 'x'.repeat(BASH_CAP_CHARS * 3), stderr: '', interrupted: false, structuredContent: [{ type: 'text', text: 'y' }] }), null);
});

test('Bash: stdout and stderr together stay near one cap, not two', () => {
  const out = capToolOutput('Bash', { stdout: 'o'.repeat(BASH_CAP_CHARS * 2), stderr: 'e'.repeat(BASH_CAP_CHARS * 2), interrupted: false });
  assert.ok(out.stdout.length + out.stderr.length < BASH_CAP_CHARS * 1.6, `${out.stdout.length + out.stderr.length}`);
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
  assert.equal(out.numLines, out.content.split('\n').length - 1, 'numLines counts the lines actually kept');
  assert.equal(capToolOutput('Grep', { mode: 'files_with_matches', numFiles: 1, filenames: ['a'] }), null);
});

test('the hook returns updatedToolOutput only when it trimmed something', async () => {
  const big = { tool_name: 'Bash', tool_response: { stdout: 'q'.repeat(BASH_CAP_CHARS * 3), stderr: '', interrupted: false } };
  const res = await toolOutputCapHook({ hook_event_name: 'PostToolUse', ...big });
  assert.equal(res.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(res.hookSpecificOutput.updatedToolOutput.stdout.length < BASH_CAP_CHARS * 3);
  assert.deepEqual(await toolOutputCapHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'ok', stderr: '' } }), {});
});

// A trusted native plugin's PostToolUse hook may redact output; hooks all run
// on the ORIGINAL and the last write wins, so a trim built from the unredacted
// original could undo the redaction. With native plugins present: no cap.
test('withToolOutputCap leaves the hooks alone when native plugins are loaded', () => {
  const plugin = { matcher: 'Bash', hooks: [async () => ({})] };
  assert.deepEqual(withToolOutputCap({ PostToolUse: [plugin] }, { nativePlugins: 1 }), { PostToolUse: [plugin] });
  assert.equal(withToolOutputCap({}, { nativePlugins: 0 }).PostToolUse.length, 1);
});
