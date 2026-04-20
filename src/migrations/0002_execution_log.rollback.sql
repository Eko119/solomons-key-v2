-- DB-2 rollback.
-- Destroys scheduler execution history. Safe only if you are intentionally
-- discarding audit trail; there is no recovery path.

DROP INDEX IF EXISTS idx_execution_log_job;
DROP TABLE IF EXISTS execution_log;
