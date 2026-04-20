-- Rollback for MEM-1 step B.
DROP INDEX IF EXISTS idx_memory_retry_hash;
DROP INDEX IF EXISTS idx_memory_retry_due;
DROP TABLE IF EXISTS memory_retry_queue;
