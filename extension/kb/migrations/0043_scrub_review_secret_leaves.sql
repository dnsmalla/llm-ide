-- 0042 scrubbed only config.token / config.apiKey / config.pr.ghToken. The
-- server's SECRET_KEY_RE (server/review-secrets.mjs: token|apikey|api_key|
-- secret|password, case-insensitive) matches more keys (e.g. config.password,
-- pr.githubToken, config.api_key), so rows written before submit-time
-- stripping may still carry other credential-looking leaves under $.config
-- and $.pr. Rebuild each of those two objects without any matching key.
-- Idempotent: a row is only touched while a matching key remains.

UPDATE review_items
   SET payload = json_set(
         payload,
         '$.config',
         (SELECT json(json_group_object(
                   e.key,
                   CASE e.type
                     WHEN 'object' THEN json(e.value)
                     WHEN 'array'  THEN json(e.value)
                     WHEN 'true'   THEN json('true')
                     WHEN 'false'  THEN json('false')
                     ELSE e.value
                   END))
            FROM json_each(review_items.payload, '$.config') AS e
           WHERE NOT (e.key LIKE '%token%' OR e.key LIKE '%apikey%'
                   OR e.key LIKE '%api_key%' OR e.key LIKE '%secret%'
                   OR e.key LIKE '%password%')))
 WHERE json_valid(payload)
   AND json_type(payload, '$.config') = 'object'
   AND EXISTS (SELECT 1 FROM json_each(review_items.payload, '$.config') AS e
                WHERE e.key LIKE '%token%' OR e.key LIKE '%apikey%'
                   OR e.key LIKE '%api_key%' OR e.key LIKE '%secret%'
                   OR e.key LIKE '%password%');

UPDATE review_items
   SET payload = json_set(
         payload,
         '$.pr',
         (SELECT json(json_group_object(
                   e.key,
                   CASE e.type
                     WHEN 'object' THEN json(e.value)
                     WHEN 'array'  THEN json(e.value)
                     WHEN 'true'   THEN json('true')
                     WHEN 'false'  THEN json('false')
                     ELSE e.value
                   END))
            FROM json_each(review_items.payload, '$.pr') AS e
           WHERE NOT (e.key LIKE '%token%' OR e.key LIKE '%apikey%'
                   OR e.key LIKE '%api_key%' OR e.key LIKE '%secret%'
                   OR e.key LIKE '%password%')))
 WHERE json_valid(payload)
   AND json_type(payload, '$.pr') = 'object'
   AND EXISTS (SELECT 1 FROM json_each(review_items.payload, '$.pr') AS e
                WHERE e.key LIKE '%token%' OR e.key LIKE '%apikey%'
                   OR e.key LIKE '%api_key%' OR e.key LIKE '%secret%'
                   OR e.key LIKE '%password%');
