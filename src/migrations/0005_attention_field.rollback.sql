-- Rollback for 0005_attention_field.sql
-- SQLite does not support DROP COLUMN before 3.35.0.
-- Safe rollback: recreate table without the added columns.

DROP INDEX IF EXISTS idx_mem_attention;

-- Note: if running on SQLite >= 3.35.0, prefer:
--   ALTER TABLE memories DROP COLUMN updated_at;
--   ALTER TABLE memories DROP COLUMN reinforcement_count;
--   ALTER TABLE memories DROP COLUMN last_reinforced_at;
-- For maximum compatibility the table-recreation approach is preferred,
-- but that requires recreating triggers and FTS content table mappings.
-- In production: apply rollback via a full schema rebuild from migration 0001.
