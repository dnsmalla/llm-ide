# Agent v2 Write Tools + Default-On Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open native `Edit`/`Write`/`Bash` on the Agent v2 engine behind the existing approval ladder, render diff-capable approval cards on the Mac, and flip the engine default to on for new Anthropic chats.

**Architecture:** `canUseTool` in `extension/llm_agent/sdk/engine.mjs` grows a native-tool branch that reuses the act-tool ladder (gate → auto → always-allow → parked ToolApproval) with a new filesystem containment gate for `Edit`/`Write`. The `approval_request` wire event gains a structured `args` payload the Mac's `ToolApprovalCard` renders as a diff. `chat.useAgentV2`'s unset-default flips to true.

**Tech Stack:** Node 20+ (no framework), `node:test`, `@anthropic-ai/claude-agent-sdk` 0.3.234 (pinned), SwiftUI + swift-testing.

**Spec:** `docs/superpowers/specs/2026-08-20-agent-v2-write-tools-design.md`

## Global Constraints

- Node tests run from `extension/`: `cd extension && node --test tests/<file>` — full suite `npm test`, lint `npm run lint` (`--max-warnings 0`).
- `tests/auth-routes.test.mjs` fails under the CLI sandbox (known EPERM fixture issue) — not a regression; verify it separately without sandbox if the full suite is run.
- Swift builds need `GIT_CONFIG_GLOBAL=/dev/null` and no sandbox: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`. `swift test` may silently no-op on this machine (no xctest runner) — treat `swift build` as the hard gate and still run `swift test`.
- ESLint layer rules: `llm_agent/` may import `core/`, `kb/`, server libs — nothing new is needed by this plan; never add per-file exemptions.
- Comments in English. Conventional Commits (`feat(server):`, `feat(mac):`, `test:`), one concern per commit.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Ship order is load-bearing (spec §7): Tasks 1–4 are server-side and exposure stays opt-in (toggle default still off until Task 7). Task 7 (default flip) lands last.

---

### Task 1: `writePathGate` — filesystem containment gate

**Files:**
- Modify: `extension/llm_agent/tools/gates.mjs` (append after `autoGate`, ~line 63)
- Test: `extension/tests/write-path-gate.test.mjs` (new)

**Interfaces:**
- Consumes: nothing from other tasks. `node:fs`, `node:path`.
- Produces: `writePathGate(filePath, roots) -> 'prompt' | 'blocked'` — exported from `gates.mjs`. `roots` is a non-empty array of absolute directory paths; `roots[0]` is the workspace root that relative paths resolve against. Returns `'prompt'` when the target is safely inside a root (approval ladder continues), `'blocked'` otherwise (never promptable).

- [ ] **Step 1: Write the failing tests**

```js
// extension/tests/write-path-gate.test.mjs
// Containment gate for native Edit/Write on the v2 engine: 'prompt' only when
// the target resolves inside an allowed root; symlink and `..` escapes are
// 'blocked' — never promptable, never always-allowable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePathGate } from '../llm_agent/tools/gates.mjs';

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wpg-'));
  const workspace = path.join(base, 'workspace');
  const extra = path.join(base, 'extra');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(extra, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.txt'), 'hello');
  // A symlink INSIDE the workspace that points OUTSIDE it.
  fs.symlinkSync(outside, path.join(workspace, 'link-out'), 'dir');
  return { base, workspace, extra, outside };
}

test('existing file inside the workspace prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.workspace, 'src', 'a.txt'), [f.workspace]), 'prompt');
});

test('new file in an existing directory inside the workspace prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.workspace, 'src', 'new.txt'), [f.workspace]), 'prompt');
});

test('relative path resolves against the first root and prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate('src/new.txt', [f.workspace]), 'prompt');
});

test('a target under an additional directory prompts', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.extra, 'notes.md'), [f.workspace, f.extra]), 'prompt');
});

test('.. traversal out of the workspace is blocked', () => {
  const f = makeFixture();
  assert.equal(writePathGate('../outside/evil.txt', [f.workspace]), 'blocked');
});

test('an absolute path outside every root is blocked', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.outside, 'evil.txt'), [f.workspace, f.extra]), 'blocked');
});

test('a symlink escape is blocked even though the lexical path is inside', () => {
  const f = makeFixture();
  assert.equal(writePathGate(path.join(f.workspace, 'link-out', 'evil.txt'), [f.workspace]), 'blocked');
});

