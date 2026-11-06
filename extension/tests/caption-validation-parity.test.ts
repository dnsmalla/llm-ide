import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValidCaption, sanitizeSpeaker } from '../src/content/caption-validation.ts';
const cases = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tests/fixtures/captions/validation-cases.json', import.meta.url), 'utf8'));
test('shared fixture: sanitizeSpeaker answers', () => { for (const c of cases.sanitize) assert.equal(sanitizeSpeaker(c.in), c.out, JSON.stringify(c.in)); });
test('shared fixture: isValidCaption answers', () => { for (const c of cases.valid) assert.equal(isValidCaption(c.speaker, c.text), c.valid, JSON.stringify(c)); });
