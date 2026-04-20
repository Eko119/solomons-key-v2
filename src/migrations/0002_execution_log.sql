-- DB-2: Scheduler execution tracking.
-- One row per attempted run of a scheduled job; unique on (job_id + ISO date).
-- The scheduler inserts a 'running' row before dispatch, then transitions
-- to 'completed' or 'failed' on outcome. Before inserting, the scheduler
-- checks whether a 'completed' row with the same idempotency_key exists;
-- if so it skips the run. This prevents double-execution across restarts.

CREATE TABLE IF NOT EXISTS execution_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL UNIQUE,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT    NOT NULL CHECK(status IN ('running','completed','failed')),
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_log_job
  ON execution_log(job_id, started_at DESC);
