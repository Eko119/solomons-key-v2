-- 0008_outreach_queue.rollback.sql
DROP INDEX IF EXISTS idx_outreach_queue_client_status;
DROP TABLE IF EXISTS outreach_queue;
