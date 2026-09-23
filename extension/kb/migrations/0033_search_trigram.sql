-- Rebuild the `search` FTS5 index with the trigram tokenizer so Japanese /
-- Chinese / Korean text is searchable.
--
-- `unicode61` splits only on spaces and punctuation, and CJK has neither
-- between words: 「今日の会議で議事録を作成しました」 was indexed as ONE token,
-- so searching 議事録 (or any word inside a sentence) matched nothing. The
-- trigram tokenizer indexes every 3-character run, so any substring of 3+
-- characters matches in every script. Shorter terms (2-character words are
-- common in Japanese: 会議, 資料) cannot be a trigram MATCH; kb/db.mjs
-- turns those into a LIKE filter instead (buildSearchFilter).
--
-- Same columns as 0001, so every existing trigger keeps writing here
-- unchanged. Trigger bodies resolve `search` by name when they fire, so
-- dropping and recreating the table (rather than RENAME, which re-checks
-- every trigger that names the old table) is safe inside this transaction.
-- Existing rows are copied over, so nothing has to be re-ingested.

CREATE TEMP TABLE search_copy AS
  SELECT meeting_id, entity_id, kind, title, body FROM search;

DROP TABLE search;

CREATE VIRTUAL TABLE search USING fts5(
  meeting_id UNINDEXED,
  entity_id  UNINDEXED,
  kind       UNINDEXED,
  title,
  body,
  tokenize = 'trigram remove_diacritics 1'
);

INSERT INTO search (meeting_id, entity_id, kind, title, body)
  SELECT meeting_id, entity_id, kind, title, body FROM search_copy;

DROP TABLE search_copy;
