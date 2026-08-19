// End-to-end proof for C1: on v2 there is exactly ONE gate for an act tool,
// and the SDK-mounted tool path actually works.
//
// What shipped broken and why nothing caught it:
//
//  (a) `mcp__llmide__run-bash` was listed in engine.mjs's V2_ALLOWED_TOOLS.
//      Per the SDK's own sdk.d.ts, `allowedTools` is the list of "tool names
//      that are auto-allowed without prompting for permission ... without
//      asking the user for approval" — a name there NEVER reaches canUseTool.
//      So the gate every Task 7 test exercised was, in production, never
//      consulted for run-bash at all. (Empirically confirmed earlier on this
//      branch: at the pre-branch commit canUseTool blanket-denied everything
//      except AskUserQuestion, yet kb_search — an allowedTools entry — kept
//      working in production.)
//
//  (b) registry.mjs's run-bash `execute` independently re-ran the whole
//      gate+park dance using `ctx.loopCtx?.emit`. v2's toolCtx (sdk/tools.mjs)
//      has no `loopCtx` field at all, so a 'prompt'-tier command reaching the
//      mounted tool parked a SECOND decision on a channel with no emit and no
//      route back — a guaranteed 300 s hang, then a denial.
//
// Every existing v2 gating test called `script.options.canUseTool(...)`
// directly and never touched the mounted tool, so neither half was visible.
// This file closes that: it drives the REAL canUseTool AND the REAL mounted
// MCP server that runAgentV2Turn built — over a real InMemoryTransport
// client connection, the same pattern tests/agent-v2-tools.test.mjs uses —
// within one test, and asserts the two together park exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-act-e2e-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const { answerDecision } = await import('../llm_agent/sdk/decisions.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { tasks } = await import('../llm_agent/runtime/handlers/session-tasks.mjs');

const turnInjectable = {
  readSkill: () => null, roots: () => [],
  sessionMemory: () => [], persistMemory: async () => null,
};

// Captures the options runAgentV2Turn composed — including the REAL
// canUseTool closure and the REAL mounted llmide MCP server instance — then
// ends the stream immediately. Both survive the turn and stay live.
function capturingQuery(capture) {
  return (prompt, options) => {
    capture.prompt = prompt;
    capture.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: capture.sessionId, tools: [], capabilities: [] };
      yield { type: 'result', subtype: 'success', session_id: capture.sessionId };
    })();
  };
}

async function connectMounted(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'act-e2e', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  return client;
}

function withAnthropicKey(value, fn) {
  return async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = value;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  };
}

// `echo hello` is genuinely 'prompt'-tier (gates.mjs's AUTO_SAFE_PATTERNS
// covers git status/diff/log, ls, cat, grep/rg and test runners — not echo)
// and is harmless + instant to actually execute once approved.
const PROMPT_TIER_COMMAND = 'echo hello';

