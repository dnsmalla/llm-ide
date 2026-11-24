-- Repair review_items.payload sections that 0043 double-encoded on SQLite >= 3.54.
--
-- 0043 rebuilt $.config and $.pr with json_set(payload, path, (SELECT json(...))).
-- Up to SQLite 3.53 the JSON subtype survived the scalar-subquery boundary, so
-- the rebuilt object was stored as an object. From SQLite 3.54 it does not: the
-- subquery result reaches json_set as plain TEXT and is stored as a JSON STRING
-- holding the object's text. Only an install that still had pre-0043 rows and
-- first ran 0043 on SQLite >= 3.54 is affected; secrets were removed either way.
-- 0043 itself is checksummed and stays unchanged; this migration fixes forward.
--
-- Each section is re-typed only when it is a JSON string whose content parses to
-- a JSON object. Objects, arrays, numbers, null, absent keys, non-JSON strings
-- and rows whose payload is not valid JSON are left alone, so it is idempotent.
-- json(...) around the extracted text restores the subtype in the same
-- expression (no subquery boundary), which is why it works on every version.
--
-- Data step (kb/migrations.mjs, JS_MIGRATIONS version 80): scrubReviewPayloadRows
-- runs right after this file. 0045's scrub skipped these sections while they were
-- strings, and 0043's key list is narrower than REVIEW_SECRET_KEY_RE (no auth /
-- credential / bearer), so a re-typed object may carry a key 0045 would have
-- removed. The scrub is idempotent and changes a row only when its re-serialised JSON differs.

UPDATE review_items
   SET payload = json_set(payload, '$.config', json(json_extract(payload, '$.config')))
 WHERE json_valid(payload)
   AND json_type(payload, '$.config') = 'text'
   AND json_valid(json_extract(payload, '$.config'))
   AND json_type(json_extract(payload, '$.config')) = 'object';

UPDATE review_items
   SET payload = json_set(payload, '$.pr', json(json_extract(payload, '$.pr')))
 WHERE json_valid(payload)
   AND json_type(payload, '$.pr') = 'text'
   AND json_valid(json_extract(payload, '$.pr'))
   AND json_type(json_extract(payload, '$.pr')) = 'object';
