-- MEM-1 step A: content-hash dedup on memories.
-- The ingest pipeline computes SHA-256 of the raw turn text and stores it
-- here. A unique partial index (non-null only) lets old rows without a
-- hash coexist with new rows. Re-extraction of identical content becomes
-- a cheap DB lookup instead of a Gemini call + cosine pass.
--
-- Note: SQLite does not support `ADD COLUMN IF NOT EXISTS`; the migration
-- runner guarantees this statement runs exactly once per DB (gated by
-- schema_version), so a plain ALTER is safe.

ALTER TABLE memories ADD COLUMN content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash
  ON memories(content_hash)
  WHERE content_hash IS NOT NULL;
