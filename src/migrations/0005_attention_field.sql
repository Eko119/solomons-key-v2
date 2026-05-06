-- Phase 8: Attention Field columns on memories table.
-- Adds reinforcement tracking and temporal decay support.
-- All ALTER TABLE statements are safe: migration runner applies each file exactly once.

ALTER TABLE memories ADD COLUMN updated_at INTEGER;
ALTER TABLE memories ADD COLUMN reinforcement_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN last_reinforced_at INTEGER;

-- Backfill last_reinforced_at from created_at (TEXT ISO → epoch ms).
-- For rows where created_at is a valid ISO string, parse with strftime.
-- Rows where the parse fails get the current epoch so decay starts now.
UPDATE memories
SET last_reinforced_at = COALESCE(
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
WHERE last_reinforced_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mem_attention
  ON memories(agent_id, last_reinforced_at DESC);
