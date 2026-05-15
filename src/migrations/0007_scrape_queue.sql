-- 0007_scrape_queue.sql

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       TEXT    NOT NULL REFERENCES clients(id),
  platform        TEXT    NOT NULL,
  search_targets  TEXT    NOT NULL,
  max_leads       INTEGER NOT NULL DEFAULT 50,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','running','completed','failed')),
  started_at      INTEGER,
  completed_at    INTEGER,
  leads_found     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  idempotency_key TEXT    NOT NULL UNIQUE
);
