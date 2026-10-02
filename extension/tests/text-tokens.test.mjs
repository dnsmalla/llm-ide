// The memory ranker's tokenizer only ever matched [a-z0-9]: a Japanese
// question produced ZERO tokens, so relevance ranking silently fell back to
// newest-first for this (Japanese-speaking) team. termTokens adds the scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termTokens } from '../core/text-tokens.mjs';

test('ASCII words keep the existing rule (3+ chars, lower-cased, hyphens kept)', () => {
  assert.deepEqual(termTokens('Use PNPM for the build-cache, ok?'), ['use', 'pnpm', 'for', 'the', 'build-cache']);
});

test('a katakana run is one token, however the word segmenter would split it', () => {
  assert.deepEqual(termTokens('トークン'), ['トークン']);
  assert.deepEqual(termTokens('ビルド'), ['ビルド']);
});

test('a kanji run of 1–2 characters is a token; a longer run becomes its bigrams', () => {
  assert.deepEqual(termTokens('認証'), ['認証']);
  assert.deepEqual(termTokens('議事録'), ['議事', '事録']);
});

test('hiragana (particles, okurigana) is not a token', () => {
  assert.deepEqual(termTokens('認証トークンの更新について'), ['認証', 'トークン', '更新']);
});

test('mixed scripts in one string', () => {
  assert.deepEqual(termTokens('pnpmのビルドが失敗する'), ['pnpm', 'ビルド', '失敗']);
});

test('non-strings yield no tokens', () => {
  assert.deepEqual(termTokens(undefined), []);
});