test('empty, non-string, or missing roots are blocked', () => {
  const f = makeFixture();
  assert.equal(writePathGate('', [f.workspace]), 'blocked');
  assert.equal(writePathGate(null, [f.workspace]), 'blocked');
  assert.equal(writePathGate('a.txt', []), 'blocked');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/write-path-gate.test.mjs`
Expected: FAIL — `writePathGate` is not exported.

- [ ] **Step 3: Implement `writePathGate` in `gates.mjs`**

```js
/**
 * Containment gate for native Edit/Write targets on the v2 engine.
 *
 * 'prompt'  — the target resolves inside one of `roots` (the approval ladder
 *             continues: always-allow, then a parked ToolApproval).
 * 'blocked' — everything else. Like a blocked bash command, this tier is
 *             never promptable and never always-allowable: symlink and `..`
 *             escapes must not be one careless click away.
 *
 * The file itself may not exist yet (Write creates files), so containment is
 * checked on the nearest EXISTING ancestor's realpath plus the remaining
 * lexical suffix — a symlink anywhere in the existing part cannot escape.
 */
export function writePathGate(filePath, roots) {
  if (typeof filePath !== 'string' || !filePath) return 'blocked';
  if (!Array.isArray(roots) || roots.length === 0) return 'blocked';
  const primary = roots[0];
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(primary, filePath);
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return 'blocked';
    existing = parent;
  }
  let resolved;
  try {
    const real = fs.realpathSync(existing);
    const suffix = path.relative(existing, abs);
    resolved = suffix ? path.join(real, suffix) : real;
  } catch {
    return 'blocked';
  }
  const inside = (root) => {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { return false; }
    return resolved === realRoot || resolved.startsWith(realRoot + path.sep);
  };
  return roots.some(inside) ? 'prompt' : 'blocked';
}
```

`gates.mjs` has no `fs`/`path` imports today — add `import fs from 'node:fs';` and `import path from 'node:path';` at the top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/write-path-gate.test.mjs`
Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/tools/gates.mjs extension/tests/write-path-gate.test.mjs
git commit -m "feat(server): v2 書き込みツール用のパス封じ込めゲートを追加"
```

---

### Task 2: Extract `awaitToolApproval` helper in `engine.mjs` (behavior-preserving)

**Files:**
- Modify: `extension/llm_agent/sdk/engine.mjs` (the act-tool park block inside `canUseTool`, currently ~lines 435–459)
- Test: existing `extension/tests/agent-v2-engine.test.mjs` (no new tests — this is a pure refactor guarded by the existing act-tool suite)

**Interfaces:**
- Consumes: `registerDecision`, `abortDecisionsForSession`, `setAlwaysAllow`, `onEvent`, `signal`, `currentSdkSessionId` — all already in scope inside `runAgentV2Turn`.
- Produces: an inner-closure helper (declared inside `runAgentV2Turn`, right before `canUseTool`):
  `awaitToolApproval({ toolName, argsSummary, args = null, input, callSignal }) -> Promise<SDK decision object>` — parks a ToolApproval, emits `approval_request` (including `args` when non-null), awaits the decision, handles `always-allow` persistence, and returns `{behavior:'allow', updatedInput: input}` or `{behavior:'deny', message: DENY_NO_ANSWER}`. Task 3 calls this for native tools.

- [ ] **Step 1: Extract the helper**

Inside `runAgentV2Turn`, immediately above `const canUseTool = ...`, add:

```js
  // Park one ToolApproval and await the human decision — the shared tail of
  // the act-tool branch and (Task 3) the native Edit/Write/Bash branch.
  // `args` is the structured payload the Mac renders as a diff; older
  // clients ignore it and keep reading argsSummary.
  const awaitToolApproval = async ({ toolName, argsSummary, args = null, input, callSignal }) => {
    const sessionId = currentSdkSessionId;
    const { requestId, promise } = registerDecision({ sdkSessionId: sessionId, userId, kind: 'ToolApproval' });
    const onAbort = () => { abortDecisionsForSession(sessionId); };
    const signals = [callSignal, signal].filter(Boolean);
    for (const s of signals) {
      if (s.aborted) onAbort();
      else s.addEventListener('abort', onAbort, { once: true });
    }
    const detach = () => { for (const s of signals) s.removeEventListener('abort', onAbort); };
    try {
      onEvent?.({ type: 'approval_request', requestId, kind: 'ToolApproval', toolName, argsSummary, ...(args ? { args } : {}) });
      const outcome = await promise;
      onEvent?.({ type: 'approval_resolved', requestId, outcome: outcome.action });
      if (outcome.action === 'always-allow') {
        setAlwaysAllow(userId, toolName);
        return { behavior: 'allow', updatedInput: input };
      }
      if (outcome.action === 'allow') return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: DENY_NO_ANSWER };
    } finally {
      detach();
    }
  };
