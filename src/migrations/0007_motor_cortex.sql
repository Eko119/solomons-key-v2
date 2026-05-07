-- Phase 10: Motor Cortex — capability-bounded host execution layer.
-- All statements are idempotent; migration runner applies each file exactly once.

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                 TEXT    PRIMARY KEY,
  command            TEXT    NOT NULL,
  args_json          TEXT    NOT NULL DEFAULT '[]',
  cwd                TEXT    NOT NULL,
  env_json           TEXT    NOT NULL DEFAULT '{}',
  capabilities_json  TEXT    NOT NULL DEFAULT '[]',
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS command_registry (
  id                   TEXT    PRIMARY KEY,
  command              TEXT    NOT NULL,
  fixed_args_json      TEXT    NOT NULL DEFAULT '[]',
  args_schema_type     TEXT    NOT NULL DEFAULT 'none'
                                CHECK(args_schema_type IN ('none','any_strings','single_path','multi_path')),
  timeout_ms           INTEGER NOT NULL DEFAULT 30000,
  cwd                  TEXT    NOT NULL,
  env_allowlist_json   TEXT    NOT NULL DEFAULT '[]',
  required_capability  TEXT    NOT NULL,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_grants (
  id          TEXT    PRIMARY KEY,
  agent_id    TEXT    NOT NULL,
  capability  TEXT    NOT NULL,
  granted_at  INTEGER NOT NULL,
  granted_by  TEXT    NOT NULL,
  UNIQUE(agent_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_cap_grants_agent ON capability_grants(agent_id);

CREATE TABLE IF NOT EXISTS execution_receipts (
  id                   TEXT    PRIMARY KEY,
  timestamp            INTEGER NOT NULL,
  capability           TEXT    NOT NULL,
  command_id           TEXT    NOT NULL,
  normalized_args_json TEXT    NOT NULL,
  exit_code            INTEGER NOT NULL,
  duration_ms          INTEGER NOT NULL,
  stdout_hash          TEXT    NOT NULL,
  stderr_hash          TEXT    NOT NULL,
  truncated            INTEGER NOT NULL DEFAULT 0,
  timed_out            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_receipts_timestamp ON execution_receipts(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_command   ON execution_receipts(command_id);
