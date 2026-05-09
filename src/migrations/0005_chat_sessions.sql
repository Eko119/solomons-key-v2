CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_id    INTEGER PRIMARY KEY,
  session_id TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
