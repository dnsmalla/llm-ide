import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, checkPath } from '../connectors/sync-store/index.mjs';
import { runSyncStoreContract } from './helpers/sync-store-contract.mjs';

runSyncStoreContract(test, assert, async () => createMemoryStore(), 'memory');

test('checkPath returns segments', () => {
  assert.deepEqual(checkPath('a/b.bin'), ['a', 'b.bin']);
});
