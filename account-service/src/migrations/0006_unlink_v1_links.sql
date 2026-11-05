-- Device linking v1 is not trusted by the relay: clear every device linked under the old flow and every request/wrap
-- that could authorize one. A device must re-link through the signed approve/confirm flow.
DELETE FROM relay_wraps;
UPDATE link_requests SET state = 'unlinked', updated_at = strftime('%s','now') * 1000 WHERE state IN ('pending','approved','keys','linked');
UPDATE devices SET status = 'unlinked', updated_at = strftime('%s','now') * 1000 WHERE kind IN ('web','ios') AND status IN ('pending','linked');
