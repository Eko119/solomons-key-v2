CREATE TABLE IF NOT EXISTS capability_registry (
  name        TEXT    PRIMARY KEY,
  description TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'ACTIVE'
                      CHECK(status IN ('ACTIVE', 'REVOKED')),
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_capability_registry_status
  ON capability_registry(status);
