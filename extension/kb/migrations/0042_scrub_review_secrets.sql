-- Review payloads used to store tracker / GitHub credentials verbatim
-- (config.token, config.apiKey, pr.ghToken). Submit now strips them and
-- approval resolves them from the per-user vault (server/review-secrets.mjs);
-- this one-time pass scrubs rows written before that change.
UPDATE review_items
   SET payload = json_remove(payload, '$.config.token', '$.config.apiKey', '$.pr.ghToken')
 WHERE json_valid(payload)
   AND (json_extract(payload, '$.config.token') IS NOT NULL
     OR json_extract(payload, '$.config.apiKey') IS NOT NULL
     OR json_extract(payload, '$.pr.ghToken') IS NOT NULL);
