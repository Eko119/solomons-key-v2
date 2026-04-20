-- DB-1: Bootstrap migration.
-- Creates the schema_version table used by the migration runner, and
-- replays every CREATE statement that previously lived inline in src/db.ts.
-- Every statement uses IF NOT EXISTS so this is safe on both a fresh DB
-- and a production DB that already contains these tables.

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  filename   TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  last_activity INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 1,
  token TEXT,
  UNIQUE(chat_id, agent_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  tokens_used INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_chat_agent ON conversations(chat_id, agent_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_text TEXT,
  entities TEXT DEFAULT '[]',
  topics TEXT DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  salience REAL NOT NULL DEFAULT 1.0,
  pinned INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT REFERENCES memories(id),
  consolidated INTEGER NOT NULL DEFAULT 0,
  embedding TEXT,
  created_at TEXT NOT NULL,
  last_accessed TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_mem_salience ON memories(agent_id, salience DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  summary, raw_text, entities, topics,
  content='memories', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
  VALUES (new.rowid, new.summary, new.raw_text, new.entities, new.topics);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
  VALUES('delete', old.rowid, old.summary, old.raw_text, old.entities, old.topics);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update
AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
  VALUES('delete', old.rowid, old.summary, old.raw_text, old.entities, old.topics);
  INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
  VALUES (new.rowid, new.summary, new.raw_text, new.entities, new.topics);
END;

CREATE TABLE IF NOT EXISTS consolidations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  insights TEXT NOT NULL,
  patterns TEXT DEFAULT '[]',
  contradictions TEXT DEFAULT '[]',
  memory_ids TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hive_mind (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT,
  artifacts TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hive_agent ON hive_mind(agent_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  chat_id INTEGER,
  agent_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run INTEGER,
  next_run INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  result TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mission_status ON mission_tasks(status, priority DESC);

CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  chat_id INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meet_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT 'main',
  meet_url TEXT NOT NULL,
  bot_name TEXT,
  voice_id TEXT,
  image_path TEXT,
  brief_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  platform TEXT,
  provider TEXT NOT NULL DEFAULT 'pika',
  created_at TEXT NOT NULL,
  ended_at TEXT
);
