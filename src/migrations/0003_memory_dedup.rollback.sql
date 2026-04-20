-- Rollback for MEM-1 step A.
DROP INDEX IF EXISTS idx_memories_content_hash;
ALTER TABLE memories DROP COLUMN content_hash;