test('v2 run-bash: canUseTool is the SOLE gate — it parks once, and the mounted tool then runs without parking again',
  withAnthropicKey('sk-ant-act-e2e', async () => {
    const user = registerUser(getDb(), { email: 'act-e2e-1@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const capture = { sessionId: 'sdk-act-e2e-1' };
    const events = [];
    await runAgentV2Turn({
      message: 'run echo', userId: user.id, mode: 'execute',
      agentContext: { workspaceRoot: process.cwd(), sessionId: 'chat-1' },
      resumeSdkSessionId: capture.sessionId,
      onEvent: (e) => events.push(e),
      queryFactory: capturingQuery(capture),
    }, turnInjectable);

    // 1. The SDK will actually consult canUseTool for this tool: it is NOT
    //    pre-approved. (If it were, everything below would be dead code in
    //    production — exactly the shipped bug.)
    assert.ok(
      !capture.options.allowedTools.includes('mcp__llmide__run-bash'),
      'run-bash must not be in allowedTools, or the SDK auto-approves it and canUseTool never runs',
    );

    // 2. The REAL canUseTool parks a ToolApproval and genuinely blocks.
    const gate = capture.options.canUseTool('mcp__llmide__run-bash', { command: PROMPT_TIER_COMMAND }, {});
    let settled = false;
    gate.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'a prompt-tier command must block on a human, not optimistically allow');

    const reqs = events.filter((e) => e.type === 'approval_request');
    assert.equal(reqs.length, 1, 'exactly one approval parked');
    assert.equal(reqs[0].kind, 'ToolApproval');
    assert.equal(reqs[0].toolName, 'run-bash');

    // 3. A human answers it, and the gate allows.
    const ans = answerDecision({ requestId: reqs[0].requestId, sdkSessionId: capture.sessionId, userId: user.id, action: 'allow' });
    assert.equal(ans.ok, true, 'the parked decision must be answerable');
    const verdict = await gate;
    assert.equal(verdict.behavior, 'allow');

    // 4. THE PART THAT WAS NEVER TESTED: the SDK now invokes the mounted tool
    //    itself. Drive the real MCP server runAgentV2Turn built, over a real
    //    client connection. Before the fix, `execute` re-classified the
    //    command, re-parked, and hung 300 s on a channel with no emit; now it
    //    runs directly because v2's toolCtx carries no `loopCtx`.
    const client = await connectMounted(capture.options.mcpServers.llmide);
    try {
      const out = await client.callTool({ name: 'run-bash', arguments: { command: PROMPT_TIER_COMMAND } });
      assert.ok(!out.isError, `mounted run-bash call failed: ${JSON.stringify(out)}`);
      const parsed = JSON.parse(out.content[0].text);
      assert.ok(!parsed.error, `mounted run-bash returned an error: ${parsed.error}`);
      assert.equal(parsed.stdout.trim(), 'hello', 'the approved command actually executed');
    } finally {
      await client.close();
      await capture.options.mcpServers.llmide.instance.close();
    }

    // 5. No SECOND approval was parked by execute(). One invocation, one gate.
    assert.equal(
      events.filter((e) => e.type === 'approval_request').length, 1,
      'execute() must not re-park — canUseTool already gated this exact invocation',
    );
  }));

test('v2 run-bash: a blocked command is still refused by canUseTool before the tool is ever invoked',
  withAnthropicKey('sk-ant-act-e2e', async () => {
    const user = registerUser(getDb(), { email: 'act-e2e-2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const capture = { sessionId: 'sdk-act-e2e-2' };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute',
      agentContext: { workspaceRoot: process.cwd(), sessionId: 'chat-2' },
      resumeSdkSessionId: capture.sessionId,
      onEvent: (e) => events.push(e),
      queryFactory: capturingQuery(capture),
    }, turnInjectable);

    const verdict = await capture.options.canUseTool('mcp__llmide__run-bash', { command: 'sudo rm -rf /' }, {});
    assert.equal(verdict.behavior, 'deny');
    assert.match(verdict.message, /blocked/i);
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0, 'a blocked command never parks');
    await capture.options.mcpServers.llmide.instance.close();
  }));

