-- 0079: Self-Heal attempt history. A JSON array (at most 4 entries, oldest first) of what earlier fix runs tried and
-- why it did not hold: a failed run's verdict and the redacted tail of the failing `make regression`, an applied fix,
-- and a recurrence after it. The next BATCH.md shows it so the fix agent does not repeat a failed approach.
ALTER TABLE self_heal_incidents ADD COLUMN history TEXT;
