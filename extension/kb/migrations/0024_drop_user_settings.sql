-- user_settings (0021) backed a reverted cross-machine settings-sync feature.
-- The table was never read/written in production code — only deleted on
-- account purge. Drop it now that the feature is abandoned.

DROP TABLE IF EXISTS user_settings;