// task-create / task-update are `gate: autoGate` — always 'auto'. They are no
// longer in allowedTools either (C1 removed ALL act tools), so they now take
// the canUseTool path for the first time. This pins both halves: canUseTool
// allows them immediately, and the mounted tool then really writes/reads the
// task row through the same toolCtx the engine built.
test('v2 task tools: not pre-approved, auto-allowed by canUseTool, and functional over the mounted server',
  withAnthropicKey('sk-ant-act-e2e', async () => {
    const user = registerUser(getDb(), { email: 'act-e2e-3@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    const capture = { sessionId: 'sdk-act-e2e-3' };
    const events = [];
    await runAgentV2Turn({
      message: 'm', userId: user.id, mode: 'execute',
      agentContext: { workspaceRoot: process.cwd(), chatSessionId: 'chat-3' },
      resumeSdkSessionId: capture.sessionId,
      onEvent: (e) => events.push(e),
      queryFactory: capturingQuery(capture),
    }, turnInjectable);

    for (const name of ['mcp__llmide__task-create', 'mcp__llmide__task-update']) {
      assert.ok(!capture.options.allowedTools.includes(name), `${name} must reach canUseTool, not be pre-approved`);
    }
    const created = await capture.options.canUseTool('mcp__llmide__task-create', { title: 'do the thing' }, {});
    assert.equal(created.behavior, 'allow', 'autoGate tools allow with no prompt');
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0, 'an auto-gated tool never parks');

    const client = await connectMounted(capture.options.mcpServers.llmide);
    try {
      const out = await client.callTool({ name: 'task-create', arguments: { title: 'do the thing' } });
      assert.ok(!out.isError, `task-create failed: ${JSON.stringify(out)}`);
      const task = JSON.parse(out.content[0].text);
      assert.ok(task.id, 'task-create returned a row');

      const upd = await client.callTool({ name: 'task-update', arguments: { taskId: task.id, status: 'completed' } });
      assert.ok(!upd.isError, `task-update failed: ${JSON.stringify(upd)}`);

      const listed = await client.callTool({ name: 'task-list', arguments: {} });
      const { tasks: rows } = JSON.parse(listed.content[0].text);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'completed');
      // Keyed under the STABLE chatSessionId, not the volatile agentContext
      // sessionId — sdk/tools.mjs resolves it the same way route.mjs does.
      assert.equal(tasks.listTasks(user.id, 'chat-3').length, 1);
    } finally {
      await client.close();
      await capture.options.mcpServers.llmide.instance.close();
    }
  }));

// I6: mode restriction must actually bite on v2, not just live in the persona
// prose. A restricted mode drops the act tools from allowedTools AND
// hard-disallows them (sdk.d.ts: disallowedTools removes a tool "from the
// model's context ... even if it would otherwise be allowed"), and canUseTool
// refuses them as a third line of defence.
test('v2 restricted modes cannot reach the act tools at all',
  withAnthropicKey('sk-ant-act-e2e', async () => {
    const user = registerUser(getDb(), { email: 'act-e2e-4@example.com', password: 'CorrectHorseBattery', displayName: 't' });
    for (const mode of ['plan', 'review', 'document']) {
      const capture = { sessionId: `sdk-act-e2e-4-${mode}` };
      await runAgentV2Turn({
        message: 'm', userId: user.id, mode,
        agentContext: { workspaceRoot: process.cwd(), sessionId: `chat-4-${mode}` },
        resumeSdkSessionId: capture.sessionId,
        onEvent: () => {},
        queryFactory: capturingQuery(capture),
      }, turnInjectable);

      for (const name of ['run-bash', 'task-create', 'task-update', 'task-list']) {
        const mcpName = `mcp__llmide__${name}`;
        assert.ok(!capture.options.allowedTools.includes(mcpName), `${mode}: ${mcpName} must not be auto-allowed`);
        assert.ok(capture.options.disallowedTools.includes(mcpName), `${mode}: ${mcpName} must be hard-disallowed`);
      }
      // Read tools the mode DOES permit are untouched.
      assert.ok(capture.options.allowedTools.includes('mcp__llmide__read-file'));
      assert.ok(!capture.options.disallowedTools.includes('mcp__llmide__read-file'));

      // Even reached directly, canUseTool refuses — an 'auto'-tier command
      // must not slip through just because the gate says it's safe.
      const verdict = await capture.options.canUseTool('mcp__llmide__run-bash', { command: 'git status' }, {});
      assert.equal(verdict.behavior, 'deny', `${mode}: run-bash must be denied even for an auto-safe command`);
      assert.match(verdict.message, new RegExp(`not available in ${mode} mode`));
      await capture.options.mcpServers.llmide.instance.close();
    }
  }));
