-- 0008_outreach_queue.sql

CREATE TABLE IF NOT EXISTS outreach_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       TEXT    NOT NULL REFERENCES clients(id),
  lead_id         INTEGER NOT NULL REFERENCES leads(id),
  draft_message   TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','approved','sent','rejected')),
  approved_at     INTEGER,
  sent_at         INTEGER,
  rejected_at     INTEGER,
  rejection_note  TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outreach_queue_client_status
  ON outreach_queue(client_id, status);
