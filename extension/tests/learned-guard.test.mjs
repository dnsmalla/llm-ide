// Shell guard for system/self-improvement/ (llm_agent/sdk/learned-guard.mjs): a native Bash command that changes the
// folder without naming it has its change put back, and what it left is kept in the inbox for review.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const { createLearnedGuard, withLearnedGuard } = await import('../llm_agent/sdk/learned-guard.mjs');
const { noteAppWrite } = await import('../graphkit/self-improvement-folder.mjs');
const { sandboxOptionFromEnv } = await import('../llm_agent/sdk/engine.mjs');

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')));
  made.push(root);
  const si = path.join(root, 'system', 'self-improvement');
  fs.mkdirSync(si, { recursive: true });
  fs.writeFileSync(path.join(si, 'memory.md'), '# Chat memory\n- real fact\n');
  fs.writeFileSync(path.join(si, 'lessons.json'), '{"format":1,"lessons":[]}');
  return { root, si };
}
const inboxShell = (si) => fs.readdirSync(path.join(si, 'inbox')).filter((n) => n.startsWith('from-shell-'));

test('a command\'s edit, new file and deletion are put back; what it left is kept in the inbox; the model is told', async () => {
  const { root, si } = workspace();
  const hooks = withLearnedGuard({ PostToolUse: [{ matcher: 'Bash|Grep', hooks: [] }] }, createLearnedGuard([root]));
  assert.equal(hooks.PostToolUse.length, 2, 'existing hooks are kept');
  await hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash' }, 'tu1');
  // What `cd system && sed -i … self-imp*/memory.md` etc. would do, without the command naming the folder.
  fs.writeFileSync(path.join(si, 'memory.md'), '# Chat memory\n- planted fact\n');
  fs.writeFileSync(path.join(si, 'new.md'), 'sneaky');
  fs.rmSync(path.join(si, 'lessons.json'));
  const out = await hooks.PostToolUse[1].hooks[0]({ tool_name: 'Bash' }, 'tu1');
  assert.match(out.hookSpecificOutput.additionalContext, /undid this command's changes to system\/self-improvement\//);
  assert.equal(fs.readFileSync(path.join(si, 'memory.md'), 'utf8'), '# Chat memory\n- real fact\n');
  assert.ok(fs.existsSync(path.join(si, 'lessons.json')) && !fs.existsSync(path.join(si, 'new.md')));
  const [kept] = inboxShell(si);
  assert.equal(fs.readFileSync(path.join(si, 'inbox', kept, 'memory.md'), 'utf8'), '# Chat memory\n- planted fact\n', 'nothing is lost: it waits for review');
  assert.equal(fs.readFileSync(path.join(si, 'inbox', kept, 'new.md'), 'utf8'), 'sneaky');
});

test('a failed command is checked too, and an untouched folder says nothing', async () => {
  const { root, si } = workspace();
  const hooks = withLearnedGuard({}, createLearnedGuard([root]));
  await hooks.PreToolUse[0].hooks[0]({}, 'a');
  assert.deepEqual(await hooks.PostToolUse[0].hooks[0]({}, 'a'), {});
  await hooks.PreToolUse[0].hooks[0]({}, 'b');
  fs.appendFileSync(path.join(si, 'memory.md'), '- appended\n');
  const out = await hooks.PostToolUseFailure[0].hooks[0]({}, 'b');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.doesNotMatch(fs.readFileSync(path.join(si, 'memory.md'), 'utf8'), /appended/);
});

test('a file swapped for a symlink is restored in place, never written through the link', async () => {
  const { root, si } = workspace();
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'keep me');
  const guard = createLearnedGuard([root]);
  guard.before('x');
  fs.rmSync(path.join(si, 'memory.md'));
  fs.symlinkSync(outside, path.join(si, 'memory.md'));
  guard.after('x');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
  assert.ok(!fs.lstatSync(path.join(si, 'memory.md')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(si, 'memory.md'), 'utf8'), '# Chat memory\n- real fact\n');
});

test('the app\'s own write during the command is never undone', async () => {
  const { root, si } = workspace();
  let t = 1000;
  const guard = createLearnedGuard([root], { clock: () => t });
  guard.before('y');
  fs.appendFileSync(path.join(si, 'memory.md'), '- learned by another chat\n');
  noteAppWrite(si, 1001);
  t = 1002;
  assert.deepEqual(guard.after('y'), []);
  assert.match(fs.readFileSync(path.join(si, 'memory.md'), 'utf8'), /learned by another chat/);
});

test('with the sandbox on, the folder is denied to commands by the OS', () => {
  assert.deepEqual(sandboxOptionFromEnv('on', { denyWrite: ['/p/system/self-improvement'] }).filesystem, { denyWrite: ['/p/system/self-improvement'] });
  assert.equal(sandboxOptionFromEnv('on').filesystem, undefined);
  assert.equal(sandboxOptionFromEnv(undefined, { denyWrite: ['/x'] }), null, 'inherit stays inherit');
});
