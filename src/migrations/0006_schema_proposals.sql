CREATE TABLE IF NOT EXISTS schema_proposals (
  id                 TEXT    PRIMARY KEY,
  target_layer       TEXT    NOT NULL CHECK(target_layer IN (
    'TLA_SPEC',
    'SQL_MIGRATION',
    'CAPABILITY_REGISTRY'
  )),
  proposed_diff      TEXT    NOT NULL,
  justification_hash TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK(status IN (
    'DRAFTED',
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'MERGING',
    'MERGED',
    'FAILED'
  )),
  created_at         INTEGER NOT NULL,
  resolved_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_schema_proposals_status
  ON schema_proposals(status);
