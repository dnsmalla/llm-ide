// Host API v1 compose helpers on the desktop host: attachment framing, the allowed modes and the model list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentsToFiles } from '../routes/host-api/compose.mjs';
import { selectAttachments } from '../core/prompt-framing.mjs';

test('attachmentsToFiles: the wire {name, text} becomes the engine {path, content}, and the engine keeps it', () => {
  const files = attachmentsToFiles([{ name: 'notes.md', text: 'hello' }]);
  assert.deepEqual(files, [{ path: 'notes.md', content: 'hello' }]);
  assert.deepEqual(selectAttachments(files).files, [{ path: 'notes.md', content: 'hello' }]);
});

test('attachmentsToFiles: absent or malformed entries yield nothing', () => {
  assert.deepEqual(attachmentsToFiles(undefined), []);
  assert.deepEqual(attachmentsToFiles([{ name: 'a' }, null, { text: 'x' }]), []);
});