```

Then replace the act branch's inline park block (from `const sessionId = currentSdkSessionId;` after the `hasAlwaysAllow` check down to its closing `finally { detach(); }`) with:

```js
      return awaitToolApproval({
        toolName: entry.name,
        argsSummary: JSON.stringify(input),
        input,
        callSignal: callOpts?.signal,
      });
```

- [ ] **Step 2: Run the existing act-tool suite to verify no behavior change**

Run: `cd extension && node --test tests/agent-v2-engine.test.mjs tests/agent-v2-act-tool-e2e.test.mjs`
Expected: all PASS (the run-bash blocked/auto/prompt/deny/abort tests exercise every path through the helper).

- [ ] **Step 3: Commit**

```bash
git add extension/llm_agent/sdk/engine.mjs
git commit -m "refactor(server): ToolApproval のパーク処理を awaitToolApproval に抽出"
```

---

### Task 3: Native `Bash`/`Edit`/`Write` branch in `canUseTool`

**Files:**
- Modify: `extension/llm_agent/sdk/engine.mjs` — the catch-all deny (~line 405), the `DENY_NEXT_RELEASE` constant (~line 330), and `runAgentV2Turn` (allowed-roots wiring after the `buildEngineOptions` call)
- Test: `extension/tests/agent-v2-engine.test.mjs` (update one test, add six)

**Interfaces:**
- Consumes: `writePathGate` (Task 1), `awaitToolApproval` (Task 2), existing `runBashGate`, `hasAlwaysAllow`, `restrictsTools`.
- Produces:
  - `approvalArgsFor(toolName, input) -> object|null` — exported from `engine.mjs` for tests. Shapes (each string capped at `APPROVAL_ARG_CAP = 20_000` chars; `truncated: true` present iff anything was cut):
    - `Bash` → `{ command }`
    - `Edit` → `{ filePath, oldString, newString }`
    - `Write` → `{ filePath, contentPreview, totalChars }`
  - The `approval_request` wire event now carries `args` for every ToolApproval (native and act) — `agent-v2.mjs`'s `send(ev)` forwards the event object verbatim, so no route change.
  - Deny copy: `DENY_UNKNOWN_TOOL = 'This tool is not enabled in the LLM-IDE chat engine.'` replaces `DENY_NEXT_RELEASE`.

- [ ] **Step 1: Update the stale deny test and write the failing tests**

In `tests/agent-v2-engine.test.mjs`, the test `non-question tools are denied with an explanatory message` (~line 408) currently probes `Bash` with `rm -rf /` and matches `/next engine release/`. Replace it and add the new coverage (imports of `writePathGate` are not needed; `approvalArgsFor` comes from `../llm_agent/sdk/engine.mjs`; reuse the file's existing `withAnthropicKey`, `makeFakeQuery`, `turnInjectable`, `registerUser`, `getDb`, `setAlwaysAllow`, `answerDecision`, `hasAlwaysAllow` fixtures — add missing imports from their existing modules if the file doesn't import them yet):

```js
test('an unknown native tool is denied with the not-enabled message', withAnthropicKey('sk-ant-v2-test', async () => {
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  await runAgentV2Turn({
    message: 'm', userId: 'u1', mode: 'execute', agentContext: { workspaceRoot: '/tmp/w' },
    onEvent: () => {}, queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('NotebookEdit', { notebook_path: '/tmp/x.ipynb' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /not enabled/);
}));

test('native Bash: blocked command is denied even with always-allow set', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-blocked@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAlwaysAllow(user.id, 'Bash');
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: '/tmp/w' },
    onEvent: () => {}, queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Bash', { command: 'sudo rm -rf /' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /blocked/i);
}));

test('native Bash: auto-safe command allows with no approval parked', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-auto@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  const events = [];
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: '/tmp/w' },
    onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Bash', { command: 'git status' });
  assert.equal(d.behavior, 'allow');
  assert.ok(!events.some((e) => e.type === 'approval_request'));
}));

test('native Bash: prompt-tier command parks a ToolApproval carrying args.command', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-prompt@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const script = { messages: [{ type: 'init', session_id: 'sdk-nb1' }, { type: 'result', subtype: 'success', session_id: 'sdk-nb1' }] };
  const events = [];
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: '/tmp/w' },
    resumeSdkSessionId: 'sdk-nb1', onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const decision = script.options.canUseTool('Bash', { command: 'npm run build' });
  const req = events.find((e) => e.type === 'approval_request');
  assert.equal(req.kind, 'ToolApproval');
  assert.equal(req.toolName, 'Bash');
  assert.deepEqual(req.args, { command: 'npm run build' });
  answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-nb1', userId: user.id, action: 'allow' });
  const d = await decision;
  assert.equal(d.behavior, 'allow');
}));

