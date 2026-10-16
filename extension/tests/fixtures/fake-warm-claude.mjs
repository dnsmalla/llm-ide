// extension/tests/fixtures/fake-warm-claude.mjs
// Stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`.
// Speaks just enough of the protocol for the pool tests; never calls a model.
import { createInterface } from 'node:readline';
import fs from 'node:fs';

const mode = process.env.FAKE_WARM_MODE || 'ok';
if (process.env.FAKE_WARM_PID_FILE) fs.writeFileSync(process.env.FAKE_WARM_PID_FILE, String(process.pid));
if (mode === 'exit_before_read') process.exit(3);

const wantsStreamIn = process.argv.includes('--input-format');
if (!wantsStreamIn) {
  // Cold form: prompt is the last argv. Mirror the real CLI's single JSON result.
  const prompt = process.argv[process.argv.length - 1];
  process.stdout.write(JSON.stringify(resultFor(prompt)) + '\n');
  process.exit(mode === 'is_error' ? 1 : 0);
}

const rl = createInterface({ input: process.stdin });
let received = false;
// A hanging child must stay alive on its own: after stdin EOF nothing else holds the loop open.
if (mode === 'hang') setInterval(() => {}, 1_000_000);
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.type !== 'user') return;
  received = true;
  if (mode === 'exit_after_read') process.exit(2);
  if (mode === 'hang') return;
  const text = typeof msg.message?.content === 'string'
    ? msg.message.content
    : (msg.message?.content || []).map((c) => c.text || '').join('');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }) + '\n');
  // exit from the write callback: process.exit() on a pipe would truncate the 5 MB `big` line
  process.stdout.write(JSON.stringify(resultFor(text)) + '\n', () => process.exit(0));
});
// Like the real CLI: EOF after a prompt means "no more turns" (the turn still
// runs, so a hanging one keeps hanging); EOF with no prompt just ends the child.
rl.on('close', () => { if (mode === 'hang' && !received) process.exit(0); });

function resultFor(prompt) {
  const big = mode === 'big' ? 'x'.repeat(5 * 1024 * 1024) : null;
  return {
    type: 'result', subtype: mode === 'is_error' ? 'error' : 'success',
    is_error: mode === 'is_error',
    result: mode === 'is_error' ? 'Not logged in. Please run /login' : (big || `{"mode":"execute","echo":${JSON.stringify(prompt.slice(0, 40))}}`),
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  };
}
