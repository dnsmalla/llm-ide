// Host API v1 compose helpers on the desktop host: attachment framing, the allowed modes and the model list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentsToFiles, isBinaryAttachment } from '../routes/host-api/compose.mjs';
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

import fs from 'node:fs';
import { COMPOSE_MODES, optionsOf, offersModel } from '../routes/host-api/compose.mjs';
import { auditOutcome } from '../routes/host-api/audit.mjs';
const vector = JSON.parse(fs.readFileSync(new URL('../../schema/host-api/v1/fixtures/security/compose.json', import.meta.url), 'utf8'));
test('COMPOSE_MODES is the shared vector: read-only modes only', () => { assert.deepEqual([...COMPOSE_MODES], vector.modes.allowed); for (const m of vector.modes.refused) assert.equal(COMPOSE_MODES.includes(m), false, m); });
test('optionsOf: the SDK list as {model, label}, ids checked, de-duplicated, at most 50', () => {
  const entries = [{ id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', effortLevels: [] }, { id: 'claude-sonnet-5-5', displayName: 'dup' }, { id: 'claude-opus-4-9[1m]', displayName: '' }, ...vector.models.refused.map((id) => ({ id, displayName: 'bad' })), ...Array.from({ length: 60 }, (_, i) => ({ id: `claude-x-${i}` }))];
  const r = optionsOf(entries); assert.deepEqual(r.modes, vector.modes.allowed); assert.deepEqual(r.models.slice(0, 2), [{ model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { model: 'claude-opus-4-9[1m]' }]); assert.equal(r.models.length, 50); assert.ok(r.models.every((m) => !vector.models.refused.includes(m.model))); assert.deepEqual(optionsOf(undefined), { modes: vector.modes.allowed, models: [] });
});
test('offersModel: only an id the list offers', () => { const e = [{ id: 'claude-sonnet-5-5' }]; assert.equal(offersModel(e, 'claude-sonnet-5-5'), true); assert.equal(offersModel(e, 'claude-opus-4-9'), false); assert.equal(offersModel([], 'claude-sonnet-5-5'), false); });
test('compose audit events are successes', () => { for (const e of ['chat_options', 'chat_new', 'compose_send']) assert.equal(auditOutcome(e), 'success', e); });

test('attachments: images are refused, as the shared vector says; binary framing never becomes an engine file', () => {
  assert.equal(vector.attachments.imagesAllowed, false);
  const image = { name: 'p.png', text: '[binary:image/png]\nAAAA' };
  assert.equal(isBinaryAttachment(image), true);
  assert.equal(isBinaryAttachment({ name: 'a.md', text: 'plain' }), false);
  assert.deepEqual(attachmentsToFiles([image, { name: 'a.md', text: 'plain' }]), [{ path: 'a.md', content: 'plain' }]);
});
