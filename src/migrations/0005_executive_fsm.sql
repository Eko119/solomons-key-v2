-- Phase 11: Executive Function State Machine
-- All tables are idempotent (IF NOT EXISTS / IF NOT EXISTS on indexes).

CREATE TABLE IF NOT EXISTS task_graphs (
  id         TEXT    PRIMARY KEY,
  root_goal  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_nodes (
  id                 TEXT    PRIMARY KEY,
  graph_id           TEXT    NOT NULL  REFERENCES task_graphs(id),
  parent_id          TEXT    NULL      REFERENCES task_nodes(id),
  state              TEXT    NOT NULL  DEFAULT 'DRAFTED'
                              CHECK(state IN ('DRAFTED','PENDING','EXECUTING','VERIFYING','COMPLETED','FAILED','CANCELLED')),
  capability_required TEXT   NOT NULL,
  payload            TEXT    NOT NULL,
  priority           INTEGER NOT NULL  DEFAULT 5,
  attempt_count      INTEGER NOT NULL  DEFAULT 0,
  max_attempts       INTEGER NOT NULL  DEFAULT 3,
  lease_owner        TEXT    NULL,
  lease_expires_at   INTEGER NULL,
  effect_id          TEXT    NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  parent_task_id TEXT NOT NULL REFERENCES task_nodes(id),
  child_task_id  TEXT NOT NULL REFERENCES task_nodes(id),
  PRIMARY KEY (parent_task_id, child_task_id)
);

CREATE TABLE IF NOT EXISTS execution_receipts (
  id          TEXT    PRIMARY KEY,
  task_id     TEXT    NOT NULL REFERENCES task_nodes(id),
  attempt     INTEGER NOT NULL,
  effect_id   TEXT    NOT NULL UNIQUE,
  stdout_hash TEXT    NOT NULL,
  stderr_hash TEXT    NOT NULL,
  exit_code   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state_transitions (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL REFERENCES task_nodes(id),
  from_state TEXT    NOT NULL,
  to_state   TEXT    NOT NULL,
  timestamp  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  task_id          TEXT    PRIMARY KEY REFERENCES task_nodes(id),
  remaining_budget INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_nodes_graph  ON task_nodes(graph_id);
CREATE INDEX IF NOT EXISTS idx_task_nodes_state  ON task_nodes(state);
CREATE INDEX IF NOT EXISTS idx_task_nodes_parent ON task_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_child   ON task_dependencies(child_task_id);
CREATE INDEX IF NOT EXISTS idx_receipts_task     ON execution_receipts(task_id);
CREATE INDEX IF NOT EXISTS idx_transitions_task  ON state_transitions(task_id, timestamp);