test('native Edit: in-workspace target parks with diff args; always-allow persists per tool', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-edit@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'v2edit-'));
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'old');
  const script = { messages: [{ type: 'init', session_id: 'sdk-ed1' }, { type: 'result', subtype: 'success', session_id: 'sdk-ed1' }] };
  const events = [];
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: workspace },
    resumeSdkSessionId: 'sdk-ed1', onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const input = { file_path: path.join(workspace, 'a.txt'), old_string: 'old', new_string: 'new' };
  const decision = script.options.canUseTool('Edit', input);
  const req = events.find((e) => e.type === 'approval_request');
  assert.equal(req.toolName, 'Edit');
  assert.deepEqual(req.args, { filePath: input.file_path, oldString: 'old', newString: 'new' });
  answerDecision({ requestId: req.requestId, sdkSessionId: 'sdk-ed1', userId: user.id, action: 'always-allow' });
  const d = await decision;
  assert.equal(d.behavior, 'allow');
  assert.equal(hasAlwaysAllow(user.id, 'Edit'), true);
  // The always-allow row now shortcuts the prompt tier for the next Edit.
  const d2 = await script.options.canUseTool('Edit', input);
  assert.equal(d2.behavior, 'allow');
}));

test('native Write: an out-of-workspace target is denied, never parked', withAnthropicKey('sk-ant-v2-test', async () => {
  const user = registerUser(getDb(), { email: 'v2native-escape@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'v2esc-'));
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  const events = [];
  await runAgentV2Turn({
    message: 'm', userId: user.id, mode: 'execute', agentContext: { workspaceRoot: workspace },
    onEvent: (e) => events.push(e), queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Write', { file_path: '../evil.txt', content: 'x' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /workspace/i);
  assert.ok(!events.some((e) => e.type === 'approval_request'));
}));

test('native tools are denied in a restricted mode', withAnthropicKey('sk-ant-v2-test', async () => {
  const script = { messages: [{ type: 'result', subtype: 'success', session_id: 's' }] };
  await runAgentV2Turn({
    message: 'm', userId: 'u1', mode: 'plan', agentContext: { workspaceRoot: '/tmp/w' },
    onEvent: () => {}, queryFactory: makeFakeQuery(script),
  }, turnInjectable);
  const d = await script.options.canUseTool('Edit', { file_path: '/tmp/w/a.txt', old_string: 'a', new_string: 'b' });
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /plan mode/);
}));
```

Also add a pure-function block for the caps:

```js
test('approvalArgsFor caps every string field at 20k and marks truncation', () => {
  const long = 'x'.repeat(25_000);
  const edit = approvalArgsFor('Edit', { file_path: '/w/a.txt', old_string: long, new_string: 'n' });
  assert.equal(edit.oldString.length, 20_000);
  assert.equal(edit.truncated, true);
  const write = approvalArgsFor('Write', { file_path: '/w/a.txt', content: long });
  assert.equal(write.contentPreview.length, 20_000);
  assert.equal(write.totalChars, 25_000);
  assert.equal(write.truncated, true);
  const bash = approvalArgsFor('Bash', { command: 'git status' });
  assert.deepEqual(bash, { command: 'git status' });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd extension && node --test tests/agent-v2-engine.test.mjs`
Expected: the new tests FAIL (`approvalArgsFor` not exported; `Bash`/`Edit` currently denied with the old message); pre-existing tests still PASS except the replaced one.

- [ ] **Step 3: Implement in `engine.mjs`**

(a) Replace the constant:

```js
// Native tools outside the gated roster (and any unknown tool) stay denied —
// a deny with a reason reads better to the model than a silent hang.
const DENY_UNKNOWN_TOOL = 'This tool is not enabled in the LLM-IDE chat engine.';
```

(b) Add near it:

```js
// Cap for every string carried in approval_request.args — the payload is a
// UI preview, not the transport for the edit itself (the SDK already holds
// the real input).
const APPROVAL_ARG_CAP = 20_000;

/** Structured approval-card payload for a native tool, capped per field. */
export function approvalArgsFor(toolName, input) {
  let truncated = false;
  const cut = (s) => {
    const str = typeof s === 'string' ? s : '';
    if (str.length > APPROVAL_ARG_CAP) { truncated = true; return str.slice(0, APPROVAL_ARG_CAP); }
    return str;
  };
  if (toolName === 'Bash') {
    const args = { command: cut(input?.command) };
    return truncated ? { ...args, truncated } : args;
  }
  if (toolName === 'Edit') {
    const args = { filePath: cut(input?.file_path), oldString: cut(input?.old_string), newString: cut(input?.new_string) };
    return truncated ? { ...args, truncated } : args;
  }
  if (toolName === 'Write') {
    const content = typeof input?.content === 'string' ? input.content : '';
    const args = { filePath: cut(input?.file_path), contentPreview: cut(content), totalChars: content.length };
    return truncated ? { ...args, truncated } : args;
  }
  return null;
}
```

(c) In `runAgentV2Turn`, declare before `canUseTool`:

```js
  // Roots native Edit/Write may target — assigned right after
  // buildEngineOptions computes additionalDirectories; the canUseTool
  // closure reads it at call time, which is always after that assignment.
  let allowedWriteRoots = [];
```

and after the `buildEngineOptions(...)` call:

```js
  allowedWriteRoots = [workspaceRoot, ...(queryOptions.additionalDirectories || [])].filter(Boolean);
```

(d) Replace the catch-all deny at the top of `canUseTool` with the native branch (gate first, always; always-allow only shortcuts the prompt tier — same law as the act branch):

```js
    const NATIVE_GATED = new Set(['Bash', 'Edit', 'Write']);
    if (toolName !== 'AskUserQuestion' && !(entry && entry.kind === 'act') && !NATIVE_GATED.has(toolName)) {
      return { behavior: 'deny', message: DENY_UNKNOWN_TOOL };
    }
    if (NATIVE_GATED.has(toolName)) {
      const requestedMode = typeof mode === 'string' && mode ? mode : 'execute';
      if (restrictsTools(requestedMode)) {
        return { behavior: 'deny', message: `${toolName} is not available in ${requestedMode} mode.` };
      }
      if (toolName === 'Bash') {
        const decision = runBashGate(input?.command);
        if (decision === 'blocked') return { behavior: 'deny', message: 'Command blocked for safety.' };
        if (decision === 'auto' || hasAlwaysAllow(userId, 'Bash')) {
          return { behavior: 'allow', updatedInput: input };
        }
        return awaitToolApproval({
          toolName: 'Bash', argsSummary: String(input?.command ?? ''),
          args: approvalArgsFor('Bash', input), input, callSignal: callOpts?.signal,
        });
      }
      // Edit / Write — containment first; a 'blocked' path is final.
      if (writePathGate(input?.file_path, allowedWriteRoots) === 'blocked') {
        return { behavior: 'deny', message: `${toolName} refused: the target must stay inside the project workspace.` };
      }
      if (hasAlwaysAllow(userId, toolName)) return { behavior: 'allow', updatedInput: input };
      return awaitToolApproval({
        toolName, argsSummary: String(input?.file_path ?? ''),
        args: approvalArgsFor(toolName, input), input, callSignal: callOpts?.signal,
      });
    }
```

Add the import: `writePathGate` from `../tools/gates.mjs` (the file already imports `runBashGate` from there — extend that import). Remove the now-unused `DENY_NEXT_RELEASE`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/agent-v2-engine.test.mjs tests/agent-v2-act-tool-e2e.test.mjs tests/write-path-gate.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/sdk/engine.mjs extension/tests/agent-v2-engine.test.mjs
git commit -m "feat(server): v2 エンジンでネイティブ Bash/Edit/Write を承認ゲート付きで開放"
```

---

### Task 4: `v2ToolPolicyForMode` — run-bash retirement + restricted-mode disallow

**Files:**
- Modify: `extension/llm_agent/sdk/engine.mjs` (`v2ToolPolicyForMode`, ~line 165)
- Test: `extension/tests/agent-v2-engine.test.mjs` (extend the existing `v2ToolPolicyForMode` tests in place; if none exist there, search `grep -rn v2ToolPolicyForMode extension/tests/` and extend the file that has them)

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged signature `v2ToolPolicyForMode(mode) -> { allowedTools, disallowedTools }`, with `disallowedTools` now always containing `mcp__llmide__run-bash` (native Bash replaces it on v2) and, in restricted modes, also `Edit`, `Write`, `Bash`.

- [ ] **Step 1: Write the failing tests**

```js
test('v2ToolPolicyForMode: run-bash is disallowed on v2 in every mode (native Bash replaces it)', () => {
  assert.ok(v2ToolPolicyForMode('execute').disallowedTools.includes('mcp__llmide__run-bash'));
  assert.ok(v2ToolPolicyForMode('plan').disallowedTools.includes('mcp__llmide__run-bash'));
});

test('v2ToolPolicyForMode: restricted modes disallow the native write/shell tools', () => {
  const plan = v2ToolPolicyForMode('plan');
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(plan.disallowedTools.includes(t), t);
  const execute = v2ToolPolicyForMode('execute');
  for (const t of ['Edit', 'Write', 'Bash']) assert.ok(!execute.disallowedTools.includes(t), t);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd extension && node --test tests/agent-v2-engine.test.mjs`
Expected: both new tests FAIL (`disallowedTools` is `[]` for execute today).

- [ ] **Step 3: Implement**

```js
const RUN_BASH_MCP = `${MCP_PREFIX}run-bash`;
// Native write/shell tools a restricted mode must remove from model context
// entirely (canUseTool re-checks as the belt; this is the braces).
const NATIVE_GATED_TOOLS = ['Edit', 'Write', 'Bash'];

export function v2ToolPolicyForMode(mode) {
  if (!restrictsTools(mode)) {
    // run-bash is v2-retired in every mode: native Bash (canUseTool-gated)
    // replaces it, and offering both would be two shells with one gate.
    return { allowedTools: [...V2_ALLOWED_TOOLS], disallowedTools: [RUN_BASH_MCP] };
  }
  const permitted = allowedToolNames(mode);
  const keep = (n) => !n.startsWith(MCP_PREFIX) || permitted.has(n.slice(MCP_PREFIX.length));
  const disallowed = new Set([
    ...V2_ALL_MCP_TOOLS.filter((n) => !keep(n)),
    RUN_BASH_MCP,
    ...NATIVE_GATED_TOOLS,
  ]);
  return { allowedTools: V2_ALLOWED_TOOLS.filter(keep), disallowedTools: [...disallowed] };
}
```

- [ ] **Step 4: Run the v2 + registry suites**

Run: `cd extension && node --test tests/agent-v2-engine.test.mjs tests/agent-v2-routes.test.mjs tests/agent-v2-act-tool-e2e.test.mjs tests/global-handlers-sync.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/llm_agent/sdk/engine.mjs extension/tests/agent-v2-engine.test.mjs
git commit -m "feat(server): v2 のモード別ツールポリシーを更新（run-bash 退役・制限モードで書き込み禁止）"
```

---

### Task 5: Mac — `AgentV2Approval.args` decode

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/Chat/AgentV2Event.swift` (the `AgentV2Approval` struct, ~lines 105–131)
- Test: `mac/Tests/LlmIdeMacTests/AgentV2ApprovalTests.swift`

**Interfaces:**
- Consumes: the wire `args` shapes from Task 3 (`filePath/oldString/newString`, `filePath/contentPreview/totalChars`, `command`, optional `truncated`).
- Produces: `struct AgentV2ApprovalArgs: Sendable, Equatable, Codable` with all-optional fields `filePath, oldString, newString, contentPreview, totalChars, command, truncated`; `AgentV2Approval.args: AgentV2ApprovalArgs?` (nil for old servers and AskUserQuestion). Task 6 renders from it.

- [ ] **Step 1: Write the failing tests**

Add to `AgentV2ApprovalTests.swift` (follow the file's existing decode-test style — decode from a JSON literal `Data`):

```swift
@Test func decodesEditArgs() throws {
    let json = #"{"requestId":"r1","kind":"ToolApproval","toolName":"Edit","argsSummary":"/w/a.txt","args":{"filePath":"/w/a.txt","oldString":"old","newString":"new"}}"#
    let approval = try JSONDecoder().decode(AgentV2Approval.self, from: Data(json.utf8))
    #expect(approval.args?.filePath == "/w/a.txt")
    #expect(approval.args?.oldString == "old")
    #expect(approval.args?.newString == "new")
    #expect(approval.args?.truncated == nil)
}

@Test func missingArgsDecodesAsNil() throws {
    let json = #"{"requestId":"r2","kind":"ToolApproval","toolName":"Bash","argsSummary":"git push"}"#
    let approval = try JSONDecoder().decode(AgentV2Approval.self, from: Data(json.utf8))
    #expect(approval.args == nil)
}
```

- [ ] **Step 2: Build to verify it fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: FAIL — `args` / `AgentV2ApprovalArgs` do not exist.

- [ ] **Step 3: Implement**

In `AgentV2Event.swift`, above `AgentV2Approval`:

```swift
/// Structured payload of a ToolApproval — what the card renders as a diff /
/// command / content preview. Every field is optional: which ones are
/// populated depends on the tool (Edit: filePath/oldString/newString;
/// Write: filePath/contentPreview/totalChars; Bash: command). `truncated`
/// is present only when the server cut a field to its 20k cap.
struct AgentV2ApprovalArgs: Sendable, Equatable, Codable {
    let filePath: String?
    let oldString: String?
    let newString: String?
    let contentPreview: String?
    let totalChars: Int?
    let command: String?
    let truncated: Bool?
}
```

Extend `AgentV2Approval`: add `let args: AgentV2ApprovalArgs?`, a `case args` in `CodingKeys`, `args = try c.decodeIfPresent(AgentV2ApprovalArgs.self, forKey: .args)` in `init(from:)`, and `args: AgentV2ApprovalArgs? = nil` in the memberwise `init` (last parameter, defaulted, so existing call sites compile unchanged).

- [ ] **Step 4: Build and test**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests && GIT_CONFIG_GLOBAL=/dev/null swift test --filter AgentV2ApprovalTests`
Expected: build PASS; tests PASS (note: `swift test` may no-op on this machine — the build gate is mandatory either way).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/Chat/AgentV2Event.swift mac/Tests/LlmIdeMacTests/AgentV2ApprovalTests.swift
git commit -m "feat(mac): 承認イベントの構造化 args をデコード"
```

---

### Task 6: Mac — diff-capable `ToolApprovalCard`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/ToolApprovalCard.swift`
- Test: `mac/Tests/LlmIdeMacTests/ToolApprovalTests.swift`

**Interfaces:**
- Consumes: `AgentV2Approval.args` (Task 5).
- Produces: presentation only — plus two pure static helpers unit tests pin:
  - `ToolApprovalCard.title(toolName: String?) -> String` — "Edit file" for Edit, "Write file" for Write, "Run \(name)" otherwise.
  - `ToolApprovalCard.icon(toolName: String?) -> String` — `"pencil"` for Edit, `"square.and.pencil"` for Write, `"terminal.fill"` otherwise.

- [ ] **Step 1: Write the failing tests**

```swift
@Test func toolApprovalCardTitleAndIconPerTool() {
    #expect(ToolApprovalCard.title(toolName: "Edit") == "Edit file")
    #expect(ToolApprovalCard.title(toolName: "Write") == "Write file")
    #expect(ToolApprovalCard.title(toolName: "Bash") == "Run Bash")
    #expect(ToolApprovalCard.title(toolName: nil) == "Run tool")
    #expect(ToolApprovalCard.icon(toolName: "Edit") == "pencil")
    #expect(ToolApprovalCard.icon(toolName: "Write") == "square.and.pencil")
    #expect(ToolApprovalCard.icon(toolName: "Bash") == "terminal.fill")
}
```

- [ ] **Step 2: Build to verify it fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests`
Expected: FAIL — the static helpers do not exist.

- [ ] **Step 3: Implement**

Add the helpers and replace the single `argsSummary` text block with per-tool rendering:

```swift
    static func title(toolName: String?) -> String {
        switch toolName {
        case "Edit": return "Edit file"
        case "Write": return "Write file"
        case .some(let name): return "Run \(name)"
        case nil: return "Run tool"
        }
    }

    static func icon(toolName: String?) -> String {
        switch toolName {
        case "Edit": return "pencil"
        case "Write": return "square.and.pencil"
        default: return "terminal.fill"
        }
    }
```

Header uses `Self.icon(toolName:)` / `Self.title(toolName:)`. Body: when `state.approval.args` is non-nil render per tool, else keep today's `argsSummary` block verbatim (old servers):

- **Edit** (`args.oldString`/`args.newString` non-nil): the file path as a caption, then two monospaced blocks inside a `ScrollView` capped at `.frame(maxHeight: 220)`: the old string on `Color.red.opacity(0.12)` background prefixed by a "− removed" caption, the new string on `Color.green.opacity(0.12)` prefixed by "+ replacement". (Edit is an exact-string replacement, so old/new blocks ARE the diff — no line-level algorithm needed.)
- **Write** (`args.contentPreview` non-nil): the file path caption, then the preview in one monospaced block (same 220pt scroll cap), with a secondary caption "New file content · \(args.totalChars ?? 0) chars".
- **Bash** (`args.command` non-nil): the command in the existing monospaced style, `lineLimit(6)`.
- Any `args.truncated == true` appends a secondary caption "(preview truncated)".

- [ ] **Step 4: Build, test, and flag for visual verification**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests && GIT_CONFIG_GLOBAL=/dev/null swift test --filter ToolApprovalTests`
Expected: build + tests PASS. **UI note:** per repo policy, never ship unseen styles — the finished card must be visually confirmed in the running app (or a screenshot from the user) before the branch is declared done; record this as an open checklist item for the final report.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/ToolApprovalCard.swift mac/Tests/LlmIdeMacTests/ToolApprovalTests.swift
git commit -m "feat(mac): 承認カードに Edit/Write/Bash の diff・プレビュー表示を追加"
```

---

### Task 7: Mac — default the Agent engine on

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Chat/AgentV2Selection.swift` (`toggleEnabled`, ~line 56)
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/CodeAssistantSettingsSection.swift:9` (`= false` → `= true`, plus copy)
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift:145` (`= false` → `= true`)
- Test: `mac/Tests/LlmIdeMacTests/AgentV2SelectionTests.swift`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentV2Selection.toggleEnabled(defaults:)` returns `true` when the key was never set; an explicit `false` (user opt-out) is honored. `engineForNewChat` follows automatically.

- [ ] **Step 1: Write the failing tests**

Add to `AgentV2SelectionTests.swift` (follow the file's existing pattern of an isolated `UserDefaults(suiteName:)`):

```swift
@Test func toggleDefaultsOnWhenUnset() {
    let defaults = UserDefaults(suiteName: "v2-default-on-\(UUID().uuidString)")!
    #expect(AgentV2Selection.toggleEnabled(defaults: defaults) == true)
    #expect(AgentV2Selection.engineForNewChat(defaults: defaults) == AgentV2Selection.sessionEngineV2)
}

@Test func explicitOptOutIsHonored() {
    let defaults = UserDefaults(suiteName: "v2-opt-out-\(UUID().uuidString)")!
    defaults.set(false, forKey: AgentV2Selection.toggleKey)
    #expect(AgentV2Selection.toggleEnabled(defaults: defaults) == false)
    #expect(AgentV2Selection.engineForNewChat(defaults: defaults) == nil)
}
```

- [ ] **Step 2: Build/test to verify the first test fails**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests && GIT_CONFIG_GLOBAL=/dev/null swift test --filter AgentV2SelectionTests`
Expected: `toggleDefaultsOnWhenUnset` FAILS (unset currently reads false).

- [ ] **Step 3: Implement**

```swift
    /// Current toggle value. UNSET defaults to true (the Agent engine is the
    /// default for new chats since P3); an explicit user opt-out (false) is
    /// honored forever. Read at ENGINE-CREATION time and at TURN time.
    static func toggleEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: toggleKey) == nil ? true : defaults.bool(forKey: toggleKey)
    }
```

Flip both `@AppStorage(AgentV2Selection.toggleKey) ... = false` declarations to `= true`. Update the settings copy in `CodeAssistantSettingsSection.swift`: title "Agent engine" (drop "(beta)"), description "New chats use the Claude Agent engine (Anthropic provider only). Turn off to use the classic engine.", and adjust the hint's first sentence accordingly — leave the fallback sentence ("If the server hasn't been updated yet, turns automatically fall back.") intact.

- [ ] **Step 4: Build, test, and update any stale selection tests**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests && GIT_CONFIG_GLOBAL=/dev/null swift test --filter AgentV2SelectionTests`
Expected: PASS. If an existing test asserted "unset → false", update it to assert the new default (it documents the old contract this task deliberately changes).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/AgentV2Selection.swift mac/Sources/LlmIdeMac/Views/Settings/CodeAssistantSettingsSection.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift mac/Tests/LlmIdeMacTests/AgentV2SelectionTests.swift
git commit -m "feat(mac): Agent エンジンを新規チャットの既定に変更"
```

---

### Task 8: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Extension suite + lint**

Run: `cd extension && npm test` then `npm run lint`
Expected: only `tests/auth-routes.test.mjs` may fail under the sandbox — re-run it alone without the sandbox and confirm 48/48; lint exits clean.

- [ ] **Step 2: Mac build + tests**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build && GIT_CONFIG_GLOBAL=/dev/null swift test`
Expected: build PASS; tests PASS or no-op (machine limitation).

- [ ] **Step 3: Report the two open human checks**

The final report must call out: (1) the ToolApprovalCard needs visual confirmation in the running app before the work is declared shipped; (2) an end-to-end smoke on a real chat (new chat → ask for a small edit → approval card with diff → Apply → file changed) is the acceptance test for the whole branch.
