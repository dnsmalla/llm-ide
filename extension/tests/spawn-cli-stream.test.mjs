import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeStreamJSON } from '../agents/providers.mjs';

test('parseClaudeStreamJSON extracts text deltas from real Claude CLI NDJSON output', () => {
  const lines = [
    '{"type":"system","subtype":"init","session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-sonnet-5"}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello there"}},"session_id":"abc"}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", nice to meet you!"}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"message_stop"},"session_id":"abc"}',
    '{"is_error":false,"result":"Hello there, nice to meet you!","type":"result","subtype":"success"}',
  ];
  const deltas = [];
  let finalResult = null;
  for (const line of lines) {
    const parsed = parseClaudeStreamJSON(line);
    if (parsed.delta) deltas.push(parsed.delta);
    if (parsed.result !== undefined) finalResult = parsed.result;
  }
  assert.deepEqual(deltas, ['Hello there', ', nice to meet you!']);
  assert.equal(finalResult, 'Hello there, nice to meet you!');
});

test('parseClaudeStreamJSON ignores non-delta event types without throwing', () => {
  const lines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"rate_limit_event","rate_limit_info":{}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"whole message, not a delta"}]}}',
    'not even json',
    '',
  ];
  for (const line of lines) {
    const parsed = parseClaudeStreamJSON(line);
    assert.equal(parsed.delta, undefined);
    assert.equal(parsed.result, undefined);
  }
});

test('parseClaudeStreamJSON surfaces an error result', () => {
  const parsed = parseClaudeStreamJSON('{"type":"result","is_error":true,"result":"","subtype":"error_max_turns"}');
  assert.equal(parsed.isError, true);
});
