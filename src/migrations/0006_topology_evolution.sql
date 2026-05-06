-- Phase 9: Topology Evolution — three new tables.
-- All statements are idempotent; migration runner guarantees single application.

CREATE TABLE IF NOT EXISTS concept_nodes (
  id            TEXT    PRIMARY KEY,
  agent_id      TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  centroid      BLOB    NOT NULL,
  variance      REAL    NOT NULL DEFAULT 0.0,
  member_count  INTEGER NOT NULL DEFAULT 0,
  last_split_at INTEGER,
  last_fused_at INTEGER,
  tombstoned    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_concept_agent
  ON concept_nodes(agent_id, tombstoned);

CREATE INDEX IF NOT EXISTS idx_concept_split_candidates
  ON concept_nodes(variance DESC)
  WHERE tombstoned = 0;

CREATE TABLE IF NOT EXISTS concept_lineage (
  id          TEXT    PRIMARY KEY,
  parent_id   TEXT    REFERENCES concept_nodes(id),
  event_type  TEXT    NOT NULL CHECK(event_type IN ('root', 'split', 'fusion')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lineage_parent
  ON concept_lineage(parent_id);

CREATE TABLE IF NOT EXISTS concept_membership (
  memory_id   TEXT    NOT NULL PRIMARY KEY,
  concept_id  TEXT    NOT NULL REFERENCES concept_nodes(id),
  assigned_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_membership_concept
  ON concept_membership(concept_id);
