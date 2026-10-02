// Content-word tokens for lightweight relevance scoring, in every script this
// team writes in.
//
// The previous rule was ASCII-only (`[a-z0-9][a-z0-9-]{2,}`), so a Japanese
// question produced no tokens at all and ranking silently degraded to
// newest-first. Japanese has no spaces, and ICU's word segmenter splits
// katakana loan words badly (トーク|ン, ビル|ド), so this uses script runs:
//   - ASCII: the old rule, unchanged — 3+ characters, lower-cased.
//   - Katakana: each run of 2+ characters is one token (トークン, ビルド).
//   - Kanji: a run of 2 characters is a token (認証); a longer run becomes
//     its overlapping bigrams (議事録 → 議事, 事録), so a compound still
//     matches its parts without a dictionary. A lone kanji (何, 方, 時) is
//     skipped: it is glue about as often as hiragana is, and every fact
//     sharing one would outrank newer, unrelated ones.
//   - Hiragana is skipped: in mixed text it is particles and okurigana, the
//     glue words a stopword list removes in English.

const TOKEN_RE = /([a-z0-9][a-z0-9-]{2,})|([\p{Script=Katakana}ー]{2,})|(\p{Script=Han}+)/gu;

/**
 * @param {unknown} text
 * @returns {string[]} tokens in order of appearance (duplicates kept).
 */
export function termTokens(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const [, ascii, katakana, han] = m;
    if (ascii) out.push(ascii);
    else if (katakana) out.push(katakana);
    else if (han.length === 1) continue;
    else if (han.length === 2) out.push(han);
    else for (let i = 0; i + 2 <= han.length; i += 1) out.push(han.slice(i, i + 2));
  }
  return out;
}
