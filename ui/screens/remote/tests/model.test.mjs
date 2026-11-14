import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteUrl } from '../model.ts';

test('host addresses become Host API websocket URLs', () => {
  assert.equal(normalizeRemoteUrl('llm-ide.com'), 'wss://llm-ide.com/host-api/v1');
  assert.equal(normalizeRemoteUrl('https://llm-ide.com'), 'wss://llm-ide.com/host-api/v1');
  assert.equal(normalizeRemoteUrl('wss://host:3016/host-api/v1'), 'wss://host:3016/host-api/v1');
  assert.throws(() => normalizeRemoteUrl('  '), /address/);
});
