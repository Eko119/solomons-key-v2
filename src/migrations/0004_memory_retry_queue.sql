-- MEM-1 step B: retry queue for failed memory extractions.
-- Gemini hiccups (rate-limit, timeout, schema-violation) used to silently
-- drop the turn. Now we persist the raw turn text + attribution here and a
-- background loop replays it with exponential backoff.
--
-- Schema extends the V2 spec with chat_id + agent_id so the retry can
-- reconstruct the same ingestConversation() call that originally failed.
-- Without those, the retry would not know which session the memory belongs
-- to, and the memory row would lose its agent attribution.

CREATE TABLE IF NOT EXISTS memory_retry_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        TEXT    NOT NULL,
  agent_id       TEXT    NOT NULL,
  content        TEXT    NOT NULL,
  content_hash   TEXT    NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  next_retry_at  INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_retry_due
  ON memory_retry_queue(next_retry_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_retry_hash
  ON memory_retry_queue(content_hash);
