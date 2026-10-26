// Fake v2 engine for the token bench (scripts/token-bench.mjs --fake).
//
// Selected by routes/agent-v2.mjs runEngineTurn when LLMIDE_BENCH_FAKE=1 (and
// never under NODE_ENV=production). It answers a turn with the same contract as
// runAgentV2Turn — { usageTotals, composition } plus the SDK-shaped events the
// route forwards — but makes NO model call and does NOT import the Agent SDK.
//
// The numbers are synthetic and deterministic: a fixed "prefix" (system prompt
// and tool schemas) plus a transcript that grows by each turn's message and
// reply. They exercise the whole pipeline (SSE framing, ledger metering,
// turn-composition, cache reuse on resume) so the bench's plumbing and its
// regression comparison can be tested offline. They are NOT a measurement of
// the real engine.

import { randomUUID } from 'node:crypto';

// Synthetic prompt prefix, in tokens (system prompt + tool schemas).
const PREFIX_TOKENS = 9000;
// Synthetic per-session transcript, keyed by the SDK session id the fake
// hands out, so a resumed turn reads the earlier turns back as cache.
const transcripts = new Map();

const approxTokens = (text) => Math.ceil(String(text).length / 4);

/**
 * Stand-in for runAgentV2Turn. Accepts the same arguments the route passes.
 * @returns {Promise<{ result: object, usageTotals: object, composition: object }>}
 */
export async function runBenchFakeTurn({
  message = '', model, mode, resumeSdkSessionId, onEvent,
} = {}) {
  const resumed = Boolean(resumeSdkSessionId) && transcripts.has(resumeSdkSessionId);
  const sessionId = resumed ? resumeSdkSessionId : `bench-fake-${randomUUID()}`;
  const priorTranscript = resumed ? transcripts.get(sessionId) : 0;
  const resolvedModel = model || 'bench-fake';

  onEvent?.({
    type: 'init', sessionId, claudeCodeVersion: 'bench-fake', model: resolvedModel,
    tools: [], capabilities: [], mcpServers: [],
  });
  // A fixed-size reply per message: deterministic, and it grows with the prompt.
  const replyTokens = 20 + approxTokens(message) * 2;
  const reply = 'ok '.repeat(replyTokens);
  onEvent?.({ type: 'delta', text: reply });

  const newPromptTokens = approxTokens(message);
  // Fresh session: the whole prefix is written to the cache. Resumed: the
  // prefix and prior transcript are read back from cache; only the new
  // message is written.
  const cacheReadTokens = resumed ? PREFIX_TOKENS + priorTranscript : 0;
  const cacheCreationTokens = resumed ? newPromptTokens : PREFIX_TOKENS + newPromptTokens;
  const inputTokens = 3;
  transcripts.set(sessionId, priorTranscript + newPromptTokens + replyTokens);

  const usageTotals = {
    inputTokens,
    outputTokens: replyTokens,
    cacheReadTokens,
    cacheCreationTokens,
    byModel: [],
    turns: 1,
    stopReason: 'end_turn',
  };
  const composition = {
    mode,
    model: resolvedModel,
    resumed,
    systemPromptKind: 'bench-fake',
    systemChars: PREFIX_TOKENS * 4,
    promptChars: message.length,
    apiCalls: 1,
    firstCall: { inputTokens, cacheCreationTokens, cacheReadTokens },
    sdkContextTotalTokens: PREFIX_TOKENS + priorTranscript + newPromptTokens + replyTokens,
    sdkCategories: [
      { name: 'System prompt', kind: 'used', tokens: PREFIX_TOKENS },
      { name: 'Messages', kind: 'used', tokens: priorTranscript + newPromptTokens + replyTokens },
    ],
  };
  return {
    result: { subtype: 'success', result: reply, sessionId },
    usageTotals,
    composition,
  };
}

/** Tests only: forget the synthetic transcripts. */
export function __resetBenchFakeForTest() {
  transcripts.clear();
}
